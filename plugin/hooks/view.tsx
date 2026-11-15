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
import type { Act, Agent, Live, Tab } from "../types";
import { acted, actOf, canvas, settled, tabLabels } from "./canvas";
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
  OWN,
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
/** How often it is looked at after that, while a run still goes on by itself, and for how many looks. */
const SLOW = 5000;
const SLOW_LOOKS = 720;
/** A file dated later than this from now isn't the server's. */
const AHEAD = 60_000;
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
const acts = atom({ plugin: "encela", key: "acts" } as const, [] as Act[], { shape: "acts-1" });
const shown = atom({ plugin: "encela", key: "tab" } as const, "graph" as Tab, { shape: "tab-1" });
const since = atom({ plugin: "encela", key: "since" } as const, 0, { shape: "since-1" });
/** The project folder as it was when this session first called Encela: where the server writes. */
const where = atom({ plugin: "encela", key: "root" } as const, "", { shape: "root-1" });

/** The surfaces that can redraw a region by themselves: there the lines move. */
const moves = (surface: string) => surface === "terminal" || surface === "desktop";

/** Lines as plain data: a surface module's props hold no missing values. */
const plain = (lines: Line[]): Line[] => JSON.parse(JSON.stringify(lines)) as Line[];

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
/** The project folder then: the view reads no other, wherever the session goes. */
let home = "";
/** Encela tool calls that haven't answered yet. */
let inFlight = 0;
/** The pending look, and when it was asked for. */
let timer: { cancel: () => void } | undefined;
let timerAt = 0;
/** The file as it was last read, how often it then stood unchanged with no call out, and what it said. */
let stamp = "";
let still = 0;
let last: Live | null = null;
/** Looks are numbered as they start: one that started before the one last taken says nothing new. */
let looks = 0;
let taken = 0;

/**
 * The server's file, when it is the server's: a plain file where Encela
 * keeps it (a project can ship a `.encela` of its own, with links in it),
 * written since this session first called Encela and not dated ahead of
 * now. Undefined when there is nothing new to read.
 */
async function load(
  $: EngineInterface,
  from: number,
): Promise<{ state: Live; mark: string } | undefined> {
  try {
    if (!home) {
      home = (await read($, where)) || (await $.session.root());
      const root = home;
      await update($, where, () => root);
    }
    const path = `${home}/.encela/live.json`;
    const [folder, file, now] = await Promise.all([
      $.fs.stat(home, { resolve: true }),
      $.fs.stat(path, { resolve: true }),
      $.clock.now(),
    ]);
    if (file.kind !== "file" || file.size > MAX_BYTES || !folder.realPath || !file.realPath) {
      return undefined;
    }
    if (slashes(file.realPath) !== `${slashes(folder.realPath)}/.encela/live.json`) {
      return undefined;
    }
    const mark = `${file.mtimeMs}:${file.size}`;
    if (mark === stamp) return undefined;
    const state = parse(await $.fs.read(path));
    if (!state || state.at < from - 2000 || state.at > now + AHEAD) return undefined;
    return { state, mark };
  } catch {
    return undefined;
  }
}

async function refresh($: EngineInterface) {
  armed ??= await read($, since);
  const from = armed;
  if (!from) return;
  const mine = ++looks;
  const got = await load($, from);
  if (got === undefined) {
    // While a call is out the file may well stand: that is no sign of an end.
    if (inFlight === 0) still++;
    return;
  }
  if (mine < taken) return;
  taken = mine;
  stamp = got.mark;
  still = 0;
  last = got.state;
  const state = got.state;
  await update($, live, () => state);
}

/**
 * Looks again in a moment, and keeps looking while a call is out or a run is
 * going: often at first, slowly once nothing has changed for a while.
 */
async function watch($: EngineInterface) {
  try {
    const now = await $.clock.now();
    if (timer) {
      // A look that never came (a timer can be refused) doesn't stop the next.
      if (now - timerAt < 3 * SLOW) return;
      timer.cancel();
      timer = undefined;
    }
    const going = inFlight > 0 || (moving(last) && still < QUIET + SLOW_LOOKS);
    if (!going) return;
    timerAt = now;
    timer = $.clock.after(inFlight > 0 || still < QUIET ? EVERY : SLOW, () => {
      timer = undefined;
      void refresh($)
        .catch(() => {})
        .then(() => watch($));
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

/** How many turns of each loop have ended: a call's end counts only in the turn it began in. */
const turns = new Map<string, number>();

/** A loop's turn began, or ended. */
async function turn($: EngineInterface, id: string, begins: boolean) {
  armed ??= await read($, since);
  if (!armed) return;
  await update($, agents, (list) => (begins ? began(list, id) : ended(list, id)));
  // Whatever the loop was calling, it isn't any more.
  if (!begins) {
    turns.set(id, (turns.get(id) ?? 0) + 1);
    await update($, acts, (list) => settled(list, id));
  }
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
    await refresh($).catch(() => {});
    return {
      text: opened.isPlaced
        ? "The Encela view is open."
        : "The Encela view opens when there is room.",
    };
  });

  on("tool.call", async ($, e, next) => {
    const name = encelaTool(e.tool);
    const own = name !== null;
    const input = e as unknown as Record<string, unknown>;
    // Watching never stands in a call's way: whatever fails here, the call goes on.
    const watching = await note($, e.tool, input, e.agentId).catch(() => false);
    if (!watching) return next(e);
    // For the canvas: who reaches for what, while the call is out.
    const from = e.agentId ?? "main";
    let to: ReturnType<typeof actOf> = null;
    try {
      to = actOf(e.tool, input, name, OWN);
    } catch {}
    const during = turns.get(from) ?? 0;
    if (!own && !to) return next(e);
    if (to) await update($, acts, (list) => acted(list, from, to, 1)).catch(() => {});
    if (own) {
      inFlight++;
      void watch($);
    }
    try {
      return await next(e);
    } finally {
      // The answer waits for neither the canvas nor the view's reading.
      if (to && (turns.get(from) ?? 0) === during) {
        void update($, acts, (list) => acted(list, from, to, -1)).catch(() => {});
      }
      if (own) {
        inFlight--;
        still = 0;
        void refresh($)
          .catch(() => {})
          .then(() => watch($));
      }
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

  // The pane's surface module says which tab was chosen there: kept for the session.
  on("ui.message", async ($, e, next) => {
    const tab = (e.data as { tab?: unknown } | null)?.tab;
    if (e.requestId === PANE && (tab === "graph" || tab === "canvas")) {
      await update($, shown, () => tab).catch(() => {});
    }
    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const [state, loops, reached, tab, from, now] = await Promise.all([
      read($, live),
      read($, agents),
      read($, acts),
      read($, shown),
      read($, since),
      $.clock.now(),
    ]);
    const lang = state?.lang ?? guess();
    const columns = e.props.bodyColumns;
    const widget = e.props.placement === "widget";
    // One row goes to the tabs.
    const rows = e.props.scroll.bodyRows - (widget ? 0 : 1);
    const view = frame(state, loops, { rows, columns, now, lang, started: from > 0 });
    const table = $.ui.resolve(e);
    if (widget) {
      // The small form: the one line, or the first of the pane.
      const one: Line[] = [{ left: view.band.length ? view.band : (view.lines[0]?.left ?? []) }];
      if (moves(e.surface)) {
        const { Client } = table as Elements["terminal"];
        return (
          <Client
            key="pane"
            module="./motion.tsx"
            props={{ lines: plain(one), columns }}
            width="100%"
          />
        );
      }
      const { Text } = table;
      return (
        <Text wrap="truncate-end">
          {(one[0] as Line).left.map((s) => (
            <Text {...look(s)}>{s.text}</Text>
          ))}
        </Text>
      );
    }
    // The canvas keeps the head: what is being built, and where the flow stands.
    const head = view.lines.slice(0, Math.min(view.head, Math.max(0, rows - 1)));
    // A blank line under the head where the picture still has three rows.
    const gap = head.length && rows - head.length >= 4 ? 1 : 0;
    const picture: Line[] = [
      ...head,
      ...(gap ? [{ left: [] }] : []),
      ...canvas(state, loops, reached, {
        rows: Math.max(1, rows - head.length - gap),
        columns,
        lang,
      }),
    ];
    const labels = tabLabels(lang, columns);
    if (moves(e.surface)) {
      const { Client } = table as Elements["terminal"];
      return (
        <Client
          key="pane"
          module="./motion.tsx"
          props={{ lines: plain(view.lines), canvas: plain(picture), tab, labels, columns }}
          width="100%"
        />
      );
    }
    const { Box, Text, Progress, Button } = table;
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
    const choose = (to: Tab) => () => {
      void update($, shown, () => to).catch(() => {});
    };
    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="tab-graph"
            label={labels.graph}
            variant={tab === "graph" ? "primary" : "secondary"}
            onPress={choose("graph")}
          />
          <Text> </Text>
          <Button
            key="tab-canvas"
            label={labels.canvas}
            variant={tab === "canvas" ? "primary" : "secondary"}
            onPress={choose("canvas")}
          />
        </Box>
        {(tab === "canvas" ? picture : view.lines).map(row)}
      </Box>
    );
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
          props={{ lines: plain([{ left: band }]), columns: e.props.bodyColumns }}
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
