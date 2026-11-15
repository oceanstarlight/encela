import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile, JqError, run } from "./.build/jq.js";
import { Sandbox } from "./.build/lib.js";

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

// Where this implementation knowingly differs, with the reason for each.
const known = new Set(read("jq-known-differences.json").map((k) => canon([k.program, k.input])));

/** The recorded cases that don't give what jq gave. */
function wrongIn(cases) {
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
  return wrong;
}

test("the recorded cases give what jq 1.7 gave", () => {
  // jq-cases.json is written by fixtures/jq-cases.gen.mjs from the real jq.
  const cases = read("jq-cases.json");
  assert.ok(cases.length > 900);
  assert.ok(known.size < 20);
  assert.deepEqual(wrongIn(cases), []);
});

test("the review's cases give what jq 1.7 gave: ?//, strptime, path expressions", () => {
  // jq-review-cases.json is written by fixtures/jq-review-cases.gen.mjs from the real jq.
  const cases = read("jq-review-cases.json");
  assert.ok(cases.length > 700);
  assert.deepEqual(wrongIn(cases), []);
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

// --- What the review found (jq-1 to jq-7) ------------------------------------

/** How long `f` takes, in ms. */
const timed = (f) => {
  const started = performance.now();
  f();
  return performance.now() - started;
};

test("jq-1: outputs are counted in full, shared parts included", async () => {
  // One string held 25 times costs the program nothing, but 25 MB once written out.
  const shared = (n) => `("a" * 1000000) as $s | [range(${n}) | $s]`;
  assert.throws(() => run(shared(25), null), /the output is too large: written out/);
  assert.throws(() => run(`${shared(1)} | [., ., .]`, null, { maxString: 2_000_000 }), /too large/);
  assert.equal(run(shared(15), null)[0].length, 15);
  const sandbox = new Sandbox();
  try {
    const started = performance.now();
    await assert.rejects(sandbox.run(shared(2500), null, {}), /the output is too large/);
    assert.ok(performance.now() - started < 5000);
    assert.deepEqual(await sandbox.run(". + 1", 1, {}), [2]);
    // The outputs come across as text, and what JSON can't hold comes back as it was.
    const [values] = await sandbox.run(
      '[nan, infinite, -infinite, -0, 0, 1.5, "\\u0000nan", "\\u0000", {"\\u0000k": nan}, "x"]',
      null,
      {},
    );
    assert.ok(Number.isNaN(values[0]));
    assert.equal(values[1], Number.POSITIVE_INFINITY);
    assert.equal(values[2], Number.NEGATIVE_INFINITY);
    assert.ok(Object.is(values[3], -0));
    assert.ok(Object.is(values[4], 0));
    assert.deepEqual(values.slice(5, 8), [1.5, "\u0000nan", "\u0000"]);
    assert.ok(Number.isNaN(values[8]["\u0000k"]));
    assert.equal(values[9], "x");
    assert.deepEqual(await sandbox.run("[1, 2] as $a | {a: $a, b: $a}", null, {}), [
      { a: [1, 2], b: [1, 2] },
    ]);
  } finally {
    sandbox.close();
  }
});

test("jq-2: compiling is linear in the length of the program, which is capped", () => {
  // A long chain of postfix operators used to be walked again from each of its links.
  const long = [
    `.${"[]?".repeat(33_333)}`,
    `.${"[0]".repeat(33_333)}`,
    `${"$__loc__\n,".repeat(9999)}1`,
  ];
  for (const p of long) {
    const ms = timed(() => assert.throws(() => compile(p), JqError));
    assert.ok(ms < 1500, `${ms} ms for ${p.length} characters`);
  }
  assert.throws(
    () => compile(`.${"[]?".repeat(400_000)}`),
    /the program is 1200001 characters long; at most 100000 are read/,
  );
  assert.deepEqual(compile(`$x${".a".repeat(100)}`).refs, [["x", ...Array(100).fill("a")]]);
});

test("jq-3: an output nested too deeply is refused, and the sandbox goes on", async () => {
  assert.throws(
    () => run("reduce range(6000) as $i (0; [.])", null),
    /the output is too large: it is nested more than 2000 levels deep/,
  );
  assert.equal(run("reduce range(2000) as $i (0; [.]) | tojson | length", null)[0], 4001);
  const sandbox = new Sandbox();
  try {
    const started = performance.now();
    await assert.rejects(
      sandbox.run("reduce range(6000) as $i (0; [.])", null, {}),
      /nested more than 2000 levels deep/,
    );
    assert.ok(performance.now() - started < 5000);
    // 2000 levels come across.
    let [deep] = await sandbox.run("reduce range(1999) as $i (0; [.])", null, {});
    let depth = 0;
    while (Array.isArray(deep)) {
      deep = deep[0];
      depth++;
    }
    assert.equal(depth, 1999);
    // An input too deep to pass to the worker is refused at once.
    let input = 0;
    for (let i = 0; i < 200_000; i++) input = [input];
    await assert.rejects(sandbox.run("1", input, {}));
    assert.deepEqual(await sandbox.run("1", null, {}), [1]);
  } finally {
    sandbox.close();
  }
});

test("jq-4: builtins are charged for the size of what they work on", () => {
  const s = '("a" * 1000000) as $s';
  const costly = [
    '("a" * 100000) as $s | ($s * 10) | index($s)',
    '("a" * 100000) as $s | ($s * 10) | rindex($s)',
    "[range(100000) | 0] as $a | ($a + $a) | indices($a[:50000]) | length",
    `${s} | [range(100000) | $s | ltrimstr($s) | length] | add`,
    `${s} | [range(100000) | $s | rtrimstr($s) | length] | add`,
    `${s} | [range(100000) | $s | startswith($s)] | length`,
    `${s} | [range(100000) | $s | endswith($s)] | length`,
    `${s} | [range(20000) | $s | inside($s)] | length`,
    `${s} | [range(2000) | $s | @base64 | length] | add`,
    `${s} | ($s + "b") as $t | ($s + "b") as $u | [range(100000) | $t == $u] | length`,
    `${s} | ($s + "b") as $t | ($s + "c") as $u | [range(100000) | [$t, $u] | sort] | length`,
    "[range(1000000)] as $a | [range(1000) | $a | implode | length] | add",
    '(" " * 1000000) as $s | [range(20000) | $s | trim | length] | add',
    '("😀" * 500000) as $s | [range(20000) | $s | length] | add',
    '("😀" * 500000) as $s | [range(20000) | $s | .[5:7]] | length',
    "[range(100000)] as $a | [range(100000)] as $b | [range(20000) | $a == $b] | length",
    "[range(100000)] as $p | [range(2000) | [$p, ($p + [])] | sort | length] | add",
    "[range(100000) | {(tostring): 1}] | add as $o | [range(50) | $o | keys | length] | add",
  ];
  for (const p of costly) {
    const ms = timed(() => assert.throws(() => run(p, null), /evaluation steps \(maxOps\)/, p));
    assert.ok(ms < 4000, `${ms} ms: ${p}`);
  }
  // Ordinary work on large values still fits.
  assert.deepEqual(run(`${s} | [$s | index("b"), length, startswith("aa"), (. == $s)]`, null), [
    [null, 1000000, true, true],
  ]);
  assert.deepEqual(run("[range(100000) | tostring] | sort | length", null), [100000]);
});

test("jq-4: the time limit's message names more than regular expressions", async () => {
  const sandbox = new Sandbox();
  try {
    await assert.rejects(
      sandbox.run('test("^(a+)+$")', `${"a".repeat(40)}b`, {}, 300),
      (e) =>
        /took longer than 0\.3 s and was stopped/.test(e.message) &&
        /work on very large values/.test(e.message),
    );
  } finally {
    sandbox.close();
  }
});

test("jq-5: destructuring alternatives ?//", () => {
  assert.deepEqual(run("[.[] as [$a] ?// $a | $a]", [[1], 2]), [[1, 2]]);
  // Every variable is bound; null where the pattern that matched has none.
  assert.deepEqual(run("[.[] as [$a] ?// {b: $b} ?// $c | [$a, $b, $c]]", [[1], { b: 2 }, 3]), [
    [
      [1, null, null],
      [null, 2, null],
      [null, null, 3],
    ],
  ]);
  // An error in the body moves on to the next pattern; the last one's is raised.
  assert.deepEqual(
    run('[.[] as [$a] ?// $b | if $a == 1 then error("x") else [$a, $b] end]', [[1], [2]]),
    [
      [
        [null, [1]],
        [2, null],
      ],
    ],
  );
  assert.throws(() => run('. as [$a] ?// $a | error("last")', [1]), /last/);
  assert.deepEqual(run("reduce .[] as [$a] ?// $a (0; . + $a)", [[1], 2, [3]]), [6]);
  assert.deepEqual(run("[foreach .[] as {a: $a} ?// $a (0; . + $a)]", [{ a: 1 }, 2]), [[1, 3]]);
});

test("jq-6: strptime, in UTC", () => {
  assert.deepEqual(run('strptime("%Y-%m-%d")', "2024-03-05"), [[2024, 2, 5, 0, 0, 0, 2, 64]]);
  assert.deepEqual(run('strptime("%Y-%m-%d") | mktime', "2024-03-05"), [1709596800]);
  // The offset is read and not used, as in jq.
  assert.deepEqual(
    run('strptime("%a, %d %b %Y %T %z") | mktime', "Tue, 05 Mar 2024 10:00:00 +0100"),
    [1709632800],
  );
  assert.deepEqual(run('strptime("%Y-%m-%d")', "2024-03-05 "), [[2024, 2, 5, 0, 0, 0, 2, 64, " "]]);
  assert.throws(() => run('strptime("%Y-%m-%d")', "2024-03-05x"), /does not match format/);
  assert.throws(() => run('strptime("%U")', "5"), /%U is not supported/);
  // These read the time zone, and stay out.
  assert.throws(() => compile("localtime"), /not supported in Encela's jq subset: localtime/);
  assert.throws(() => compile('strflocaltime("%H")'), /not supported in Encela's jq subset/);
});

test("jq-7: assignments, reduce and foreach in path expressions, as in jq 1.7", () => {
  assert.deepEqual(run('try [path(.[] |= .)] catch "ERR"', [1, 2]), ["ERR"]);
  assert.throws(
    () => run("[path(reduce .[] as $x (.; .a))]", { a: { a: { a: 1 } } }),
    /Invalid path expression/,
  );
  assert.deepEqual(run("1 as $x | [path(.a //= .a)]?", { a: 1 }), []);
  // What jq 1.7 does allow.
  assert.deepEqual(run("[path(reduce empty as $x (.a; .))]", { a: 1 }), [[["a"]]]);
  assert.deepEqual(run("[path(foreach (1, 2) as $x (.; .; .a))]", { a: 1 }), [[["a"], ["a"]]]);
  assert.deepEqual(run("[path(foreach .[] as $x (0; . + 1; $x))]", [5, 6]), [[[0], [1]]]);
  assert.deepEqual(run("[path(. as [$a] | $a)]", [1, 2]), [[[0]]]);
  assert.deepEqual(run("[paths(reduce 1 as $x (.; .))]", { a: 1 }), [[["a"]]]);
  assert.deepEqual(run("del(empty = 1), [path(.[] = 1)]", []), [null, [[]]]);
  // Outside path expressions nothing changed.
  assert.deepEqual(run(".[] |= . + 1 | reduce .[] as $x (.; .)", [1, 2]), [[2, 3]]);
});
