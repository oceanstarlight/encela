// The view inside Claude Code: a pane beside the chat and one line above the
// prompt that show where an Encela build stands (the flow, the blueprint's
// steps and who does them, the pieces in use, pipeline runs) and what each
// model loop is doing right now.
//
// It only watches. Encela's server writes `.encela/live.json` whenever
// something changes; this module reads that file after an Encela tool was
// called, and notes the tool calls of the main loop and of the subagents as
// they pass. Nothing here changes a call, and a session that never calls an
// Encela tool pays one check per call and nothing else.
//
// Where the surface can redraw a region by itself, the lines are handed to
// `motion.tsx`, which moves them (a spinner on what is in progress, a pulse
// on the phase the flow stands at, a flash on what just changed); elsewhere
// they are drawn as they stand.
import type { Elements, EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";
import type { Agent, Live } from "../types";
import type { Line, Seg } from "./model";
import {
  began,
  doing,
  encelaTool,
  ended,
  fit,
  frame,
  look,
  moving,
  oneLine,
  parse,
  seen,
  workerOf,
} from "./model";

const PANE = "encela";
const TITLE = "Encela";
const COMMAND = "encela-view";
/** How often the file is looked at again while something is going on, and how long nothing may change before the looking stops. */
const EVERY = 700;
const QUIET = 170;
/** The file is small: anything much larger isn't Encela's. */
const MAX_BYTES = 512 * 1024;

// Change a tag when the shape of what is kept changes: a value an earlier
// version stored outlives a reload, and is then read as the initial one.
const live = atom({ plugin: "encela", key: "live" } as const, null as Live | null, {
  shape: "live-1",
});
const agents = atom({ plugin: "encela", key: "agents" } as const, [] as Agent[], {
  shape: "agents-1",
});
const since = atom({ plugin: "encela", key: "since" } as const, 0, { shape: "since-1" });

/** The surfaces that can redraw a region by themselves: there the lines move. */
const moves = (surface: string) => surface === "terminal" || surface === "desktop";

const slashes = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/** The user's language as this computer says it, until the server's state does. */
function guess(): "ko" | "en" {
  try {
    return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "ko" : "en";
  } catch {
    return "en";
  }
}

// What a reload loses is only this: the timer, and what was last read.
/** When this session first used Encela; undefined until the kept value was read. */
let armed: number | undefined;
/** Encela tool calls that haven't answered yet. */
let inFlight = 0;
let timer: { cancel: () => void } | undefined;
/** The file as it was last read, how often it then stood unchanged, and what it said. */
let stamp = "";
let still = 0;
let last: Live | null = null;

/**
 * The server's file, when it is the server's: a plain file where Encela
 * keeps it (a project can ship a `.encela` of its own, with links in it),
 * written since this session first called Encela. Undefined when there is
 * nothing new to read.
 */
async function load($: EngineInterface, from: number): Promise<Live | null | undefined> {
  const root = await $.session.root();
  const path = `${root}/.encela/live.json`;
  try {
    const [home, file] = await Promise.all([
      $.fs.stat(root, { resolve: true }),
      $.fs.stat(path, { resolve: true }),
    ]);
    if (file.kind !== "file" || file.size > MAX_BYTES || !home.realPath || !file.realPath) {
      return undefined;
    }
    if (slashes(file.realPath) !== `${slashes(home.realPath)}/.encela/live.json`) {
      return undefined;
    }
    const mark = `${file.mtimeMs}:${file.size}`;
    if (mark === stamp) return undefined;
    const state = parse(await $.fs.read(path));
    if (!state || state.at < from - 2000) return undefined;
    stamp = mark;
    return state;
  } catch {
    return undefined;
  }
}

async function refresh($: EngineInterface) {
  armed ??= await read($, since);
  const from = armed;
  if (!from) return;
  const state = await load($, from);
  if (state === undefined) {
    still++;
    return;
  }
  still = 0;
  last = state;
  await update($, live, () => state);
}

/** Looks again in a moment, and keeps looking while a call is out or a run is going. */
function watch($: EngineInterface) {
  if (timer) return;
  try {
    timer = $.clock.after(EVERY, () => {
      timer = undefined;
      void refresh($)
        .catch(() => {})
        .then(() => {
          if (inFlight > 0 || (moving(last) && still < QUIET)) watch($);
        });
    });
  } catch {
    // No timer: the view then moves only when a call returns.
  }
}

/**
 * Notes a tool call of a model loop, once this session uses Encela: the
 * first call of an Encela tool starts the watching and opens the pane.
 * False while the session doesn't use Encela.
 */
async function note(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  agentId: string | undefined,
): Promise<boolean> {
  armed ??= await read($, since);
  if (!armed) {
    if (encelaTool(tool) === null) return false;
    const now = await $.clock.now();
    armed = now;
    await update($, since, () => now);
    // Unasked, the pane shows where there is room for it; `/encela-view` asks.
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => {});
  }
  const text = doing(tool, input);
  await update($, agents, (list) => seen(list, agentId ?? "main", { doing: text, done: false }));
  return true;
}

/** A subagent was started: which worker of the blueprint it is, by its brief. */
async function met($: EngineInterface, id: string, prompt: string, about: string) {
  armed ??= await read($, since);
  if (!armed) return;
  const patch = { worker: workerOf(prompt), about: fit(oneLine(about), 60) };
  await update($, agents, (list) => seen(list, id, patch));
}

/** A loop's turn began, or ended. */
async function turn($: EngineInterface, id: string, begins: boolean) {
  armed ??= await read($, since);
  if (armed) await update($, agents, (list) => (begins ? began(list, id) : ended(list, id)));
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show what Encela is building: the steps, the pieces and the workers",
    });
    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: TITLE });
    await refresh($);
    return {
      text: opened.isPlaced
        ? "The Encela view is open."
        : "The Encela view opens when there is room.",
    };
  });

  on("tool.call", async ($, e, next) => {
    const own = encelaTool(e.tool) !== null;
    // Watching never stands in a call's way: whatever fails here, the call goes on.
    const watching = await note(
      $,
      e.tool,
      e as unknown as Record<string, unknown>,
      e.agentId,
    ).catch(() => false);
    if (!own || !watching) return next(e);
    inFlight++;
    watch($);
    try {
      return await next(e);
    } finally {
      inFlight--;
      await refresh($).catch(() => {});
      if (moving(last)) watch($);
    }
  });

  on("agent.spawn", async ($, e, next) => {
    const started = await next(e);
    if ("agentId" in started && started.agentId) {
      await met($, started.agentId, e.prompt, e.description || e.subagentType).catch(() => {});
    }
    return started;
  });

  on("turn.start", async ($, e, next) => {
    await turn($, e.agentId ?? "main", true).catch(() => {});
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    await turn($, e.agentId ?? "main", false).catch(() => {});
    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const [state, loops, from, now] = await Promise.all([
      read($, live),
      read($, agents),
      read($, since),
      $.clock.now(),
    ]);
    const view = frame(state, loops, {
      rows: e.props.scroll.bodyRows,
      columns: e.props.bodyColumns,
      now,
      lang: guess(),
      started: from > 0,
    });
    // The small form: the one line, or the first of the pane.
    const lines: Line[] =
      e.props.placement === "widget"
        ? [{ left: view.band.length ? view.band : (view.lines[0]?.left ?? []) }]
        : view.lines;
    const table = $.ui.resolve(e);
    if (moves(e.surface)) {
      const { Client } = table as Elements["terminal"];
      return (
        <Client
          key="pane"
          module="./motion.tsx"
          props={{ lines, columns: e.props.bodyColumns }}
          width="100%"
        />
      );
    }
    const { Box, Text, Progress } = table;
    const run = (segs: Seg[]) => segs.map((s) => <Text {...look(s)}>{s.text}</Text>);
    const row = (line: Line) => {
      if (line.bar) {
        return (
          <Progress
            label={line.left.map((s) => s.text).join("") || TITLE}
            value={line.bar.done}
            max={Math.max(1, line.bar.total)}
            valueText={`${line.bar.done}/${line.bar.total}`}
          />
        );
      }
      if (!line.left.length && !line.right) return <Text> </Text>;
      return (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            {" ".repeat(line.indent ?? 0)}
            {run(line.left)}
          </Text>
          {line.right && <Text>{run(line.right)}</Text>}
        </Box>
      );
    };
    return <Box flexDirection="column">{lines.map(row)}</Box>;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const [state, from] = await Promise.all([read($, live), read($, since)]);
    if (!state && !from) return next(e);
    const [loops, now] = await Promise.all([read($, agents), $.clock.now()]);
    const { band } = frame(state, loops, {
      rows: 8,
      columns: e.props.bodyColumns,
      now,
      lang: guess(),
      started: from > 0,
    });
    if (!band.length) return next(e);
    const table = $.ui.resolve(e);
    if (moves(e.surface)) {
      const { Client } = table as Elements["terminal"];
      return (
        <Client
          key="band"
          module="./motion.tsx"
          props={{ lines: [{ left: band }], columns: e.props.bodyColumns }}
          width="100%"
        />
      );
    }
    const { Text } = table;
    return (
      <Text wrap="truncate-end">
        {band.map((s) => (
          <Text {...look(s)}>{s.text}</Text>
        ))}
      </Text>
    );
  });
};
