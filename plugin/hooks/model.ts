// What the view shows, worked out from the state alone: no drawing here, so
// it is tested without Claude Code. `frame` turns Encela's live state and
// what the subagents are doing into lines of styled text; `view.tsx` draws
// them.
import type { Agent, Live, LiveEvent, LiveRun, LiveStep, Phase } from "../types";

export type Tone = "plain" | "dim" | "strong" | "good" | "bad" | "busy" | "wait";

export interface Seg {
  text: string;
  tone: Tone;
}

export interface Line {
  left: Seg[];
  /** Kept at the right edge, e.g. who does a step. */
  right?: Seg[];
  /** Cells of indent. */
  indent?: number;
  /** Drawn as a progress bar labelled with `left`; takes two rows. */
  bar?: { done: number; total: number };
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

function runLine(run: LiveRun): Seg[] {
  const out: Seg[] = [];
  run.steps.forEach((s, i) => {
    if (i) out.push(seg(" ", "dim"));
    const each = s.items ? `(${s.itemsDone}/${s.items})` : "";
    if (s.state === "done") out.push(seg(`✓${s.id}`, "good"));
    else if (s.state === "skipped") out.push(seg(`-${s.id}`, "dim"));
    else if (s.state === "running") out.push(seg(`●${s.id}${each}`, "busy"));
    else if (s.state === "waiting") out.push(seg(`◆${s.id}`, "wait"));
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

  // --- the head: what is being built, and where the flow stands
  const head: Line[] = [];
  if (b) head.push({ left: [seg(oneLine(b.goal), "strong")] });
  const at = live.phase === "done" ? ORDER.length : ORDER.indexOf(live.phase);
  const strip: Seg[] = [];
  ORDER.forEach((p, i) => {
    if (i) strip.push(seg(" › ", "dim"));
    const tone: Tone = i < at ? "good" : i === at ? "busy" : "dim";
    strip.push(seg(`${i < at ? "✓" : i === at ? "●" : "○"} ${w.phases[p]}`, tone));
  });
  // Too narrow for the whole strip: the phase alone.
  head.push(
    width(strip) <= columns
      ? { left: strip }
      : { left: [seg(`● ${w.phases[live.phase]}`, live.phase === "done" ? "good" : "busy")] },
  );
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
  if (saying) head.push({ left: [seg(saying, live.phase === "approval" ? "wait" : "plain")] });

  // --- steps, each with who does it and what that one is doing now
  const steps: Line[][] = [];
  const total = b?.steps.length ?? 0;
  const done = b?.steps.filter((s) => s.status === "done").length ?? 0;
  const shown = new Set<string>();
  for (const s of b?.steps ?? []) {
    const block: Line[] = [
      {
        left: [GLYPH[s.status], seg(` ${oneLine(s.title)}`, s.status === "todo" ? "dim" : "plain")],
        right: s.worker && s.worker !== "main" ? [seg(s.worker, "dim")] : undefined,
        indent: 1,
      },
    ];
    if (s.status === "doing") {
      const own = !s.worker || s.worker === "main";
      for (const a of active.filter((x) => (own ? x.id === "main" : x.worker === s.worker))) {
        shown.add(a.id);
        if (a.doing) block.push({ left: [seg(`└ ${a.doing}`, "dim")], indent: 3 });
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
    left: [seg("●", "busy"), seg(` ${a.worker || a.about || a.id}`)],
    right: a.doing ? [seg(fit(a.doing, Math.max(8, Math.floor(columns / 2))), "dim")] : undefined,
    indent: 1,
  }));

  // --- pieces: the servers one by one, the rest counted
  const servers = live.pieces.filter((p) => p.kind === "mcp");
  let pieces: Line[] = servers.map((p) => ({
    left: [
      seg(p.running ? "●" : "○", p.busy ? "busy" : p.running ? "good" : "dim"),
      seg(` ${p.name}`, p.running ? "plain" : "dim"),
    ],
    right: p.calls
      ? [seg(p.busy ? p.last : `${p.last} · ${w.calls(p.calls)}`, p.busy ? "busy" : "dim")]
      : undefined,
    indent: 1,
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
    });
    runs.push({ left: runLine(r), indent: 1 });
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
    lines.push(gap, { left: [seg(w.steps, "strong")], bar: { done, total } }, ...stepLines);
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
  if (live.phase === "approval") band.push(seg(w.asking, "wait"));
  else if (live.phase === "build" || live.phase === "done") {
    const tone: Tone = live.phase === "done" ? "good" : "plain";
    band.push(seg(`${w.phases[live.phase]} ${done}/${total}`, tone));
    const working = active.filter((a) => a.id !== "main").length;
    if (working) band.push(seg(` · ${w.working(working)}`, "busy"));
    for (const r of live.runs.filter((x) => x.status === "running" || x.status === "waiting")) {
      band.push(seg(` · ${r.pipeline} ${finished(r)}/${r.steps.length}`, "plain"));
    }
    if (waiting.length) band.push(seg(` · ${w.yourTurn(waiting.join(", "))}`, "wait"));
  } else band.push(seg(saying || w.phases[live.phase], "plain"));
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
