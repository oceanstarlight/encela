// The workflow canvas (plugin/hooks/canvas.ts): who directs whom, laid out
// in cells for the room there is. The drawing itself is checked by Claude
// Code: `pnpm check:view`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acted, actOf, canvas, settled, tabLabels } from "./.build/canvas.js";
import { cells, meet, OWN, packetAt, paint, tickOn } from "./.build/view.js";

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
const live = (more = {}) => ({
  v: 1,
  at: 1,
  lang: "ko",
  phase: "build",
  blueprint: {
    id: "b",
    goal: "g",
    status: "assembled",
    approval: "direct",
    workers: ["reader_a", "reader_b"],
    steps: [],
  },
  pieces: [
    piece("filesystem", "mcp", { running: true, busy: 1, calls: 4, last: "read_text_file" }),
    piece("playwright", "mcp", { running: true }),
    piece("코드 리뷰 규칙", "rule"),
    piece("tdd", "skill"),
  ],
  runs: [],
  events: [],
  ...more,
});
const agent = (id, more = {}) => ({ id, worker: "", about: "", doing: "", done: false, ...more });
const AGENTS = [
  agent("main", { doing: "blueprint_step read" }),
  agent("a1", { worker: "reader_a", doing: "filesystem · read_text_file" }),
  agent("a2", { worker: "reader_b", done: true }),
];
const ACTS = [
  { id: "1", from: "a1", kind: "piece", name: "filesystem", busy: 1, calls: 2 },
  { id: "2", from: "main", kind: "web", name: "web", busy: 1, calls: 1 },
  { id: "3", from: "main", kind: "piece", name: "playwright", busy: 0, calls: 1 },
];
const text = (lines) => lines.map((l) => l.left.map((s) => s.text).join("")).join("\n");
const segs = (lines) => lines.flatMap((l) => l.left);

test("the canvas shows the orchestrator, who it started and what they use", () => {
  const lines = canvas(live(), AGENTS, ACTS, { columns: 72, rows: 24 });
  const shown = text(lines);
  for (const name of [
    "오케스트레이터",
    "reader_a",
    "reader_b",
    "filesystem",
    "playwright",
    "tdd",
  ]) {
    assert.match(shown, new RegExp(name), name);
  }
  // What a loop reached for in passing is there too.
  assert.match(shown, /◎ 웹/);
  // Where there is room a node says what it is doing.
  assert.match(shown, /blueprint_step/);
  assert.match(shown, /부품 4\/4 조립됨/);
  // The orchestrator is above the workers, the pieces below them.
  const row = (name) => shown.split("\n").findIndex((l) => l.includes(name));
  assert.ok(row("오케스트레이터") < row("reader_a"));
  assert.ok(row("reader_a") < row("filesystem"));
});

test("a line in use takes a colour and packets run along it, from the caller to the called", () => {
  const lines = canvas(live(), AGENTS, ACTS, { columns: 72, rows: 24 });
  const flowing = segs(lines).filter((s) => s.fx === "flow");
  assert.ok(flowing.length > 10);
  assert.ok(flowing.every((s) => s.tone === "busy" && Number.isInteger(s.at) && s.at >= 0));
  // A worker's line is in the worker's colour.
  assert.ok(flowing.some((s) => s.hue === 0));
  // A packet is on the cells one gap apart, and moves on by one cell.
  let m = meet(undefined, lines);
  assert.equal(m.live, true);
  const packets = (motion) =>
    lines.flatMap((l) => paint(l, motion, 72).left).filter((c) => c.text === "■").length;
  assert.ok(packets(m) > 0);
  assert.equal(packetAt(0, 0), true);
  assert.equal(packetAt(0, 1), false);
  assert.equal(packetAt(2, 1), true);
  assert.equal(packetAt(4, 2), true);
  m = tickOn(tickOn(m));
  assert.ok(packets(m) > 0);
  // Every cell of a line is a line's glyph until a packet is on it.
  assert.ok(
    flowing.every((s) => /^[┄┆╭╮╰╯┬┴├┤┼]$/.test(s.text)),
    text(lines),
  );
});

test("nothing runs along a line once nothing is going on", () => {
  const idle = [agent("main"), agent("a1", { worker: "reader_a", done: true })];
  const still = live({ pieces: [piece("filesystem", "mcp", { running: true, calls: 4 })] });
  const used = [{ id: "1", from: "a1", kind: "piece", name: "filesystem", busy: 0, calls: 2 }];
  const lines = canvas(still, idle, used, { columns: 72, rows: 24 });
  assert.equal(segs(lines).filter((s) => s.fx).length, 0);
  assert.equal(meet(undefined, lines).live, false);
  // The line that was used is still drawn.
  assert.match(text(lines), /[┄┆]/);
});

test("the canvas keeps to the room there is, at any size", () => {
  const many = live({
    pieces: Array.from({ length: 14 }, (_, i) =>
      piece(i % 3 ? `부품-${i}` : `piece-number-${i}`, i % 2 ? "mcp" : "skill", {
        running: i % 2 === 1,
        busy: i === 1 ? 1 : 0,
      }),
    ),
    runs: [
      {
        id: "r1",
        pipeline: "compare",
        status: "running",
        steps: [{ id: "a", kind: "tool", state: "running", items: 0, itemsDone: 0 }],
      },
    ],
  });
  const crowd = [
    agent("main", { doing: "x" }),
    ...Array.from({ length: 9 }, (_, i) =>
      agent(`a${i}`, {
        worker: i < 2 ? `reader_${"ab"[i]}` : "",
        about: `일꾼 ${i}`,
        doing: "Edit a.ts",
      }),
    ),
  ];
  const reached = [
    ...ACTS,
    { id: "4", from: "a3", kind: "mcp", name: "github", busy: 1, calls: 1 },
    { id: "5", from: "main", kind: "skill", name: "pdf", busy: 0, calls: 1 },
  ];
  for (let columns = 16; columns <= 130; columns += 3) {
    for (const rows of [3, 4, 5, 7, 9, 12, 16, 24, 40]) {
      for (const [state, loops, acts] of [
        [many, crowd, reached],
        [live(), AGENTS, ACTS],
        [null, [], []],
        [live({ phase: "approval" }), [agent("main")], []],
      ]) {
        const lines = canvas(state, loops, acts, { columns, rows });
        const where = `${columns}x${rows}`;
        assert.ok(lines.length <= rows, `${where}: ${lines.length} lines`);
        for (const l of lines) {
          const width = l.left.reduce((n, s) => n + cells(s.text), 0);
          assert.ok(width <= columns, `${where}: a line of ${width} cells\n${text(lines)}`);
          // A line handed to the surface module holds no key without a value.
          assert.deepEqual(JSON.parse(JSON.stringify(l)), l);
        }
        // The orchestrator is always there.
        assert.match(text(lines), /◆/, where);
      }
    }
  }
  // What doesn't fit a row is gathered, and said.
  assert.match(text(canvas(many, crowd, reached, { columns: 40, rows: 16 })), /… \+\d+/);
  // With few rows the boxes go, the names stay.
  const flat = text(canvas(live(), AGENTS, ACTS, { columns: 60, rows: 6 }));
  assert.doesNotMatch(flat, /[│╭]─/);
  assert.match(flat, /reader_a/);
});

test("a piece is drawn loose until it is assembled, and reached for while it is", () => {
  const before = canvas(live({ phase: "approval" }), [agent("main")], [], {
    columns: 72,
    rows: 20,
  });
  assert.match(text(before), /╭┄+╮/);
  assert.match(text(before), /부품 0\/4 조립됨/);
  const during = canvas(
    live({ phase: "assemble" }),
    [agent("main", { doing: "blueprint_assemble" })],
    [],
    {
      columns: 72,
      rows: 20,
    },
  );
  assert.ok(segs(during).some((s) => s.fx === "flow"));
  assert.doesNotMatch(text(during), /╭┄+╮/);
});

test("text from outside is drawn as one safe line", () => {
  const odd = live({ pieces: [piece("bad\u001b[31m\nname\u202e", "mcp", { running: true })] });
  const lines = canvas(odd, [agent("main", { doing: "a\u0007b" })], [], { columns: 60, rows: 20 });
  const shown = lines.map((l) => l.left.map((s) => s.text).join("")).join(" ");
  assert.match(shown, /bad/);
  assert.doesNotMatch(shown, /\p{Cc}|\p{Cf}/u);
});

test("what a call reaches for: a piece, the web, another server, a skill", () => {
  const of = (tool, input = {}) => {
    const own = /^mcp__(?:plugin_encela_)?encela__(.+)$/.exec(tool)?.[1] ?? null;
    return actOf(tool, input, own, OWN);
  };
  assert.deepEqual(of("mcp__plugin_encela_encela__filesystem__read_file"), {
    kind: "piece",
    name: "filesystem",
  });
  assert.deepEqual(of("mcp__plugin_encela_encela__piece_call", { id: "mcp:echo", tool: "say" }), {
    kind: "piece",
    name: "echo",
  });
  assert.equal(of("mcp__plugin_encela_encela__blueprint_step", { id: "b" }), null);
  assert.deepEqual(of("WebSearch", { query: "x" }), { kind: "web", name: "web" });
  assert.deepEqual(of("WebFetch", { url: "x" }), { kind: "web", name: "web" });
  assert.deepEqual(of("mcp__plugin_github_github__list_issues"), { kind: "mcp", name: "github" });
  assert.deepEqual(of("Skill", { skill: "pdf" }), { kind: "skill", name: "pdf" });
  assert.equal(of("Skill", {}), null);
  for (const tool of ["Read", "Edit", "Bash", "Grep", "Agent"]) assert.equal(of(tool, {}), null);

  // Calls in flight are counted per caller and target, and never below none.
  const web = { kind: "web", name: "web" };
  let list = acted([], "main", web, 1);
  list = acted(list, "main", web, 1);
  assert.deepEqual(
    list.map((a) => [a.from, a.kind, a.busy, a.calls]),
    [["main", "web", 2, 2]],
  );
  list = acted(acted(acted(list, "main", web, -1), "main", web, -1), "main", web, -1);
  assert.equal(list[0].busy, 0);
  // Only so many are remembered, and what is in flight stays.
  list = acted(list, "a1", { kind: "piece", name: "fs" }, 1);
  for (let i = 0; i < 30; i++) list = acted(list, "main", { kind: "mcp", name: `s${i}` }, -1);
  assert.ok(list.length <= 10);
  assert.ok(list.some((a) => a.from === "a1" && a.busy === 1));
  // A turn that is over has nothing in flight; after the main loop's, what was only passed by is gone.
  const over = settled(
    [
      { id: "1", from: "main", kind: "web", name: "web", busy: 1, calls: 1 },
      { id: "2", from: "main", kind: "piece", name: "fs", busy: 1, calls: 1 },
      { id: "3", from: "a1", kind: "mcp", name: "github", busy: 1, calls: 1 },
    ],
    "main",
  );
  assert.deepEqual(
    over.map((a) => [a.name, a.busy]),
    [
      ["fs", 0],
      ["github", 1],
    ],
  );
  assert.deepEqual(
    settled(over, "a1").map((a) => [a.name, a.busy]),
    [
      ["fs", 0],
      ["github", 0],
    ],
  );
});

test("the tabs say what fits", () => {
  assert.deepEqual(tabLabels("ko", 60), { graph: "작업 그래프", canvas: "워크플로우 캔버스" });
  assert.deepEqual(tabLabels("ko", 30), { graph: "그래프", canvas: "캔버스" });
  assert.deepEqual(tabLabels("en", 60), { graph: "Work graph", canvas: "Workflow canvas" });
  assert.deepEqual(tabLabels("en", 20), { graph: "Graph", canvas: "Canvas" });
});
