import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile, JqError, run } from "./.build/jq.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

/** A value as text, with object keys sorted: JavaScript lists integer-like keys first, jq doesn't. */
const canon = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : typeof x === "number" && !Number.isFinite(x)
        ? String(x)
        : x,
  );

test("the recorded cases give what jq 1.7 gave", () => {
  // jq-cases.json is written by fixtures/jq-cases.gen.mjs from the real jq.
  const cases = read("jq-cases.json");
  // Where this implementation knowingly differs, with the reason for each.
  const known = new Set(read("jq-known-differences.json").map((k) => canon([k.program, k.input])));
  assert.ok(cases.length > 900);
  assert.ok(known.size < 20);
  const wrong = [];
  for (const c of cases) {
    if (known.has(canon([c.program, c.input]))) continue;
    let got;
    let failed = null;
    try {
      got = run(c.program, c.input, { vars: c.vars });
    } catch (e) {
      failed = e;
    }
    if (c.error) {
      if (!(failed instanceof JqError))
        wrong.push(`${c.program}: jq fails, this gave ${canon(got)}`);
    } else if (failed) wrong.push(`${c.program}: ${failed.message}`);
    else if (canon(got) !== canon(c.outputs)) {
      wrong.push(`${c.program}: got ${canon(got)}, jq gives ${canon(c.outputs)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("a program is checked when it is compiled", () => {
  assert.throws(() => compile("nosuchfn(1)"), /nosuchfn\/1 is not defined/);
  assert.throws(() => compile("input"), /not supported in Encela's jq subset: input/);
  assert.throws(
    () => compile(".a | | .b"),
    (e) => e instanceof JqError && e.position === 5,
  );
  assert.throws(() => run("$nope", null), /\$nope is not defined/);
  // 5000 nested parentheses must be a JqError, not a stack overflow.
  assert.throws(() => compile(`${"(".repeat(5000)}1${")".repeat(5000)}`), JqError);
});

test("it says which variables and which of their fields a program reads", () => {
  const p = compile(
    '$steps.pack.text, $steps["a"].b, $steps[$x].y, $inputs.n, . as $steps | $steps.q, {$item}',
  );
  assert.deepEqual(p.freeVars, ["inputs", "item", "steps", "x"]);
  const refs = p.refs.map((r) => r.join("."));
  for (const r of ["steps.pack.text", "steps.a.b", "steps", "inputs.n", "x", "item"]) {
    assert.ok(refs.includes(r), r);
  }
  assert.ok(!refs.includes("steps.q"));
  assert.deepEqual(compile("[.[] | select(.id == $inputs.id)]").refs, [["inputs", "id"]]);
});

test("it reaches nothing outside and leaves prototypes alone", () => {
  assert.deepEqual(run('[$ENV, env, ($ENV.PATH // "none")]', null), [[{}, {}, "none"]]);
  assert.deepEqual(run("[.__proto__, .constructor, .toString, .hasOwnProperty]", {}), [
    [null, null, null, null],
  ]);
  const out = run(
    '{"__proto__": {"polluted": 1}} | .__proto__.polluted, ({} | .["__proto__"] = {"x": 1} | keys), ([{"key":"__proto__","value":{"y":2}}] | from_entries | keys), ({} | setpath(["__proto__","z"]; 3) | keys), ({"a":1} * {"__proto__": {"w": 1}} | keys)',
    null,
  );
  assert.deepEqual(out, [1, ["__proto__"], ["__proto__"], ["__proto__"], ["__proto__", "a"]]);
  for (const key of ["polluted", "x", "y", "z", "w"]) assert.equal({}[key], undefined);
  // What it gives back is plain data.
  assert.equal(Object.getPrototypeOf(run("{a: 1}", null)[0]), Object.prototype);
});

test("every way of running forever is stopped", () => {
  assert.throws(() => run("range(1e12) | select(false)", null), /evaluation steps/);
  assert.throws(() => run("repeat(.)", 1), /outputs/);
  assert.throws(() => run("def f: f; f", null), JqError);
  assert.throws(() => run("def f: 1 + f; f", null), JqError);
  assert.throws(() => run('"x" * 1e9 | length', null), /string grew past/);
  assert.throws(
    () => run("[range(100000)] | length", null, { maxOps: 1000 }),
    /1000 evaluation steps/,
  );
  // Lazily evaluated: these finish at once.
  assert.deepEqual(run("first(range(1e12))", null), [0]);
  assert.deepEqual(run("[limit(3; repeat(1))]", null), [[1, 1, 1]]);
});

test("the input is never changed, and ordinary work is fast", () => {
  const frozen = Object.freeze({ a: Object.freeze([3, 1, 2]), b: Object.freeze({ c: 1 }) });
  assert.deepEqual(run(".a |= sort | .b.c = 2 | del(.a[0]) | .a", frozen), [[2, 3]]);
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ n: i % 10 }));
  let started = performance.now();
  assert.deepEqual(run("map(select(.n > 5)) | length", rows), [80_000]);
  assert.ok(performance.now() - started < 2000);
  const text = "id: 1234 name: foo\n".repeat(250_000);
  started = performance.now();
  assert.deepEqual(run('[scan("id: ([0-9]+)")] | length', text), [250_000]);
  assert.ok(performance.now() - started < 2000);
});

test("what pipelines lean on", () => {
  assert.deepEqual(run('capture("id: (?<id>[0-9]+)") | .id | tonumber', "x id: 42 y"), [42]);
  assert.deepEqual(
    run('sub("^```json\\n"; "") | sub("\\n```$"; "") | fromjson | .a', '```json\n{"a": 7}\n```'),
    [7],
  );
  assert.deepEqual(
    run("group_by(.k) | map({k: .[0].k, n: length}) | sort_by(-.n)", [
      { k: "a" },
      { k: "b" },
      { k: "a" },
    ]),
    [
      [
        { k: "a", n: 2 },
        { k: "b", n: 1 },
      ],
    ],
  );
  assert.deepEqual(run(".items[] |= (.n += 1) | [.items[].n]", { items: [{ n: 1 }, { n: 2 }] }), [
    [2, 3],
  ]);
  assert.deepEqual(run("map([.a, .b]) | .[] | @csv", [{ a: 1, b: "x,y" }]), ['1,"x,y"']);
  assert.deepEqual(run('"ab" * 3', null), ["ababab"]);
  assert.throws(
    () => run('error("the tool skipped everything")', null),
    (e) => e instanceof JqError && e.value === "the tool skipped everything",
  );
});
