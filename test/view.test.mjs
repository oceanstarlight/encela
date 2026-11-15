// The view inside Claude Code: what it shows (plugin/hooks/model.ts, worked
// out apart from Claude Code) and the file the server keeps for it. The
// drawing itself is checked by Claude Code: `pnpm check:view`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Blueprints, briefs, Registry, Server, ToolCache, writePlugin } from "./.build/lib.js";
import {
  began,
  cells,
  doing,
  encelaTool,
  ended,
  fit,
  frame,
  look,
  meet,
  moving,
  paint,
  parse,
  seen,
  TICK,
  tickOn,
  workerOf,
} from "./.build/view.js";

const here = dirname(fileURLToPath(import.meta.url));
const temp = (name) => mkdtempSync(join(tmpdir(), `encela-${name}-`));

const step = (id, title, status, worker = "main", pipeline = "") => ({
  id,
  title,
  status,
  worker,
  pipeline,
});
const piece = (name, kind, more = {}) => ({
  id: `${kind}:${name}`,
  name,
  kind,
  running: false,
  busy: 0,
  calls: 0,
  last: "",
  lastAt: 0,
  ...more,
});
const state = (more = {}) => ({
  v: 1,
  at: 1000,
  lang: "ko",
  phase: "build",
  blueprint: {
    id: "todo",
    goal: "할 일 앱 만들기",
    status: "assembled",
    approval: "direct",
    steps: [
      step("model", "데이터 모델", "done", "backend"),
      step("api", "API 구현", "doing", "backend"),
      step("ui", "화면 구현", "doing", "frontend"),
      step("test", "테스트", "todo"),
    ],
    workers: ["backend", "frontend"],
  },
  pieces: [
    piece("playwright", "mcp", { running: true, calls: 12, last: "browser_click" }),
    piece("context7", "mcp"),
    piece("tdd", "skill"),
    piece("ripgrep", "cli"),
  ],
  runs: [],
  events: [
    { at: 900, kind: "assembled", what: "todo", how: "4" },
    { at: 950, kind: "step", what: "API 구현", how: "doing" },
  ],
  ...more,
});
const agent = (id, more = {}) => ({ id, worker: "", about: "", doing: "", done: false, ...more });
const opts = (more = {}) => ({ rows: 40, columns: 60, now: 2000, ...more });
/** A frame's lines as plain text, the right side after a tab. */
const shown = (view) =>
  view.lines.map(
    (l) =>
      `${" ".repeat(l.indent ?? 0)}${l.left.map((s) => s.text).join("")}${
        l.bar ? ` [${l.bar.done}/${l.bar.total}]` : ""
      }${l.right ? `\t${l.right.map((s) => s.text).join("")}` : ""}`,
  );
const band = (view) => view.band.map((s) => s.text).join("");

test("the frame: the flow, the steps with who does them, the pieces, what happened", () => {
  const view = frame(
    state(),
    [
      agent("main", { doing: "blueprint_step api" }),
      agent("a1", { worker: "backend", about: "API", doing: "Edit routes.ts" }),
      agent("a2", { worker: "frontend", about: "UI", doing: "playwright · browser_click" }),
    ],
    opts(),
  );
  assert.deepEqual(shown(view), [
    "할 일 앱 만들기",
    "✓ 부품 › ✓ 설계도 › ✓ 승인 › ✓ 조립 › ● 만들기",
    "",
    "단계 [1/4]",
    " ✓ 데이터 모델\tbackend",
    " ● API 구현\tbackend",
    "   └ Edit routes.ts",
    " ● 화면 구현\tfrontend",
    "   └ playwright · browser_click",
    " ○ 테스트",
    "",
    "부품",
    " ● playwright\tbrowser_click · 12회",
    " ○ context7",
    " + 문서 1 · 도구 안내 1",
    "",
    "최근",
    " API 구현: 시작",
    " 조립 완료 (부품 4개)",
  ]);
  assert.equal(band(view), "Encela ▸ ● 만들기 1/4 · 작업자 2");
  // With no one at work the marker is left out: nothing claims to be going on.
  assert.equal(band(frame(state(), [], opts())), "Encela ▸ 만들기 1/4");
  // The tones carry the look: done is good, in progress is busy.
  const api = view.lines.find((l) => l.left.some((s) => s.text.includes("API 구현")));
  assert.deepEqual(
    api.left.map((s) => s.tone),
    ["busy", "plain"],
  );
});

test("the frame: before anything, while pieces are looked for, at the question, when done", () => {
  assert.match(shown(frame(null, [], opts()))[0], /Nothing is being built/);
  assert.equal(band(frame(null, [], opts())), "");
  assert.match(shown(frame(null, [], opts({ lang: "ko" })))[0], /지금 만드는 것이 없어요/);
  // An Encela tool was called, but a project without `.encela` has no file yet.
  const looking = frame(null, [], opts({ lang: "ko", started: true }));
  assert.deepEqual(shown(looking), [
    "● 부품 › ○ 설계도 › ○ 승인 › ○ 조립 › ○ 만들기",
    "부품을 찾는 중",
  ]);
  assert.equal(band(looking), "Encela ▸ 부품을 찾는 중");
  // The server's language wins once it is known.
  assert.match(band(frame(state({ lang: "en" }), [], opts({ lang: "ko" }))), /build 1\/4/);

  const asking = frame(state({ phase: "approval" }), [], opts());
  assert.equal(band(asking), "Encela ▸ 승인을 기다리는 중");
  assert.equal(asking.band[1].tone, "wait");
  assert.match(shown(asking)[1], /✓ 설계도 › ● 승인 › ○ 조립/);

  const relayed = state();
  relayed.blueprint.approval = "relayed";
  assert.match(band(frame(relayed, [], opts())), /Claude를 통해 승인$/);

  const done = state({ phase: "done", at: 1000 });
  for (const s of done.blueprint.steps) s.status = "done";
  assert.equal(band(frame(done, [], opts({ now: 60_000 }))), "Encela ▸ 완료 4/4");
  assert.match(shown(frame(done, [], opts()))[1], /✓ 조립 › ✓ 만들기$/);
  // A finished build leaves the line above the prompt after a while.
  assert.equal(band(frame(done, [], opts({ now: 1000 + 121_000 }))), "");
});

test("the frame: pipeline runs, a step a pipeline does, a subagent no step names", () => {
  const live = state({
    runs: [
      {
        id: "r-1",
        pipeline: "exports",
        status: "waiting",
        steps: [
          { id: "pack", kind: "tool", state: "done", items: 0, itemsDone: 0 },
          { id: "grep", kind: "tool", state: "skipped", items: 0, itemsDone: 0 },
          { id: "names", kind: "tool", state: "running", items: 8, itemsDone: 3 },
          { id: "pick", kind: "claude", state: "waiting", items: 0, itemsDone: 0 },
          { id: "save", kind: "tool", state: "todo", items: 0, itemsDone: 0 },
        ],
      },
    ],
  });
  live.blueprint.steps[1].pipeline = "exports";
  const view = frame(live, [agent("a9", { about: "review the diff", doing: "Read a.ts" })], opts());
  const lines = shown(view);
  assert.ok(lines.includes("   └ exports 2/5"));
  assert.ok(lines.includes("파이프라인 exports\t2/5 · 대기"));
  assert.ok(lines.includes(" ✓pack › -grep › ●names(3/8) › ◆pick › ○save"));
  assert.ok(lines.includes("작업자"));
  assert.ok(lines.includes(" ● review the diff\tRead a.ts"));
  assert.equal(
    band(frame(live, [agent("a9", { about: "review the diff" })], opts({ columns: 100 }))),
    "Encela ▸ 만들기 1/4 · 작업자 1 · exports 2/5 · Claude 차례 (pick)",
  );
  // Cut where the line above the prompt ends.
  assert.equal(band(view), "Encela ▸ ● 만들기 1/4 · 작업자 1 · exports 2/5 · Claude 차…");
  assert.equal(moving(live), false);
  live.runs[0].status = "running";
  assert.equal(moving(live), true);
  assert.equal(moving(null), false);
  assert.equal(moving(state({ pieces: [piece("x", "mcp", { busy: 1 })] })), true);
});

test("the frame fits the room: fewer rows drop the least telling, narrow lines are cut", () => {
  const many = state();
  many.blueprint.steps = Array.from({ length: 30 }, (_, i) =>
    step(`s${i}`, `단계 ${i}`, i < 12 ? "done" : i === 12 ? "doing" : "todo"),
  );
  const small = frame(many, [agent("main", { doing: "Edit a.ts" })], opts({ rows: 14 }));
  const lines = shown(small);
  // Two rows for the bar, and nothing past the room.
  assert.ok(lines.length + 1 <= 14, `${lines.length} lines`);
  assert.ok(!lines.includes("최근"));
  assert.ok(lines.some((l) => l.startsWith(" ● 1/2")));
  assert.ok(lines.some((l) => l.includes("● 단계 12")));
  assert.ok(lines.includes("   └ Edit a.ts"));
  assert.ok(lines.some((l) => /^ … \d+개 더$/.test(l)));
  assert.ok(!lines.some((l) => l.includes("단계 0")));

  // Korean is two cells a letter: a line never runs past the width it was given.
  const narrow = frame(state(), [], opts({ columns: 24 }));
  for (const l of narrow.lines) {
    if (l.bar) continue;
    const text = `${" ".repeat(l.indent ?? 0)}${l.left.map((s) => s.text).join("")}`;
    const right = (l.right ?? []).map((s) => s.text).join("");
    assert.ok(cells(text) + (right ? cells(right) + 1 : 0) <= 24, JSON.stringify(text + right));
  }
  assert.equal(shown(narrow)[1], "● 만들기");
  assert.ok(cells(band(frame(state(), [], opts({ columns: 20 })))) <= 20);
  assert.equal(cells("한글 ab"), 7);
  assert.equal(fit("할 일 앱 만들기", 8), "할 일 …");
  assert.equal(fit("abc", 3), "abc");
  assert.equal(fit("abcd", 3), "ab…");
});

test("what the server wrote is read with care: sizes bounded, unknown words replaced", () => {
  assert.equal(parse("not json"), null);
  assert.equal(parse("[]"), null);
  assert.equal(parse(JSON.stringify({ v: 2 })), null);
  assert.deepEqual(parse(JSON.stringify(state())), state());
  const odd = parse(
    JSON.stringify({
      v: 1,
      at: "soon",
      lang: "fr",
      phase: "hacked",
      blueprint: {
        id: 7,
        goal: "g".repeat(5000),
        status: "approved!",
        steps: [
          { id: "a", title: ["x"], status: "exploding", worker: null },
          "not a step",
          ...Array.from({ length: 200 }, () => ({ id: "more" })),
        ],
        workers: "everyone",
      },
      pieces: { length: 3 },
      runs: [{ pipeline: "p", status: "?", steps: [{ id: "s", state: "?", items: -4 }] }],
      events: [{ kind: "exploded", what: 3 }],
    }),
  );
  assert.equal(odd.at, 0);
  assert.equal(odd.lang, "en");
  assert.equal(odd.phase, "idle");
  assert.equal(odd.blueprint.id, "");
  assert.equal(odd.blueprint.goal.length, 300);
  assert.equal(odd.blueprint.status, "draft");
  assert.equal(odd.blueprint.steps.length, 60);
  assert.deepEqual(odd.blueprint.steps[0], step("a", "", "todo", ""));
  assert.deepEqual(odd.blueprint.steps[1], step("", "", "todo", ""));
  assert.deepEqual(odd.blueprint.workers, []);
  assert.deepEqual(odd.pieces, []);
  assert.equal(odd.runs[0].status, "interrupted");
  assert.deepEqual(odd.runs[0].steps[0], {
    id: "s",
    kind: "tool",
    state: "todo",
    items: 0,
    itemsDone: 0,
  });
  assert.equal(odd.events[0].kind, "saved");
  // Whatever it holds, drawing it doesn't throw.
  frame(odd, [], opts());
});

test("a tool call in a few words", () => {
  const own = "mcp__plugin_encela_encela__";
  assert.equal(encelaTool(`${own}find_pieces`), "find_pieces");
  assert.equal(encelaTool("mcp__encela__pipeline_run"), "pipeline_run");
  assert.equal(encelaTool("mcp__github__list_issues"), null);
  assert.equal(encelaTool("Bash"), null);
  assert.equal(doing("Edit", { file_path: "/work/app/src/canvas.ts" }), "Edit canvas.ts");
  assert.equal(doing("Write", { file_path: "C:\\work\\app\\a.ts" }), "Write a.ts");
  assert.equal(doing("Bash", { command: "pnpm   test\n --watch" }), "$ pnpm test --watch");
  assert.equal(doing("Grep", { pattern: "TODO" }), "Grep TODO");
  assert.equal(doing("Agent", { description: "Build the API" }), "Agent Build the API");
  assert.equal(doing("WebSearch", {}), "WebSearch");
  assert.equal(doing("mcp__github__list_issues", {}), "github · list_issues");
  assert.equal(doing(`${own}playwright__browser_click`, {}), "playwright · browser_click");
  assert.equal(
    doing(`${own}pipeline_run`, { id: "todo", pipeline: "exports" }),
    "pipeline_run exports",
  );
  assert.equal(doing(`${own}blueprint_step`, { id: "todo", step: "api" }), "blueprint_step api");
  assert.equal(doing(`${own}find_pieces`, { queries: ["a"] }), "find_pieces");
  // A hook sees the call's arguments beside `tool`: piece_call's own `tool` may be the call's name.
  assert.equal(
    doing(`${own}piece_call`, { id: "mcp:playwright", tool: "browser_click" }),
    "playwright · browser_click",
  );
  assert.equal(
    doing(`${own}piece_call`, { id: "mcp:playwright", tool: `${own}piece_call` }),
    "playwright",
  );
  assert.ok(cells(doing("Bash", { command: "x".repeat(500) })) <= 60);
  // Nothing that isn't plain text reaches the screen: Claude Code refuses a tree with control characters in it.
  const plain = /^[^\p{Cc}\u2028\u202a-\u202e\u2066-\u2069]*$/u;
  const nasty = "a\u001b[31mred\u0007\u0000\tb\r\nc\u202edcba\u2066x\ufeff";
  assert.equal(doing("Bash", { command: nasty }), "$ a [31mred b c dcba x");
  assert.match(doing("Edit", { file_path: `/x/${nasty}.ts` }), plain);
  assert.match(doing(`mcp__srv__${nasty}`, {}), plain);
  assert.equal(workerOf(`Worker "back\u001bend": role`), "back end");
  const dirty = parse(
    JSON.stringify({
      ...state(),
      blueprint: { ...state().blueprint, goal: nasty, steps: [step(nasty, nasty, "doing", nasty)] },
      pieces: [piece(nasty, "mcp", { last: nasty, calls: 1 })],
      events: [{ at: 1, kind: "step", what: nasty, how: nasty }],
    }),
  );
  const all = frame(dirty, [agent("main", { doing: doing("Bash", { command: nasty }) })], opts());
  for (const l of all.lines) {
    for (const s of [...l.left, ...(l.right ?? [])]) assert.match(s.text, plain);
  }
  for (const s of all.band) assert.match(s.text, plain);
});

test("the model loops: who is who, what each did last, when a turn ends", () => {
  // The brief Encela writes for a worker is what names the subagent.
  const b = {
    id: "todo",
    goal: "A todo app",
    pieces: [],
    workers: [{ name: "backend", role: "Builds the API" }],
    steps: [
      {
        id: "api",
        title: "The API",
        worker: "backend",
        after: [],
        pieces: [],
        pipeline: "",
        detail: "",
      },
    ],
  };
  const brief = briefs(b, (id) => id).find((x) => x.worker === "backend").text;
  assert.equal(workerOf(brief), "backend");
  assert.equal(workerOf(`Here is your part.\n\n${brief}`), "backend");
  assert.equal(workerOf("Review the diff"), "");

  let list = seen([], "main", { doing: "Read a.ts" });
  list = seen(list, "a1", { doing: "Edit b.ts" });
  list = seen(list, "a1", { worker: "backend", about: "API" });
  assert.deepEqual(list, [
    agent("main", { doing: "Read a.ts" }),
    agent("a1", { worker: "backend", about: "API", doing: "Edit b.ts" }),
  ]);
  // The latest comes last; past twelve the oldest go, never the main loop.
  list = seen(list, "main", { doing: "Bash" });
  assert.deepEqual(
    list.map((a) => a.id),
    ["a1", "main"],
  );
  for (let i = 0; i < 20; i++) list = seen(list, `x${i}`, {});
  assert.equal(list.length, 12);
  assert.ok(list.some((a) => a.id === "main"));
  assert.ok(!list.some((a) => a.id === "a1"));
  assert.equal(list.at(-1).id, "x19");

  // A turn that began is at work before its first tool call, and keeps what it was doing.
  assert.equal(began([], "main")[0].doing, "…");
  assert.equal(began(list, "x19").at(-1).doing, "…");
  assert.equal(
    began(seen(list, "x19", { doing: "Read a.ts", done: true }), "x19").at(-1).doing,
    "Read a.ts",
  );
  assert.equal(began(seen(list, "x19", { done: true }), "x19").at(-1).done, false);

  list = ended(ended(list, "x19"), "main");
  assert.equal(list.find((a) => a.id === "x19").done, true);
  assert.deepEqual(
    list.find((a) => a.id === "main"),
    agent("main"),
  );
  // A loop seen again is at work again.
  assert.equal(seen(list, "x19", { doing: "Read", done: false }).at(-1).done, false);
});

// Motion ----------------------------------------------------------------------

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const lineOf = (view, text) => view.lines.find((l) => l.left.some((s) => s.text.includes(text)));
/** A line as drawn at a moment: each run of text with how it is drawn. */
const drawn = (line, motion, columns = 60) =>
  paint(line, motion, columns).left.map((c) => [
    c.text,
    [c.bold && "bold", c.dim && "dim", c.inverse && "inverse"].filter(Boolean).join("+"),
  ]);
const later = (motion, ticks) => {
  let m = motion;
  for (let i = 0; i < ticks; i++) m = tickOn(m);
  return m;
};

test("motion is marked only where work is going on", () => {
  const fx = (view) =>
    view.lines.flatMap((l) => [
      ...l.left.filter((s) => s.fx).map((s) => `${s.fx}:${s.text.trim()}`),
      ...(l.bar?.live ? ["bar"] : []),
    ]);
  const busy = frame(
    state({
      pieces: [piece("playwright", "mcp", { running: true, busy: 1, calls: 2, last: "click" })],
    }),
    [agent("a1", { worker: "backend", doing: "Edit routes.ts" })],
    opts(),
  );
  assert.deepEqual(fx(busy), ["pulse:● 만들기", "bar", "spin:●", "spin:●", "spin:●"]);
  assert.deepEqual(
    busy.band.filter((s) => s.fx).map((s) => s.fx),
    ["spin"],
  );
  // Claude's turn is over and no call is out: steps left "doing" stand still.
  const still = frame(
    state(),
    [agent("main"), agent("a1", { worker: "backend", done: true })],
    opts(),
  );
  assert.deepEqual(fx(still), []);
  assert.deepEqual(
    still.band.filter((s) => s.fx),
    [],
  );
  // The user is asked: that pulses, whoever works.
  const asking = frame(state({ phase: "approval" }), [], opts());
  assert.deepEqual(fx(asking), ["pulse:● 승인", "pulse:승인을 기다리는 중"]);
  assert.equal(asking.band[1].fx, "pulse");
  // Claude's call is out while the question is open: that is waiting, not work on the build.
  const held = frame(
    state({ phase: "approval" }),
    [agent("main", { doing: "blueprint_approve" })],
    opts(),
  );
  assert.ok(!fx(held).includes("bar"));
  // A run that is going moves by itself; a step waiting for Claude pulses.
  const run = {
    id: "r-1",
    pipeline: "exports",
    status: "running",
    steps: [
      { id: "names", kind: "tool", state: "running", items: 8, itemsDone: 3 },
      { id: "pick", kind: "claude", state: "waiting", items: 0, itemsDone: 0 },
    ],
  };
  assert.deepEqual(fx(frame(state({ runs: [run] }), [], opts())).slice(-2), [
    "spin:●names(3/8)",
    "pulse:◆pick",
  ]);

  // Workers are told apart by colour, the same for a worker's name and what it is doing.
  const api = lineOf(busy, "API 구현");
  const ui = lineOf(busy, "화면 구현");
  assert.deepEqual([api.right[0].hue, ui.right[0].hue], [0, 1]);
  assert.equal(lineOf(busy, "Edit routes.ts").left[0].hue, 0);
  assert.equal(lineOf(busy, "테스트").right, undefined);
});

test("motion: markers turn, the phase beats, and the clock rests when nothing moves", () => {
  assert.equal(TICK, 120);
  const view = frame(
    state(),
    [agent("a1", { worker: "backend", doing: "Edit routes.ts" })],
    opts(),
  );
  const api = lineOf(view, "API 구현");
  const flow = view.lines[1];
  const m = meet(undefined, view.lines);
  assert.equal(m.tick, 0);
  assert.equal(m.live, true);
  assert.equal(meet(m, view.lines), m, "the same lines are the same motion");
  for (const tick of [0, 1, 9, 10, 23]) {
    assert.equal(drawn(api, later(m, tick))[0][0], SPIN[tick % 10]);
  }
  assert.equal(drawn(api, m)[1][0], " API 구현");
  // The phase the flow stands at swells and fades.
  const beat = (tick) => drawn(flow, later(m, tick)).find((c) => c[0] === "● 만들기")[1];
  assert.deepEqual([0, 2, 3, 4, 5, 7, 8, 9, 10].map(beat), [
    "bold",
    "bold",
    "",
    "",
    "dim",
    "dim",
    "",
    "",
    "bold",
  ]);
  assert.equal(drawn(flow, m)[0][1], "", "phases that are done don't move");

  // Nothing at work: nothing to redraw for, and the marker is the plain one.
  const rest = frame(state(), [], opts());
  const quiet = meet(m, rest.lines);
  assert.equal(quiet.live, false);
  assert.equal(drawn(lineOf(rest, "API 구현"), quiet)[0][0], "●");
  assert.equal(tickOn(quiet).live, false);
  // Work that went on without a word for ten minutes is taken to have stopped.
  const stale = later(m, 5000);
  assert.equal(stale.live, false);
  assert.equal(drawn(api, stale)[0][0], "●");
  assert.equal(later(m, 4999).live, true);
  // Anything new and it moves again.
  const more = frame(state(), [agent("a1", { worker: "backend", doing: "Bash" })], opts());
  assert.equal(meet(stale, more.lines).live, true);
});

test("motion: a line whose state just changed is lit for a moment", () => {
  const who = [agent("a1", { worker: "backend", doing: "Edit routes.ts" })];
  const before = frame(state(), who, opts());
  let m = later(meet(undefined, before.lines), 7);
  const next = state();
  next.blueprint.steps[1].status = "done";
  const view = frame(next, who, opts());
  m = meet(m, view.lines);
  assert.deepEqual(Object.keys(m.lit).sort(), ["bar", "step:api"]);
  const api = lineOf(view, "API 구현");
  assert.deepEqual(drawn(api, m), [
    ["✓", "inverse"],
    [" API 구현", "inverse"],
  ]);
  assert.deepEqual(drawn(api, later(m, 3))[0], ["✓", "inverse"]);
  assert.deepEqual(drawn(api, later(m, 4))[0], ["✓", "bold"]);
  assert.deepEqual(drawn(api, later(m, 11))[0], ["✓", "bold"]);
  assert.deepEqual(drawn(api, later(m, 12))[0], ["✓", ""]);
  // Other lines are as they were, and a line that is new is not lit.
  assert.deepEqual(drawn(lineOf(view, "데이터 모델"), m)[0], ["✓", ""]);
  const grown = state();
  grown.blueprint.steps.push(step("more", "하나 더", "todo"));
  assert.deepEqual(
    meet(later(meet(undefined, before.lines), 3), frame(grown, who, opts()).lines).lit,
    {},
  );
  // Being lit keeps the clock going even when nothing else moves, and then it rests.
  const calm = frame(next, [], opts());
  let c = meet(m, calm.lines);
  assert.equal(c.fx, false);
  assert.equal(c.live, true);
  c = later(c, 12);
  assert.equal(c.live, false);
  assert.deepEqual(drawn(lineOf(calm, "API 구현"), c)[0], ["✓", ""]);
});

test("motion: the bar fills with what is done, and a light runs along it while work goes on", () => {
  const who = [agent("a1", { worker: "backend", doing: "Edit routes.ts" })];
  const view = frame(state(), who, opts({ columns: 40 }));
  const bar = view.lines.find((l) => l.bar);
  assert.deepEqual(bar.bar, { done: 1, total: 4, live: true });
  const m = meet(undefined, view.lines);
  const text = (motion) =>
    paint(bar, motion, 40)
      .left.map((c) => c.text)
      .join("");
  // 40 cells: the label, the bar (28 at most), the figure.
  assert.equal(text(later(m, 30)), `단계 ${"█".repeat(7)}${"░".repeat(21)} 1/4`);
  assert.equal(text(m), `단계 ▓${"█".repeat(6)}${"░".repeat(21)} 1/4`);
  assert.equal(text(later(m, 6)), `단계 ${"█".repeat(6)}▓${"░".repeat(21)} 1/4`);
  assert.equal(text(later(m, 7)), `단계 ${"█".repeat(7)}▒${"░".repeat(20)} 1/4`);
  assert.equal(text(later(m, 38)), text(m), "the light comes round again");
  assert.ok(cells(text(m)) <= 40);
  // A narrow pane keeps a short bar.
  assert.equal(
    paint(bar, m, 14)
      .left.map((c) => c.text)
      .join("").length,
    "단계 ".length + 6 + " 1/4".length,
  );
  // Done: full, in the colour of what is done, and still.
  const done = state({ phase: "done" });
  for (const s of done.blueprint.steps) s.status = "done";
  const full = frame(done, [], opts({ columns: 40 }));
  const end = full.lines.find((l) => l.bar);
  assert.equal(end.bar.live, undefined);
  const cellsOf = paint(end, meet(undefined, full.lines), 40).left;
  assert.deepEqual(
    cellsOf.map((c) => [c.text, c.tone]),
    [
      ["단계 ", "strong"],
      ["█".repeat(28), "good"],
      [" 4/4", "dim"],
    ],
  );
  // Nothing to do yet: an empty track, no division by zero.
  const none = { left: [{ text: "Steps", tone: "strong" }], bar: { done: 0, total: 0 } };
  assert.equal(
    paint(none, meet(undefined, [none]), 30)
      .left.map((c) => c.text)
      .join(""),
    `Steps ${"░".repeat(20)} 0/0`,
  );
});

test("how a run of text is drawn: the theme's colours, never raw ones", () => {
  assert.deepEqual(look({ tone: "plain" }), {});
  assert.deepEqual(look({ tone: "dim" }), { dimColor: true });
  assert.deepEqual(look({ tone: "strong" }), { bold: true });
  assert.deepEqual(look({ tone: "good" }), { color: "success" });
  assert.deepEqual(look({ tone: "bad" }), { color: "error" });
  assert.deepEqual(look({ tone: "busy", bold: true }), { color: "suggestion", bold: true });
  assert.deepEqual(look({ tone: "wait", dim: true }), { color: "warning", dimColor: true });
  assert.deepEqual(look({ tone: "good", inverse: true }), { color: "success", inverse: true });
  // A worker's colour stands in for the tone's, and is none of the colours that say how things stand.
  assert.deepEqual(look({ tone: "dim", hue: 0 }), { color: "planMode" });
  const hues = [0, 1, 2].map((hue) => look({ tone: "dim", hue }).color);
  assert.equal(new Set(hues).size, 3);
  for (const tone of ["good", "bad", "busy", "wait"]) {
    assert.ok(!hues.includes(look({ tone }).color), tone);
  }
  assert.equal(look({ tone: "dim", hue: 3 }).color, hues[0], "it comes round after three workers");
  // What was dim and is lit is no longer dim.
  assert.deepEqual(look({ tone: "dim", bold: true }), { bold: true });
});

// The server's side -----------------------------------------------------------

const echo = {
  kind: "mcp",
  name: "echo",
  summary: "A test server",
  config: { command: process.execPath, args: [join(here, "fixtures", "echo-server.mjs")] },
};
const servers = [];
after(() => {
  for (const s of servers) s.closeAll();
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function start(capabilities = {}, from = {}) {
  const sent = [];
  const home = from.home ?? temp("home");
  const registry = new Registry(home);
  if (!from.home) registry.add(echo, "user");
  const project = from.project ?? temp("project");
  const server = new Server((m) => sent.push(m), { project, registry, tools: new ToolCache(home) });
  servers.push(server);
  const ready = server.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities },
  });
  const file = join(project, ".encela", "live.json");
  const live = () => parse(readFileSync(file, "utf8"));
  return { server, sent, project, home, ready, file, live };
}

const plan = {
  goal: "Try the view",
  pieces: [{ piece: "mcp:echo", role: "The tools" }],
  workers: [{ name: "helper", role: "Does the second step" }],
  steps: [
    { id: "run", title: "Run it", pipeline: "sizes" },
    { id: "look", title: "Look at it", worker: "helper", after: ["run"] },
  ],
  pipelines: [
    {
      name: "sizes",
      steps: [
        { id: "list", piece: "mcp:echo", tool: "list", args: { n: 2 } },
        { id: "total", transform: "$steps.list.json.files | map(.size) | add" },
      ],
    },
  ],
};

test("the server keeps the view's file up to date, written before each answer", async () => {
  const { server, sent, project, ready, file, live } = start({ elicitation: {} });
  await ready;
  // Looking for pieces makes no folder in the project.
  await server.call("find_pieces", { queries: ["test server"] });
  assert.ok(!existsSync(join(project, ".encela")));

  await server.call("blueprint_save", { blueprint: plan });
  const id = new Blueprints(project).list()[0].id;
  let now = live();
  assert.equal(now.phase, "blueprint");
  assert.equal(now.blueprint.id, id);
  assert.equal(now.blueprint.goal, "Try the view");
  assert.deepEqual(
    now.blueprint.steps.map((s) => [s.id, s.status, s.worker, s.pipeline]),
    [
      ["run", "todo", "main", "sizes"],
      ["look", "todo", "helper", ""],
    ],
  );
  assert.deepEqual(now.blueprint.workers, ["helper"]);
  assert.deepEqual(
    now.pieces.map((p) => [p.id, p.kind, p.running, p.calls]),
    [["mcp:echo", "mcp", false, 0]],
  );
  assert.deepEqual(
    now.events.map((e) => e.kind),
    ["found", "saved"],
  );
  // The file says exactly what the view's own reader takes.
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), now);

  // While the question is open, the view says so.
  const answer = server.call("blueprint_approve", { id });
  for (let i = 0; i < 100 && !sent.some((m) => m.method === "elicitation/create"); i++) {
    await pause(10);
  }
  await pause(120);
  assert.equal(live().phase, "approval");
  const asked = sent.find((m) => m.method === "elicitation/create");
  await server.handle({
    jsonrpc: "2.0",
    id: asked.id,
    result: { action: "accept", content: { decision: "approve" } },
  });
  // A second question (marked calls) may follow: answer whatever is asked.
  for (let i = 0; i < 50; i++) {
    const more = sent.filter((m) => m.method === "elicitation/create")[1];
    if (more && !more.answered) {
      more.answered = true;
      await server.handle({
        jsonrpc: "2.0",
        id: more.id,
        result: { action: "accept", content: { decision: "approve" } },
      });
    }
    if (await Promise.race([answer.then(() => true), pause(10).then(() => false)])) break;
  }
  await answer;
  now = live();
  assert.equal(now.phase, "assemble");
  assert.equal(now.blueprint.approval, "direct");

  await server.call("blueprint_assemble", { id });
  now = live();
  assert.equal(now.phase, "build");
  assert.equal(now.pieces[0].running, true);

  await server.call("blueprint_step", { id, step: "run", status: "doing" });
  assert.equal(live().blueprint.steps[0].status, "doing");
  await server.call("piece_call", { id: "mcp:echo", tool: "upper", args: { text: "a" } });
  now = live();
  assert.deepEqual([now.pieces[0].calls, now.pieces[0].last, now.pieces[0].busy], [1, "upper", 0]);

  await server.call("pipeline_run", { id, pipeline: "sizes" });
  now = live();
  assert.equal(now.runs.length, 1);
  assert.equal(now.runs[0].pipeline, "sizes");
  assert.equal(now.runs[0].status, "done");
  assert.deepEqual(
    now.runs[0].steps.map((s) => [s.id, s.kind, s.state]),
    [
      ["list", "tool", "done"],
      ["total", "transform", "done"],
    ],
  );
  assert.ok(now.pieces[0].calls >= 2);
  assert.ok(now.events.length <= 12);
  assert.ok(now.events.some((e) => e.kind === "run" && e.what === "sizes"));

  // The view draws it.
  const lines = shown(frame(now, [], opts({ lang: "en" })));
  assert.ok(lines.includes("Try the view"));
  assert.ok(lines.some((l) => l.includes("✓list › ✓total")));

  // A link where the file goes is not written through.
  const outside = join(temp("outside"), "target.json");
  writeFileSync(outside, "untouched");
  rmSync(file);
  symlinkSync(outside, file);
  await server.call("blueprint_step", { id, step: "run", status: "done" });
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  server.closeAll();
});

test("a cancelled blueprint leaves the view idle; a build the project was left with shows until a new request", async () => {
  const small = {
    ...plan,
    pipelines: [],
    steps: [{ id: "look", title: "Look at it", worker: "helper" }],
  };
  const { server, project, ready, live } = start();
  await ready;
  await server.call("blueprint_save", { blueprint: small });
  const id = new Blueprints(project).list()[0].id;
  await server.call("blueprint_approve", { id, user_answer: "cancel" });
  const now = live();
  assert.equal(now.phase, "idle");
  assert.equal(now.blueprint, null);
  assert.equal(now.events.at(-1).kind, "cancelled");
  server.closeAll();

  // A session ends with a build approved; the next one in that project sees it.
  const first = start();
  await first.ready;
  await first.server.call("blueprint_save", { blueprint: small });
  const left = new Blueprints(first.project).list()[0].id;
  await first.server.call("blueprint_approve", { id: left, user_answer: "approve" });
  first.server.closeAll();
  const next = start({}, first);
  await next.ready;
  await next.server.call("blueprint_get", { id: left });
  assert.equal(next.live().phase, "assemble");
  assert.equal(next.live().blueprint.id, left);
  // A new request is looked into: the old build is no longer what is going on.
  await next.server.call("find_pieces", { queries: ["something new"] });
  assert.equal(next.live().phase, "pieces");
  assert.equal(next.live().blueprint, null);
  next.server.closeAll();
});

test("setup writes the view into the plugin, or leaves it out", () => {
  const root = writePlugin(join(temp("plugin"), "claude-plugin"));
  const plugin = join(root, "plugins", "encela");
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(hooks.modules, ["./view.tsx"]);
  assert.ok(hooks.hooks.UserPromptSubmit);
  for (const f of ["hooks/view.tsx", "hooks/motion.tsx", "hooks/model.ts", "types/index.d.ts"]) {
    assert.ok(existsSync(join(plugin, f)), f);
  }
  // The tests need Claude Code to run: they stay out of the package.
  assert.ok(!existsSync(join(plugin, "tests")));
  const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.types, "./types/index.d.ts");
  assert.equal(manifest.license, "Apache-2.0");
  // The module imports nothing but Claude Code's own and the plugin's files.
  const source = readFileSync(join(plugin, "hooks", "view.tsx"), "utf8");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(), [
    "../types",
    "./model",
    "./model",
    "claude-code",
    "claude-code",
  ]);

  // Only the prompt hook.
  const bare = join(
    writePlugin(join(temp("plugin"), "claude-plugin"), true, false),
    "plugins",
    "encela",
  );
  const only = JSON.parse(readFileSync(join(bare, "hooks", "hooks.json"), "utf8"));
  assert.equal(only.modules, undefined);
  assert.ok(only.hooks.UserPromptSubmit);
  assert.ok(!existsSync(join(bare, "hooks", "view.tsx")));
  assert.ok(!existsSync(join(bare, "types")));
  assert.equal(
    JSON.parse(readFileSync(join(bare, ".claude-plugin", "plugin.json"), "utf8")).types,
    undefined,
  );
  // Only the view.
  const quiet = join(
    writePlugin(join(temp("plugin"), "claude-plugin"), false, true),
    "plugins",
    "encela",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(quiet, "hooks", "hooks.json"), "utf8")), {
    modules: ["./view.tsx"],
  });
  // Neither.
  assert.ok(
    !existsSync(
      join(
        writePlugin(join(temp("plugin"), "claude-plugin"), false, false),
        "plugins",
        "encela",
        "hooks",
      ),
    ),
  );
});
