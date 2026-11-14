// A blueprint: what a request needs before anything is built. Claude writes
// it (the goal, the pieces and why, who does which step), the user approves
// or changes it, and only then are the pieces assembled.
// Kept in the project as `.encela/blueprints/<id>.json`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectHome } from "./paths";
import { cautions, isDocument, type Piece } from "./piece";
import {
  describe,
  type Marks,
  markedSteps,
  marksOf,
  normalizePipelines,
  type Pipeline,
} from "./pipeline";
import { type Registry, writeJson } from "./registry";
import type { ToolCache } from "./tools";

export type Status = "draft" | "approved" | "assembled" | "done" | "cancelled";
export type StepStatus = "todo" | "doing" | "done" | "failed";
export const MAIN = "main";

export interface BlueprintPiece {
  /** A piece id from the registry. */
  piece: string;
  /** What it does in this build, and why it was picked. */
  role: string;
  why: string;
  /** Documents: how the working copy should be changed for this build. */
  adapt: string;
  /** MCP servers: the only tools to expose (all when empty) and extra environment values. */
  tools: string[];
  env: Record<string, string>;
}

export interface Worker {
  name: string;
  role: string;
}

export interface Step {
  id: string;
  title: string;
  detail: string;
  /** A worker's name, or `main` for the orchestrator itself. */
  worker: string;
  pieces: string[];
  /** Steps that must be done first. */
  after: string[];
  /** The pipeline that does this step, when one does. */
  pipeline: string;
  status: StepStatus;
  note: string;
}

export interface Choice {
  question: string;
  options: string[];
  answer: string;
}

export interface Blueprint {
  version: 1;
  id: string;
  status: Status;
  /** The user's request as written, and what it comes down to. */
  request: string;
  goal: string;
  requirements: string[];
  pieces: BlueprintPiece[];
  workers: Worker[];
  steps: Step[];
  /** What the user is asked to decide when approving. */
  choices: Choice[];
  /** Chains of tool calls Encela runs itself, passing data from piece to piece (src/pipeline.ts). */
  pipelines: Pipeline[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  /** What the user said when approving or asking for changes. */
  approvalNote: string;
  /**
   * How it was approved: `direct` when the user answered Encela's own
   * question, `relayed` when Claude passed the answer on. Pipelines with
   * marked steps run only after a direct approval.
   */
  approval: "" | "direct" | "relayed";
  /** Fingerprints of the pipeline steps the user saw marked (may change things, may reach outside) when approving. */
  approvedCalls: string[];
}

/** The marks of a piece's tool, from what the piece showed the last time it ran. */
export function marker(registry: Registry, tools?: ToolCache) {
  return (piece: string, tool: string): Marks => {
    const p = registry.find(piece);
    return marksOf(tool, p && tools ? tools.load(p.name, p.config) : null);
  };
}

/** The fingerprints of a blueprint's marked pipeline steps, as things are now. */
export function markedCalls(b: Blueprint, registry: Registry, tools?: ToolCache): string[] {
  return markedSteps(b.pipelines ?? [], marker(registry, tools)).map((m) => m.print);
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
const objects = (v: unknown) =>
  (Array.isArray(v) ? v : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x),
  );

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return out || "build";
}

/** What decides which pieces run and how: changing it needs the user's approval again. */
const fingerprint = (b: Blueprint) =>
  JSON.stringify(b.pieces.map((p) => [p.piece, p.tools, p.env]).sort());

/**
 * A blueprint from what Claude wrote. Fills what is missing, checks it
 * against the registry and throws with everything that is wrong, so one
 * round fixes it.
 */
export function normalizeBlueprint(
  raw: unknown,
  registry: Registry,
  previous: Blueprint | null,
  now = new Date(),
  tools?: ToolCache,
): Blueprint {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A blueprint is a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const goal = text(r.goal);
  if (!goal) problems.push("goal is missing: one sentence on what will exist when this is done");

  const pieces: BlueprintPiece[] = [];
  const known = new Map<string, Piece>();
  for (const p of objects(r.pieces)) {
    const found = registry.find(text(p.piece ?? p.id));
    if (!found) {
      problems.push(
        `pieces: no piece "${text(p.piece ?? p.id)}" (ids come from find_pieces; add an outside one with piece_add first)`,
      );
      continue;
    }
    if (known.has(found.id)) continue;
    known.set(found.id, found);
    const tools = list(p.tools);
    if (tools.length && found.kind !== "mcp") {
      problems.push(`pieces: ${found.id} isn't an MCP server, so it has no tools to limit`);
    }
    if (!text(p.role)) problems.push(`pieces: ${found.id} has no role in this build`);
    pieces.push({
      piece: found.id,
      role: text(p.role),
      why: text(p.why),
      adapt: isDocument(found.kind) ? text(p.adapt) : "",
      tools,
      env:
        p.env && typeof p.env === "object"
          ? Object.fromEntries(
              Object.entries(p.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
          : {},
    });
  }

  const workers: Worker[] = [];
  for (const w of objects(r.workers)) {
    const name = text(w.name);
    if (!name || name === MAIN) {
      problems.push(`workers: a worker needs a name other than "${MAIN}"`);
    } else if (workers.some((x) => x.name === name)) {
      problems.push(`workers: two workers are named ${name}`);
    } else workers.push({ name, role: text(w.role) });
  }

  // Left out, the pipelines stay as they were; they are still checked against the pieces as they are now.
  const checked = normalizePipelines(
    r.pipelines === undefined ? previous?.pipelines : r.pipelines,
    {
      pieces: new Map(
        pieces.map((p) => {
          const piece = known.get(p.piece) as Piece;
          return [p.piece, { kind: piece.kind, name: piece.name, tools: p.tools }];
        }),
      ),
      resolve: (ref) => {
        const found = registry.find(ref);
        return found && known.has(found.id) ? found.id : null;
      },
      known: (id) => {
        const piece = known.get(id);
        return piece && tools ? tools.load(piece.name, piece.config) : null;
      },
    },
  );
  problems.push(...checked.problems);
  const pipelines = checked.pipelines;

  const steps: Step[] = [];
  const before = new Map((previous?.steps ?? []).map((s) => [s.id, s]));
  objects(r.steps).forEach((s, i) => {
    const id = text(s.id) || `s${i + 1}`;
    if (steps.some((x) => x.id === id)) {
      problems.push(`steps: two steps have the id ${id}`);
      return;
    }
    const title = text(s.title);
    if (!title) problems.push(`steps: ${id} has no title`);
    const worker = text(s.worker) || MAIN;
    if (worker !== MAIN && !workers.some((w) => w.name === worker)) {
      problems.push(`steps: ${id} is for the worker "${worker}", which isn't in workers`);
    }
    const uses: string[] = [];
    for (const ref of list(s.pieces)) {
      const found = registry.find(ref);
      if (found && known.has(found.id)) uses.push(found.id);
      else problems.push(`steps: ${id} uses "${ref}", which isn't in this blueprint's pieces`);
    }
    const pipeline = text(s.pipeline);
    if (pipeline && !pipelines.some((p) => p.name === pipeline)) {
      problems.push(`steps: ${id} names the pipeline "${pipeline}", which isn't in pipelines`);
    }
    const status = text(s.status) as StepStatus;
    const old = before.get(id);
    steps.push({
      id,
      title,
      detail: text(s.detail),
      worker,
      pieces: uses,
      after: list(s.after),
      pipeline,
      status: ["todo", "doing", "done", "failed"].includes(status)
        ? status
        : (old?.status ?? "todo"),
      note: text(s.note) || (old?.note ?? ""),
    });
  });
  if (!steps.length) problems.push("steps is empty: list what will be done, in order");
  for (const s of steps) {
    for (const a of s.after) {
      if (a === s.id || !steps.some((x) => x.id === a)) {
        problems.push(`steps: ${s.id} comes after "${a}", which isn't another step`);
      }
    }
  }
  if (!problems.length && cyclic(steps)) {
    problems.push("steps: the after links go round in a circle");
  }
  const choices: Choice[] = objects(r.choices)
    .map((c) => ({ question: text(c.question), options: list(c.options), answer: text(c.answer) }))
    .filter((c) => c.question);

  if (problems.length) {
    throw new Error(`The blueprint has problems:\n- ${problems.join("\n- ")}`);
  }

  const stamp = now.toISOString();
  const blueprint: Blueprint = {
    version: 1,
    id: previous?.id ?? `${slug(text(r.id) || goal)}-${stamp.slice(0, 10).replaceAll("-", "")}`,
    status: previous?.status ?? "draft",
    request: text(r.request) || (previous?.request ?? ""),
    goal,
    requirements: list(r.requirements),
    pieces,
    workers,
    steps,
    choices,
    pipelines,
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
    approvedAt: previous?.approvedAt ?? null,
    approvalNote: previous?.approvalNote ?? "",
    approval: previous?.approval ?? "",
    approvedCalls: previous?.approvedCalls ?? [],
  };
  // The user approved certain pieces, tools and settings, and certain marked
  // pipeline calls with their arguments. Anything else: ask again.
  const unseen = markedCalls(blueprint, registry, tools).filter(
    (print) => !blueprint.approvedCalls.includes(print),
  );
  if (
    previous &&
    previous.status !== "draft" &&
    (fingerprint(previous) !== fingerprint(blueprint) || unseen.length)
  ) {
    blueprint.status = "draft";
  }
  if (blueprint.status === "cancelled") blueprint.status = "draft";
  // A finished blueprint that got more to do is being built again.
  if (blueprint.status === "done" && steps.some((s) => s.status !== "done")) {
    blueprint.status = "assembled";
  }
  if (blueprint.status === "draft") {
    blueprint.approvedAt = null;
    blueprint.approval = "";
    blueprint.approvedCalls = [];
  }
  return blueprint;
}

/** Records the user's approval: when, how, and which marked pipeline calls they were shown. */
export function approve(
  b: Blueprint,
  how: "direct" | "relayed",
  registry: Registry,
  tools?: ToolCache,
) {
  b.status = "approved";
  b.approvedAt = new Date().toISOString();
  b.approval = how;
  b.approvedCalls = markedCalls(b, registry, tools);
}

function cyclic(steps: Step[]): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    const s = steps.find((x) => x.id === id);
    if (s?.after.some(visit)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some((s) => visit(s.id));
}

/** The pieces no step names: they apply to the whole build (a rule, an instruction). */
export function shared(b: Blueprint): string[] {
  return b.pieces.map((p) => p.piece).filter((id) => !b.steps.some((s) => s.pieces.includes(id)));
}

/** The steps that can start now: not begun, with everything before them done. */
export function ready(b: Blueprint): Step[] {
  const done = new Set(b.steps.filter((s) => s.status === "done").map((s) => s.id));
  return b.steps.filter((s) => s.status === "todo" && s.after.every((a) => done.has(a)));
}

export const progress = (b: Blueprint) =>
  `${b.steps.filter((s) => s.status === "done").length}/${b.steps.length} steps done`;

/**
 * The blueprint as text for the user to read before approving: what will be
 * built, with which pieces and why, what each one runs, and who does what.
 */
export function render(b: Blueprint, registry: Registry, brief = false, tools?: ToolCache): string {
  const out: string[] = [`# Blueprint: ${b.goal}`, `id ${b.id} · ${b.status} · ${progress(b)}`];
  if (b.request && !brief) out.push("", `Request: ${b.request}`);
  if (b.requirements.length && !brief) {
    out.push("", "## Requirements", ...b.requirements.map((r) => `- ${r}`));
  }
  out.push("", `## Pieces (${b.pieces.length})`);
  if (!b.pieces.length) out.push("None: Claude builds this with what it already has.");
  for (const bp of b.pieces) {
    const p = registry.find(bp.piece);
    if (!p) {
      out.push(`- ${bp.piece} (no longer in the registry)`);
      continue;
    }
    out.push(`- ${p.title.en} (${p.id}): ${bp.role}`);
    if (bp.why && !brief) out.push(`  Why: ${bp.why}`);
    if (bp.adapt && !brief) out.push(`  Adapted for this build: ${bp.adapt}`);
    if (bp.tools.length) out.push(`  Only these tools: ${bp.tools.join(", ")}`);
    for (const c of cautions(p)) out.push(`  ! ${c}`);
  }
  if (b.workers.length && !brief) {
    out.push("", "## Workers", ...b.workers.map((w) => `- ${w.name}: ${w.role}`));
  }
  out.push("", `## Steps (${b.steps.length})`);
  b.steps.forEach((s, i) => {
    if (brief) {
      out.push(`${i + 1}. ${s.title}`);
      return;
    }
    const mark = { todo: " ", doing: "~", done: "x", failed: "!" }[s.status];
    const who = s.worker === MAIN ? "" : ` [${s.worker}]`;
    const uses = s.pieces.length ? ` (uses ${s.pieces.join(", ")})` : "";
    const after = s.after.length ? ` (after ${s.after.join(", ")})` : "";
    const runs = s.pipeline ? ` (runs the pipeline ${s.pipeline})` : "";
    out.push(`${i + 1}. [${mark}] ${s.id}${who} ${s.title}${uses}${runs}${after}`);
    if (s.detail) out.push(`   ${s.detail}`);
    if (s.note) out.push(`   Note: ${s.note}`);
  });
  const pipelines = b.pipelines ?? [];
  if (pipelines.length) {
    // Shown in the short form too: this is what runs without further questions.
    out.push(
      "",
      `## Pipelines (${pipelines.length})`,
      "Encela runs these chains of tool calls itself, without asking again. Calls that may change things or reach outside are marked, with their arguments.",
    );
    for (const p of pipelines) out.push(...describe(p, marker(registry, tools)));
  }
  if (b.choices.length) {
    out.push("", "## For you to decide");
    for (const c of b.choices) {
      const options = c.options.length ? ` (${c.options.join(" / ")})` : "";
      out.push(`- ${c.question}${options}${c.answer ? ` → ${c.answer}` : ""}`);
    }
  }
  return out.join("\n");
}

/** A project's blueprints on disk. */
export class Blueprints {
  private dir: string;

  constructor(private project: string) {
    this.dir = join(projectHome(project), "blueprints");
  }

  private file(id: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" isn't a blueprint id`);
    return join(this.dir, `${id}.json`);
  }

  load(id: string): Blueprint | null {
    const file = this.file(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Blueprint;
  }

  get(id: string): Blueprint {
    const b = this.load(id);
    if (!b)
      throw new Error(`No blueprint "${id}" in this project. See blueprint_get without an id.`);
    return b;
  }

  /** Every blueprint, the one changed last first. */
  list(): Blueprint[] {
    if (!existsSync(this.dir)) return [];
    const all: Blueprint[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        all.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Blueprint);
      } catch {
        // A file that isn't a blueprint is left alone.
      }
    }
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The blueprint being built, if one is. */
  active(): Blueprint | null {
    return this.list().find((b) => b.status === "approved" || b.status === "assembled") ?? null;
  }

  save(b: Blueprint) {
    mkdirSync(this.dir, { recursive: true });
    // Blueprints and working copies are this user's; they stay out of git unless the user wants them in.
    const ignore = join(dirname(this.dir), ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    writeJson(this.file(b.id), b);
  }

  /** A new id that isn't taken: `base`, `base-2`, ... */
  freeId(base: string): string {
    let id = base;
    for (let n = 2; this.load(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Where a blueprint's working copies go. */
  buildDir(id: string) {
    this.file(id);
    return join(projectHome(this.project), "build", id);
  }
}
