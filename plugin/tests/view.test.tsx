// Run by Claude Code itself: `pnpm check:view` (it needs the `claude`
// command, so CI doesn't run it). The hooks a test registers sit beneath the
// plugin and stand for the engine: the project's folder, the clock, the tools.
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Live } from "../types";

const ROOT = "/work/app";
const FILE = `${ROOT}/.encela/live.json`;
const SURFACES = ["terminal", "desktop", "vscode", "mobile"] as const;

const PANE = {
  plugin: "encela",
  component: "Pane",
  requestId: "encela",
  props: {
    title: "Encela",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

const BAND = {
  plugin: "encela",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

function building(at: number): Live {
  return {
    v: 1,
    at,
    lang: "ko",
    phase: "build",
    blueprint: {
      id: "todo",
      goal: "할 일 앱 만들기",
      status: "assembled",
      approval: "direct",
      steps: [
        { id: "model", title: "데이터 모델", status: "done", worker: "backend", pipeline: "" },
        { id: "api", title: "API 구현", status: "doing", worker: "backend", pipeline: "" },
        { id: "ui", title: "화면 구현", status: "todo", worker: "frontend", pipeline: "" },
      ],
      workers: ["backend", "frontend"],
    },
    pieces: [
      {
        id: "mcp:playwright",
        name: "playwright",
        kind: "mcp",
        running: true,
        busy: 0,
        calls: 3,
        last: "browser_click",
        lastAt: at,
      },
      {
        id: "skill:tdd",
        name: "tdd",
        kind: "skill",
        running: false,
        busy: 0,
        calls: 0,
        last: "",
        lastAt: 0,
      },
    ],
    runs: [],
    events: [{ at, kind: "step", what: "API 구현", how: "doing" }],
  };
}

/** The engine beneath the plugin: a project folder that holds `text` as the server's file, at `realPath`. */
function world(on: On, file: { text: string; realPath?: string } | null) {
  const opened: string[] = [];
  on("command.register", () => ({ value: { command: "encela-view" } }));
  on("ui.open", (_, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.root", () => ({ value: ROOT }));
  on("tool.call", () => ({ result: {} }));
  on("agent.spawn", () => ({ model: "sonnet", agentId: "agent-1" }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("fs.stat", (_, e) => {
    if (e.path === ROOT) {
      return { value: { kind: "dir", size: 0, mtimeMs: 1, isLink: false, realPath: ROOT } };
    }
    if (e.path !== FILE || !file) throw new Error(`no such file: ${e.path}`);
    return {
      value: {
        kind: "file",
        size: file.text.length,
        mtimeMs: 5,
        isLink: file.realPath !== undefined,
        realPath: file.realPath ?? FILE,
      },
    };
  });
  on("fs.read", (_, e) => {
    if (e.path !== FILE || !file) throw new Error(`no such file: ${e.path}`);
    return { value: file.text };
  });
  return opened;
}

const STEP = {
  tool: "mcp__plugin_encela_encela__blueprint_step",
  id: "todo",
  step: "api",
  status: "doing",
} as never;

type Surface = (typeof SURFACES)[number];
/** Where the lines are: inside the region `motion.tsx` draws, on the surfaces that have one. */
const within = (surface: Surface, key: "pane" | "band") =>
  surface === "terminal" || surface === "desktop" ? { in: key } : {};
/** The marker of what is in progress: a spinner where the lines move, a dot where they stand. */
const MARK = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/.source;

test("a session that doesn't use Encela is left alone", async ($, on) => {
  mock.clock(on, { now: 1000 });
  const opened = world(on, { text: JSON.stringify(building(2000)) });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call({ tool: "Bash", command: "ls" });

  expect(opened).toEqual([]);
  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(
    await pane.find({
      type: "Text",
      text: /Nothing is being built|지금 만드는 것이 없어요/,
      in: "pane",
    }),
  ).toBeDefined();
  expect(await pane.find({ text: /할 일 앱/, in: "pane" })).toBeUndefined();
  await pane.unmount();
  // The line above the prompt is left to the engine.
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await band.find({ type: "Text", text: /engine/ }))?.text).toBe("engine");
  await band.unmount();
});

test("an Encela call opens the view and draws the build, on every surface", async ($, on) => {
  mock.clock(on, { now: 1000 });
  const opened = world(on, { text: JSON.stringify(building(2000)) });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call(STEP);

  expect(opened).toEqual(["encela"]);
  // What a surface doesn't show, by name: a failure says which and where.
  const missing: string[] = [];
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface });
    const at = within(surface, "pane");
    const has = async (text: RegExp) => {
      if (!(await pane.find({ type: "Text", text, ...at }))) missing.push(`${surface}: ${text}`);
    };
    await has(/할 일 앱 만들기/);
    await has(/● 만들기/);
    await has(/✓ 데이터 모델/);
    await has(new RegExp(`${MARK} API 구현`));
    await has(/playwright/);
    await has(/browser_click · 3회/);
    await has(/문서 1/);
    // The bar: the engine's own where the lines stand, drawn in cells where they move.
    if ("in" in at) await has(/단계 [█▓]+[░▒]+ 1\/3/);
    // (The kit shows the engine's bar as a Progress on the phone and as its text elsewhere.)
    else if (!(await pane.find({ text: /단계/ }))) missing.push(`${surface}: bar`);
    await pane.unmount();

    const band = await $.ui.mount({ ...BAND, surface });
    const line = new RegExp(`Encela ▸ ${MARK} 만들기 1/3`);
    if (!(await band.find({ type: "Text", text: line, ...within(surface, "band") }))) {
      missing.push(`${surface}: band`);
    }
    await band.unmount();
  }
  expect(missing).toEqual([]);
});

test("where the surface redraws by itself the lines move, and stand still when the turn is over", async ($, on) => {
  mock.clock(on, { now: 1000 });
  world(on, { text: JSON.stringify(building(2000)) });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call(STEP);

  let pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  const api = async () =>
    (await pane.find({ type: "Text", text: /^ . API 구현$/, in: "pane" }))?.text ?? "";
  expect(await api()).toBe(" ⠋ API 구현");
  await pane.advance(120);
  expect(await api()).toBe(" ⠙ API 구현");
  await pane.advance(240);
  expect(await api()).toBe(" ⠸ API 구현");
  await pane.unmount();

  // The turn ends with the step still open: nothing claims to be going on.
  await $.turn.complete({
    answer: "paused",
    durationMs: 10,
    isAborted: false,
    turnId: "t1",
  } as never);
  pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await api()).toBe(" ● API 구현");
  await pane.advance(600);
  expect(await api()).toBe(" ● API 구현");
  await pane.unmount();
});

test("what a worker is doing shows under the step it does, until its turn ends", async ($, on) => {
  mock.clock(on, { now: 1000 });
  world(on, { text: JSON.stringify(building(2000)) });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call(STEP);
  await $.agent.spawn({
    prompt: 'Worker "backend": builds the API.\nSteps: api',
    description: "API",
    subagentType: "general-purpose",
  } as never);
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/src/routes.ts`,
    old_string: "a",
    new_string: "b",
    agentId: "agent-1",
  } as never);

  let pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ type: "Text", text: /└ Edit routes\.ts/, in: "pane" })).toBeDefined();
  await pane.unmount();
  let band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.find({ type: "Text", text: /작업자 1/, in: "band" })).toBeDefined();
  await band.unmount();

  await $.turn.complete({
    answer: "done",
    durationMs: 10,
    isAborted: false,
    turnId: "t1",
    agentId: "agent-1",
  } as never);
  pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ text: /Edit routes\.ts/, in: "pane" })).toBeUndefined();
  await pane.unmount();
  band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.find({ text: /작업자/, in: "band" })).toBeUndefined();
  await band.unmount();
});

test("a file older than this session's first Encela call is not shown", async ($, on) => {
  mock.clock(on, { now: 50_000 });
  // Written long before: it came with the project.
  world(on, { text: JSON.stringify(building(2000)) });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call(STEP);
  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ text: /할 일 앱/, in: "pane" })).toBeUndefined();
  // An Encela tool was called, so the view says that much.
  expect(await pane.find({ type: "Text", text: /부품|pieces/, in: "pane" })).toBeDefined();
  await pane.unmount();
});

test("a link where the file should be is not followed", async ($, on) => {
  mock.clock(on, { now: 1000 });
  world(on, { text: JSON.stringify(building(2000)), realPath: "/home/me/elsewhere.json" });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.tool.call(STEP);
  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ text: /할 일 앱/, in: "pane" })).toBeUndefined();
  await pane.unmount();
});

test("the view keeps up while a call is out", async ($, on) => {
  const clock = mock.clock(on, { now: 1000 });
  const file = { text: JSON.stringify({ ...building(2000), phase: "approval" }) };
  world(on, file);
  let answer: (() => void) | undefined;
  // The approval question stays open until the user answers.
  on("tool.call", { tool: "mcp__plugin_encela_encela__blueprint_approve" }, async () => {
    await new Promise<void>((resolve) => {
      answer = resolve;
    });
    return { result: {} };
  });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  const call = $.tool.call({
    tool: "mcp__plugin_encela_encela__blueprint_approve",
    id: "todo",
  } as never);
  await clock.advance(800);

  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.find({ type: "Text", text: /승인을 기다리는 중/, in: "band" })).toBeDefined();
  await band.unmount();
  answer?.();
  await call;
});
