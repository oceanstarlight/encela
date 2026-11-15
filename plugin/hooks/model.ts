// What the view shows, worked out from the state alone: no drawing here, so
// it is tested without Claude Code. `frame` turns Encela's live state and
// what the subagents are doing into lines of styled text; `view.tsx` draws
// them, and where the surface can redraw by itself `motion.tsx` moves them:
// `meet`, `tickOn` and `paint` say how a line looks at each moment.
import type { Agent, Live, LiveEvent, LiveRun, LiveStep, Phase } from "../types";

export type Tone = "plain" | "dim" | "strong" | "good" | "bad" | "busy" | "wait";

export interface Seg {
  text: string;
  tone: Tone;
  /**
   * How it moves while work is going on: `spin` turns its first character (a
   * marker such as ●) into a spinner, `pulse` swells and fades the whole of it.
   */
  fx?: "spin" | "pulse";
  /** One of a few colours that tell the workers apart; over `tone`'s. */
  hue?: number;
}

export interface Line {
  left: Seg[];
  /** Kept at the right edge, e.g. who does a step. */
  right?: Seg[];
  /** Cells of indent. */
  indent?: number;
  /** Drawn as a progress bar labelled with `left`. `live` while work is going on: a light runs along it. */
  bar?: { done: number; total: number; live?: boolean };
  /** Names the line from one frame to the next, and `sig` says what state it shows: a line whose `sig` changes is lit for a moment. */
  key?: string;
  sig?: string;
}

export interface Frame {
  /** The pane's lines, top to bottom. */
  lines: Line[];
  /** One line for above the prompt; empty when there is nothing to say. */
  band: Seg[];
}

type Lang = "ko" | "en";

const STEP_KO: Record<string, string> = {
  doing: "시작",
  done: "완료",
  failed: "실패",
  todo: "대기",
};

const WORDS = {
  en: {
    idle: "Nothing is being built. Ask for something, or /encela:go <request>.",
    phases: {
      idle: "idle",
      pieces: "pieces",
      blueprint: "blueprint",
      approval: "approval",
      assemble: "assemble",
      build: "build",
      done: "done",
    },
    finding: "Looking for pieces",
    drafting: "Writing the blueprint",
    asking: "Waiting for your approval",
    assembling: "Approved: assembling the pieces",
    steps: "Steps",
    pieces: "Pieces",
    workers: "Workers",
    pipeline: "Pipeline",
    recent: "Recent",
    working: (n: number) => `${n} worker${n === 1 ? "" : "s"}`,
    more: (n: number) => `… ${n} more`,
    calls: (n: number) => `${n} call${n === 1 ? "" : "s"}`,
    documents: (n: number) => `${n} document${n === 1 ? "" : "s"}`,
    guides: (n: number) => `${n} tool guide${n === 1 ? "" : "s"}`,
    yourTurn: (step: string) => `waiting for Claude (${step})`,
    run: {
      running: "running",
      waiting: "waiting",
      done: "done",
      failed: "failed",
      cancelled: "stopped",
      interrupted: "interrupted",
    },
    relayed: "approved through Claude",
    event: {
      found: (e: LiveEvent) => `${e.how} pieces found: ${e.what}`,
      saved: () => "blueprint saved",
      asked: () => "asked for approval",
      approved: () => "approved",
      changes: () => "changes wanted",
      cancelled: () => "cancelled",
      assembled: (e: LiveEvent) => `assembled (${e.how} pieces)`,
      opened: (e: LiveEvent) => `${e.what} started (${e.how} tools)`,
      closed: (e: LiveEvent) => `${e.what} stopped`,
      step: (e: LiveEvent) => `${e.what}: ${e.how}`,
      run: (e: LiveEvent) => `pipeline ${e.what} ${e.how}`,
    },
  },
  ko: {
    idle: "지금 만드는 것이 없어요. 요청을 쓰거나 /encela:go <요청>을 써 보세요.",
    phases: {
      idle: "대기",
      pieces: "부품",
      blueprint: "설계도",
      approval: "승인",
      assemble: "조립",
      build: "만들기",
      done: "완료",
    },
    finding: "부품을 찾는 중",
    drafting: "설계도를 쓰는 중",
    asking: "승인을 기다리는 중",
    assembling: "승인됨: 부품을 조립하는 중",
    steps: "단계",
    pieces: "부품",
    workers: "작업자",
    pipeline: "파이프라인",
    recent: "최근",
    working: (n: number) => `작업자 ${n}`,
    more: (n: number) => `… ${n}개 더`,
    calls: (n: number) => `${n}회`,
    documents: (n: number) => `문서 ${n}`,
    guides: (n: number) => `도구 안내 ${n}`,
    yourTurn: (step: string) => `Claude 차례 (${step})`,
    run: {
      running: "실행 중",
      waiting: "대기",
      done: "완료",
      failed: "실패",
      cancelled: "멈춤",
      interrupted: "중단됨",
    },
    relayed: "Claude를 통해 승인",
    event: {
      found: (e: LiveEvent) => `부품 ${e.how}개 찾음: ${e.what}`,
      saved: () => "설계도 저장",
      asked: () => "승인 요청",
      approved: () => "승인됨",
      changes: () => "수정 요청",
      cancelled: () => "취소됨",
      assembled: (e: LiveEvent) => `조립 완료 (부품 ${e.how}개)`,
      opened: (e: LiveEvent) => `${e.what} 시작 (도구 ${e.how}개)`,
      closed: (e: LiveEvent) => `${e.what} 종료`,
      step: (e: LiveEvent) => `${e.what}: ${STEP_KO[e.how] ?? e.how}`,
      run: (e: LiveEvent) => `파이프라인 ${e.what} ${e.how === "started" ? "시작" : e.how}`,
    },
  },
};

const PHASES: Phase[] = ["idle", "pieces", "blueprint", "approval", "assemble", "build", "done"];
const ORDER: Phase[] = ["pieces", "blueprint", "approval", "assemble", "build"];
const DOCUMENTS = ["skill", "rule", "instruction", "subagent"];
const EVENT_KINDS = Object.keys(WORDS.en.event) as LiveEvent["kind"][];
/** How long the line above the prompt stays once a build is done. */
const DONE_FOR = 120_000;
/** The colours that tell workers apart: as many as the theme has apart from the ones that say how things stand. */
const HUES = 3;

const seg = (text: string, tone: Tone = "plain"): Seg => ({ text, tone });
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// --- widths: a terminal draws Korean, Chinese and Japanese two cells wide

function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  );
}

/** The cells a text takes in a terminal. */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) n += wide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return n;
}

/** `text` cut to at most `max` cells, with an ellipsis where it was cut. */
export function fit(text: string, max: number): string {
  if (cells(text) <= max) return text;
  if (max < 1) return "";
  let out = "";
  let n = 0;
  for (const ch of text) {
    const w = wide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (n + w > max - 1) break;
    out += ch;
    n += w;
  }
  return `${out}…`;
}

const width = (segs: Seg[] | undefined) => (segs ?? []).reduce((n, s) => n + cells(s.text), 0);

/** A line's left side cut so the whole line fits `columns`. */
function fitLine(line: Line, columns: number): Line {
  if (line.bar) return line;
  const right = width(line.right);
  let room = columns - (line.indent ?? 0) - (right ? right + 1 : 0);
  const left: Seg[] = [];
  for (const s of line.left) {
    if (room <= 0) break;
    const text = fit(s.text, room);
    left.push({ ...s, text });
    room -= cells(text);
  }
  return { ...line, left };
}

// --- reading what the server wrote: nothing is taken as it comes

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, max = 160) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const among = <T extends string>(v: unknown, of: readonly T[], or: T): T =>
  of.includes(v as T) ? (v as T) : or;

/** The live state in a file's text, or null when it isn't one. Sizes are bounded, unknown words replaced. */
export function parse(text: string): Live | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const o = rec(value);
  if (o.v !== 1) return null;
  const b = o.blueprint ? rec(o.blueprint) : null;
  return {
    v: 1,
    at: num(o.at),
    lang: among(o.lang, ["ko", "en"] as const, "en"),
    phase: among(o.phase, PHASES, "idle"),
    blueprint: b
      ? {
          id: str(b.id, 80),
          goal: str(b.goal, 300),
          status: among(
            b.status,
            ["draft", "approved", "assembled", "done", "cancelled"] as const,
            "draft",
          ),
          approval: str(b.approval, 20),
          steps: arr(b.steps, 60)
            .map(rec)
            .map((s) => ({
              id: str(s.id, 80),
              title: str(s.title),
              status: among(s.status, ["todo", "doing", "done", "failed"] as const, "todo"),
              worker: str(s.worker, 80),
              pipeline: str(s.pipeline, 80),
            })),
          workers: arr(b.workers, 20).map((w) => str(w, 80)),
        }
      : null,
    pieces: arr(o.pieces, 60)
      .map(rec)
      .map((p) => ({
        id: str(p.id, 120),
        name: str(p.name, 80),
        kind: str(p.kind, 20),
        running: p.running === true,
        busy: num(p.busy),
        calls: num(p.calls),
        last: str(p.last, 80),
        lastAt: num(p.lastAt),
      })),
    runs: arr(o.runs, 3)
      .map(rec)
      .map((r) => ({
        id: str(r.id, 80),
        pipeline: str(r.pipeline, 80),
        status: among(
          r.status,
          ["running", "waiting", "done", "failed", "cancelled", "interrupted"] as const,
          "interrupted",
        ),
        steps: arr(r.steps, 40)
          .map(rec)
          .map((s) => ({
            id: str(s.id, 40),
            kind: among(s.kind, ["tool", "transform", "claude"] as const, "tool"),
            state: among(
              s.state,
              ["todo", "running", "waiting", "done", "failed", "skipped"] as const,
              "todo",
            ),
            items: num(s.items),
            itemsDone: num(s.itemsDone),
          })),
      })),
    events: arr(o.events, 12)
      .map(rec)
      .map((e) => ({
        at: num(e.at),
        kind: among(e.kind, EVENT_KINDS, "saved"),
        what: str(e.what, 120),
        how: str(e.how, 40),
      })),
  };
}

/** True while the state can change without Claude doing anything: a run going, a piece answering. */
export function moving(live: Live | null): boolean {
  return (
    !!live && (live.runs.some((r) => r.status === "running") || live.pieces.some((p) => p.busy > 0))
  );
}

// --- what the model loops are doing

/** The worker a subagent was started as: the first line of its brief says. */
export function workerOf(prompt: string): string {
  return /^Worker "([^"\n]{1,80})":/m.exec(prompt)?.[1] ?? "";
}

/** The Encela tool behind a tool name Claude Code shows, or null: `mcp__plugin_encela_encela__find_pieces` → `find_pieces`. */
export function encelaTool(tool: string): string | null {
  return /^mcp__(?:plugin_encela_)?encela__(.+)$/.exec(tool)?.[1] ?? null;
}

const OWN = new Set([
  "find_pieces",
  "get_piece",
  "piece_add",
  "blueprint_save",
  "blueprint_get",
  "blueprint_approve",
  "blueprint_assemble",
  "blueprint_step",
  "piece_open",
  "piece_tools",
  "piece_call",
  "piece_close",
  "pipeline_run",
  "pipeline_resume",
  "pipeline_get",
]);

const base = (path: unknown) =>
  String(path ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? "";

/**
 * A tool call in a few words, for the line under a step: `Edit canvas.ts`,
 * `playwright · click`. `input` is the call as a hook sees it: the tool's
 * arguments beside `tool`, so an argument called `tool` (piece_call has
 * one) may not be there.
 */
export function doing(tool: string, input: Record<string, unknown>): string {
  const own = encelaTool(tool);
  let text: string;
  if (own !== null) {
    if (own === "piece_call") {
      const piece = String(input.id ?? "").replace(/^mcp:/, "");
      const called = typeof input.tool === "string" && input.tool !== tool ? input.tool : "";
      text = called ? `${piece} · ${called}` : piece || own;
    } else if (OWN.has(own)) {
      const about = input.pipeline ?? input.step ?? input.run ?? "";
      text = `${own}${typeof about === "string" && about ? ` ${about}` : ""}`;
    } else {
      // A tool of a running piece: `<piece>__<tool>`.
      const at = own.indexOf("__");
      text = at > 0 ? `${own.slice(0, at)} · ${own.slice(at + 2)}` : own;
    }
  } else if (tool.startsWith("mcp__")) {
    const [, server = "", ...rest] = tool.split("__");
    text = `${server.replace(/^plugin_/, "")} · ${rest.join("__")}`;
  } else if (["Read", "Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) {
    text = `${tool} ${base(input.file_path ?? input.notebook_path)}`;
  } else if (tool === "Bash") text = `$ ${String(input.command ?? "")}`;
  else if (tool === "Grep" || tool === "Glob") text = `${tool} ${String(input.pattern ?? "")}`;
  else if (tool === "Agent" || tool === "Task") text = `${tool} ${String(input.description ?? "")}`;
  else text = tool;
  return fit(oneLine(text), 60);
}

const AGENTS = 12;

/** `list` with the agent `id` changed by `patch` (added when new) and moved to the end; the oldest go past twelve. */
export function seen(list: readonly Agent[], id: string, patch: Partial<Agent>): Agent[] {
  const was = list.find((a) => a.id === id) ?? {
    id,
    worker: "",
    about: "",
    doing: "",
    done: false,
  };
  const kept = [...list.filter((a) => a.id !== id), { ...was, ...patch, id }];
  while (kept.length > AGENTS) {
    // The main loop stays whatever else comes and goes.
    const drop = kept.findIndex((a) => a.id !== "main" && a.id !== id);
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return kept;
}

/** `list` once a turn of `id` began: it is at work from then on, before its first tool call. */
export function began(list: readonly Agent[], id: string): Agent[] {
  const doing = list.find((a) => a.id === id)?.doing || "…";
  return seen(list, id, { doing, done: false });
}

/** `list` after the turn of `id` ended: a subagent is done, the main loop is between turns. */
export function ended(list: readonly Agent[], id: string): Agent[] {
  return list.map((a) =>
    a.id !== id ? a : id === "main" ? { ...a, doing: "" } : { ...a, done: true },
  );
}

// --- the frame

const GLYPH: Record<LiveStep["status"], Seg> = {
  done: seg("✓", "good"),
  doing: seg("●", "busy"),
  failed: seg("✗", "bad"),
  todo: seg("○", "dim"),
};

function runLine(run: LiveRun, working: boolean): Seg[] {
  const out: Seg[] = [];
  run.steps.forEach((s, i) => {
    if (i) out.push(seg(" › ", "dim"));
    const each = s.items ? `(${s.itemsDone}/${s.items})` : "";
    if (s.state === "done") out.push(seg(`✓${s.id}`, "good"));
    else if (s.state === "skipped") out.push(seg(`-${s.id}`, "dim"));
    else if (s.state === "running") {
      out.push({ ...seg(`●${s.id}${each}`, "busy"), ...(working ? { fx: "spin" as const } : {}) });
    } else if (s.state === "waiting") out.push({ ...seg(`◆${s.id}`, "wait"), fx: "pulse" });
    else if (s.state === "failed") out.push(seg(`✗${s.id}${each}`, "bad"));
    else out.push(seg(`○${s.id}`, "dim"));
  });
  return out;
}

const finished = (run: LiveRun) =>
  run.steps.filter((s) => s.state === "done" || s.state === "skipped").length;

export interface FrameOptions {
  /** Rows and cells there are to draw into. */
  rows: number;
  columns: number;
  now: number;
  /** The language to use until the server's state says which. */
  lang?: Lang;
  /** True once an Encela tool was called in this session: with no state yet, pieces are being looked for. */
  started?: boolean;
}

/**
 * The view for a state. `read` is null until the server's file was read in
 * this session. What doesn't fit `rows` is dropped from the least telling
 * end: recent events first, then pieces one by one, then steps far from the
 * ones in progress.
 */
export function frame(read: Live | null, agents: readonly Agent[], opts: FrameOptions): Frame {
  const lang: Lang = read?.lang ?? opts.lang ?? "en";
  const w = WORDS[lang];
  const columns = Math.max(20, opts.columns);
  // A search for pieces writes nothing into a project that has no `.encela` yet.
  const live: Live | null =
    read ??
    (opts.started
      ? {
          v: 1,
          at: opts.now,
          lang,
          phase: "pieces",
          blueprint: null,
          pieces: [],
          runs: [],
          events: [],
        }
      : null);
  if (!live || live.phase === "idle" || (!live.blueprint && live.phase !== "pieces")) {
    return { lines: [{ left: [seg(w.idle, "dim")] }], band: [] };
  }
  const b = live.blueprint;
  const active = agents.filter((a) => !a.done);
  // Motion says that something is going on, so nothing moves once Claude's
  // turn is over and no run or call is out: a step left "doing" then stands still.
  const working = active.some((a) => a.doing !== "") || moving(live);
  const spin = (s: Seg): Seg => (working ? { ...s, fx: "spin" } : s);
  const hueOf = (worker: string) => {
    const i = b?.workers.indexOf(worker) ?? -1;
    return i < 0 ? undefined : i % HUES;
  };

  // --- the head: what is being built, and where the flow stands
  const head: Line[] = [];
  if (b) head.push({ left: [seg(oneLine(b.goal), "strong")] });
  const at = live.phase === "done" ? ORDER.length : ORDER.indexOf(live.phase);
  const strip: Seg[] = [];
  // The phase the flow stands at swells and fades: while Claude works, and while the user is asked.
  const beat = working || live.phase === "approval";
  ORDER.forEach((p, i) => {
    if (i) strip.push(seg(" › ", "dim"));
    const tone: Tone = i < at ? "good" : i === at ? "busy" : "dim";
    const here = seg(`${i < at ? "✓" : i === at ? "●" : "○"} ${w.phases[p]}`, tone);
    strip.push(i === at && beat ? { ...here, fx: "pulse" } : here);
  });
  // Too narrow for the whole strip: the phase alone.
  const alone = seg(`● ${w.phases[live.phase]}`, live.phase === "done" ? "good" : "busy");
  head.push({
    left:
      width(strip) <= columns
        ? strip
        : [live.phase !== "done" && beat ? { ...alone, fx: "pulse" } : alone],
    key: "flow",
    sig: live.phase,
  });
  const saying =
    live.phase === "pieces"
      ? w.finding
      : live.phase === "blueprint"
        ? w.drafting
        : live.phase === "approval"
          ? w.asking
          : live.phase === "assemble"
            ? w.assembling
            : "";
  if (saying) {
    head.push({
      left: [
        live.phase === "approval" ? { ...seg(saying, "wait"), fx: "pulse" } : seg(saying, "plain"),
      ],
    });
  }

  // --- steps, each with who does it and what that one is doing now
  const steps: Line[][] = [];
  const total = b?.steps.length ?? 0;
  const done = b?.steps.filter((s) => s.status === "done").length ?? 0;
  const shown = new Set<string>();
  for (const s of b?.steps ?? []) {
    const own = !s.worker || s.worker === "main";
    const hue = own ? undefined : hueOf(s.worker);
    const block: Line[] = [
      {
        left: [
          s.status === "doing" ? spin(GLYPH.doing) : GLYPH[s.status],
          seg(` ${oneLine(s.title)}`, s.status === "todo" ? "dim" : "plain"),
        ],
        right: own ? undefined : [{ ...seg(s.worker, "dim"), hue }],
        indent: 1,
        key: `step:${s.id}`,
        sig: s.status,
      },
    ];
    if (s.status === "doing") {
      for (const a of active.filter((x) => (own ? x.id === "main" : x.worker === s.worker))) {
        shown.add(a.id);
        if (a.doing) block.push({ left: [{ ...seg(`└ ${a.doing}`, "dim"), hue }], indent: 3 });
      }
      const run = s.pipeline ? live.runs.find((r) => r.pipeline === s.pipeline) : undefined;
      if (run) {
        block.push({
          left: [seg(`└ ${s.pipeline} ${finished(run)}/${run.steps.length}`, "dim")],
          indent: 3,
        });
      }
    }
    steps.push(block);
  }

  // --- subagents at work that no step in progress names
  const loose = active.filter((a) => a.id !== "main" && !shown.has(a.id));
  const workers: Line[] = loose.map((a) => ({
    left: [
      a.doing ? spin(seg("●", "busy")) : seg("●", "busy"),
      { ...seg(` ${a.worker || a.about || a.id}`), hue: hueOf(a.worker) },
    ],
    right: a.doing ? [seg(fit(a.doing, Math.max(8, Math.floor(columns / 2))), "dim")] : undefined,
    indent: 1,
  }));

  // --- pieces: the servers one by one, the rest counted
  const servers = live.pieces.filter((p) => p.kind === "mcp");
  let pieces: Line[] = servers.map((p) => ({
    left: [
      p.busy
        ? { ...seg("●", "busy"), fx: "spin" as const }
        : seg(p.running ? "●" : "○", p.running ? "good" : "dim"),
      seg(` ${p.name}`, p.running ? "plain" : "dim"),
    ],
    right: p.calls
      ? [seg(p.busy ? p.last : `${p.last} · ${w.calls(p.calls)}`, p.busy ? "busy" : "dim")]
      : undefined,
    indent: 1,
    key: `piece:${p.name}`,
    sig: p.running ? "on" : "off",
  }));
  const documents = live.pieces.filter((p) => DOCUMENTS.includes(p.kind)).length;
  const guides = live.pieces.filter((p) => p.kind === "cli" || p.kind === "library").length;
  const others = [documents ? w.documents(documents) : "", guides ? w.guides(guides) : ""]
    .filter(Boolean)
    .join(" · ");
  if (others) pieces.push({ left: [seg(`+ ${others}`, "dim")], indent: 1 });

  // --- pipeline runs
  const runs: Line[] = [];
  for (const r of live.runs) {
    const tone: Tone =
      r.status === "failed"
        ? "bad"
        : r.status === "waiting"
          ? "wait"
          : r.status === "done"
            ? "good"
            : r.status === "running"
              ? "busy"
              : "dim";
    runs.push({
      left: [seg(`${w.pipeline} ${r.pipeline}`, "strong")],
      right: [seg(`${finished(r)}/${r.steps.length} · ${w.run[r.status]}`, tone)],
      key: `run:${r.id}`,
      sig: r.status,
    });
    runs.push({
      left: runLine(r, r.status === "running"),
      indent: 1,
      key: `chain:${r.id}`,
      sig: r.steps.map((s) => s.state[0]).join(""),
    });
  }

  // --- what happened lately, newest first
  let events: Line[] = live.events
    .slice(-4)
    .reverse()
    .map((e) => ({ left: [seg(w.event[e.kind](e), "dim")], indent: 1 }));

  // --- fitting it into the rows there are
  const gap: Line = { left: [] };
  const title = (text: string): Line => ({ left: [seg(text, "strong")] });
  const count = (blocks: Line[][]) => blocks.reduce((n, x) => n + x.length, 0);
  let shownSteps = steps;
  const size = () =>
    head.length +
    (shownSteps.length ? count(shownSteps) + 3 : 0) +
    (workers.length ? workers.length + 2 : 0) +
    (pieces.length ? pieces.length + 2 : 0) +
    (runs.length ? runs.length + 1 : 0) +
    (events.length ? events.length + 2 : 0);
  const rows = Math.max(8, opts.rows);
  if (size() > rows) events = [];
  if (size() > rows && pieces.length > 1) {
    const up = servers.filter((p) => p.running).length;
    pieces = [
      {
        left: [
          seg(`● ${up}/${servers.length}`, up ? "good" : "dim"),
          seg(others ? ` + ${others}` : "", "dim"),
        ],
        indent: 1,
      },
    ];
  }
  let hidden = 0;
  if (size() > rows && b) {
    // Keep the steps around the first one that isn't done.
    const first = Math.max(
      0,
      b.steps.findIndex((s) => s.status !== "done"),
    );
    const room = Math.max(3, rows - (size() - count(steps)) - 1);
    let from = Math.max(0, first - 1);
    let to = from;
    let used = 0;
    while (to < steps.length && used + (steps[to] as Line[]).length <= room) {
      used += (steps[to] as Line[]).length;
      to++;
    }
    while (from > 0 && used + (steps[from - 1] as Line[]).length <= room) {
      from--;
      used += (steps[from] as Line[]).length;
    }
    shownSteps = steps.slice(from, Math.max(to, from + 1));
    hidden = steps.length - shownSteps.length;
  }
  const stepLines = shownSteps.flat();
  if (hidden) stepLines.push({ left: [seg(w.more(hidden), "dim")], indent: 1 });

  const lines: Line[] = [...head];
  if (stepLines.length) {
    lines.push(
      gap,
      {
        left: [seg(w.steps, "strong")],
        // The light runs while the build is being worked on, not while the user is asked.
        bar: {
          done,
          total,
          ...(working && live.phase === "build" && done < total ? { live: true } : {}),
        },
        key: "bar",
        sig: String(done),
      },
      ...stepLines,
    );
  }
  if (workers.length) lines.push(gap, title(w.workers), ...workers);
  if (pieces.length) lines.push(gap, title(w.pieces), ...pieces);
  if (runs.length) lines.push(gap, ...runs);
  if (events.length) lines.push(gap, title(w.recent), ...events);

  // --- the one line above the prompt
  let band: Seg[] = [seg("Encela ▸ ", "strong")];
  const waiting = live.runs.flatMap((r) =>
    r.steps.filter((s) => s.state === "waiting").map((s) => s.id),
  );
  if (live.phase === "approval") band.push({ ...seg(w.asking, "wait"), fx: "pulse" });
  else if (live.phase === "build" || live.phase === "done") {
    const tone: Tone = live.phase === "done" ? "good" : "plain";
    if (live.phase === "build" && working) band.push({ ...seg("● ", "busy"), fx: "spin" });
    band.push(seg(`${w.phases[live.phase]} ${done}/${total}`, tone));
    const helpers = active.filter((a) => a.id !== "main").length;
    if (helpers) band.push(seg(` · ${w.working(helpers)}`, "busy"));
    for (const r of live.runs.filter((x) => x.status === "running" || x.status === "waiting")) {
      band.push(seg(` · ${r.pipeline} ${finished(r)}/${r.steps.length}`, "plain"));
    }
    if (waiting.length) band.push(seg(` · ${w.yourTurn(waiting.join(", "))}`, "wait"));
  } else {
    if (working) band.push({ ...seg("● ", "busy"), fx: "spin" });
    band.push(seg(saying || w.phases[live.phase], "plain"));
  }
  if (b?.approval === "relayed" && live.phase !== "approval" && live.phase !== "done") {
    band.push(seg(` · ${w.relayed}`, "dim"));
  }
  // A finished build leaves the line after a while.
  if (live.phase === "done" && opts.now - live.at > DONE_FOR) band = [];

  return {
    lines: lines.map((l) => fitLine(l, columns)),
    band: fitLine({ left: band }, columns).left,
  };
}

// --- motion: how the lines look from one moment to the next
//
// Where the surface can redraw a region by itself (`motion.tsx`), a clock
// ticks while something is going on: markers of what is in progress turn,
// the phase the flow stands at swells and fades, a light runs along the
// progress bar, and a line whose state just changed is lit for a moment.
// When nothing moves the clock asks for no redraw.

/** Milliseconds between two ticks. */
export const TICK = 120;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Ticks a changed line stays lit; the first few of them at full strength. */
const LIT = 12;
const LIT_FULL = 4;
/** Ticks of a pulse. */
const BEAT = 10;
/** Ticks without anything new after which the motion rests (ten minutes): work that stopped without saying so. */
const STALE = 5000;

export interface Motion {
  tick: number;
  /** The state each named line showed last, and the tick at which it last changed. */
  sigs: Record<string, string>;
  lit: Record<string, number>;
  /** What the lines were, and the tick at which they last differed. */
  digest: string;
  since: number;
  /** True when something in the lines moves, and when the next tick has anything to redraw. */
  fx: boolean;
  live: boolean;
}

const alive = (m: Motion) =>
  (m.fx && m.tick - m.since < STALE) || Object.values(m.lit).some((t) => m.tick - t < LIT);

const said = (segs: Seg[] | undefined) =>
  (segs ?? []).map((s) => `${s.text}\u0001${s.tone}${s.fx ?? ""}${s.hue ?? ""}`).join("\u0002");

/** The motion for these lines, after `was`: the same object when the lines are the same. */
export function meet(was: Motion | undefined, lines: readonly Line[]): Motion {
  const digest = lines
    .map(
      (l) =>
        `${said(l.left)}\u0003${said(l.right)}\u0003${l.sig ?? ""}\u0003${
          l.bar ? `${l.bar.done}/${l.bar.total}/${l.bar.live ? 1 : 0}` : ""
        }`,
    )
    .join("\n");
  if (was && was.digest === digest) return was;
  const tick = was?.tick ?? 0;
  const sigs: Record<string, string> = {};
  const lit: Record<string, number> = {};
  for (const l of lines) {
    if (!l.key) continue;
    const sig = l.sig ?? "";
    sigs[l.key] = sig;
    const before = was?.sigs[l.key];
    const at = was?.lit[l.key];
    // A line that is new is not lit: only one that was there and changed.
    if (before !== undefined && before !== sig) lit[l.key] = tick;
    else if (at !== undefined && tick - at < LIT) lit[l.key] = at;
  }
  const fx = lines.some(
    (l) => l.bar?.live || l.left.some((s) => s.fx) || (l.right ?? []).some((s) => s.fx),
  );
  const next: Motion = { tick, sigs, lit, digest, since: tick, fx, live: false };
  next.live = alive(next);
  return next;
}

/** The motion one tick later. */
export function tickOn(m: Motion): Motion {
  const next = { ...m, tick: m.tick + 1 };
  next.live = alive(next);
  return next;
}

/** A run of text drawn one way. */
export interface Cell {
  text: string;
  tone: Tone;
  hue?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

const BAR_MIN = 6;
const BAR_MAX = 28;

/** A line as it looks at this moment: `left` from the left edge (after the indent), `right` at the right edge. */
export function paint(line: Line, m: Motion, columns: number): { left: Cell[]; right: Cell[] } {
  const at = line.key === undefined ? undefined : m.lit[line.key];
  const age = at === undefined ? LIT : m.tick - at;
  const lit = age < LIT;
  const right: Cell[] = (line.right ?? []).map((s) => ({ text: s.text, tone: s.tone, hue: s.hue }));
  if (line.bar) {
    const { done, total } = line.bar;
    const label = line.left.map((s) => s.text).join("");
    const figure = `${done}/${total}`;
    const room = Math.max(BAR_MIN, Math.min(BAR_MAX, columns - cells(label) - cells(figure) - 2));
    const filled = total > 0 ? Math.min(room, Math.round((done / total) * room)) : 0;
    // The light crosses the bar, then stays away for a moment.
    const light = line.bar.live && m.live ? m.tick % (room + 10) : -1;
    const full = total > 0 && done >= total;
    const left: Cell[] = [{ text: `${label} `, tone: "strong" }];
    for (let i = 0; i < room; i++) {
      const cell: Cell =
        i < filled
          ? { text: i === light ? "▓" : "█", tone: full ? "good" : "busy", bold: lit }
          : { text: i === light ? "▒" : "░", tone: i === light ? "busy" : "dim" };
      const last = left[left.length - 1] as Cell;
      // Cells drawn alike are one run.
      if (left.length > 1 && last.tone === cell.tone && last.bold === cell.bold) {
        last.text += cell.text;
      } else left.push(cell);
    }
    left.push({ text: ` ${figure}`, tone: lit ? "strong" : "dim" });
    return { left, right };
  }
  const beat = m.tick % BEAT;
  const left: Cell[] = line.left.map((s) => {
    const cell: Cell = { text: s.text, tone: s.tone, hue: s.hue };
    if (s.fx === "spin" && m.live) {
      const [, ...rest] = s.text;
      cell.text = `${SPIN[m.tick % SPIN.length]}${rest.join("")}`;
    }
    if (s.fx === "pulse" && m.live) {
      if (beat < 3) cell.bold = true;
      else if (beat >= 5 && beat < 8) cell.dim = true;
    }
    if (lit && s.text.trim() !== "") {
      if (age < LIT_FULL) cell.inverse = true;
      else cell.bold = true;
    }
    return cell;
  });
  return { left, right };
}

const TONE_COLOR: Record<Tone, string | undefined> = {
  plain: undefined,
  dim: undefined,
  strong: undefined,
  good: "success",
  bad: "error",
  busy: "suggestion",
  wait: "warning",
};
// Teal, lavender and blue in Claude Code's themes: none is the colour of done, in progress, waiting or failed.
const HUE_COLOR = ["planMode", "autoAccept", "ide"];

/** How a run of text is drawn, in the words Claude Code's Text takes: a colour of the theme, dim, bold, inverse. */
export function look(cell: {
  tone: Tone;
  hue?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}): { color?: string; dimColor?: boolean; bold?: boolean; inverse?: boolean } {
  const color = cell.hue === undefined ? TONE_COLOR[cell.tone] : HUE_COLOR[cell.hue % HUES];
  const out: { color?: string; dimColor?: boolean; bold?: boolean; inverse?: boolean } = {};
  if (color) out.color = color;
  if (cell.dim || (cell.tone === "dim" && !cell.bold && !cell.inverse && cell.hue === undefined)) {
    out.dimColor = true;
  }
  if (cell.bold || cell.tone === "strong") out.bold = true;
  if (cell.inverse) out.inverse = true;
  return out;
}
