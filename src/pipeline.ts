// A pipeline: a chain of steps a blueprint declares and Encela runs inside
// the server, so data goes from piece to piece without passing through
// Claude. A step calls a tool of an MCP piece, transforms data with a jq
// expression, or hands a piece of work to Claude. This file is the shape of
// a pipeline, the checks done before anything runs, and the `{{ }}`
// references steps use to read each other's output.
import { compile, JqError, type Program } from "./jq";
import { check } from "./schema";
import type { KnownTool } from "./tools";

export type StepKind = "tool" | "transform" | "claude";

export interface PipelineInput {
  description: string;
  /** Used when the run gives no value; an input without one must be given. */
  default: unknown;
  required: boolean;
}

export interface PipelineStep {
  id: string;
  kind: StepKind;
  /** Tool step: a tool of an MCP piece of the blueprint, and its arguments (may hold references). */
  piece: string;
  tool: string;
  args: unknown;
  /** Tool step: a reference to a list; the step then runs once per element (`$item`, `$index`). */
  each: string;
  concurrency: number;
  /** Seconds one call may take. */
  timeout: number;
  /** Transform step: a jq program; `.` is `input`. */
  transform: string;
  /** Claude step: the instruction, and what the answer must be. */
  claude: string;
  expect: "text" | "json";
  schema: unknown;
  /** Transform step: the value of `.`. Claude step: named values handed over with the instruction. */
  input: unknown;
  /** A jq expression; the step is skipped when it gives false or null. */
  when: string;
  /** Extra attempts after a failure, and whether a final failure stops the run. */
  retry: number;
  onError: "stop" | "continue";
  /** Null: waits for the step listed before it. A list: waits only for these and for the steps it reads. */
  after: string[] | null;
}

export interface Pipeline {
  name: string;
  description: string;
  inputs: Record<string, PipelineInput>;
  steps: PipelineStep[];
  /** A reference: what the run reports as its result (the last step's text when empty). */
  output: string;
}

export const LIMITS = {
  pipelines: 20,
  steps: 50,
  concurrency: 8,
  retry: 5,
  /** Elements an `each` step takes. */
  items: 1000,
  /** Seconds. */
  timeout: 1800,
};
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT = 300;

/** A pipeline that can't be run as written, or a step that failed for a reason the author can fix. */
export class PipelineError extends Error {}

// References ---------------------------------------------------------------

/** Literal text and expressions, in order. */
export interface Template {
  parts: (string | Program)[];
  /** One expression and nothing else: its value keeps its type. */
  single: boolean;
}

const programs = new Map<string, Program>();

/** A compiled jq expression (kept, since the same one is evaluated many times). */
export function expression(source: string): Program {
  let p = programs.get(source);
  if (!p) {
    p = compile(source);
    if (programs.size > 2000) programs.clear();
    programs.set(source, p);
  }
  return p;
}

/** Whether a string has a `{{` that isn't escaped as `\{{`. */
export function hasReference(v: unknown): v is string {
  return typeof v === "string" && /(^|[^\\])\{\{/.test(v);
}

/**
 * Splits a string into text and `{{ expression }}` parts. An expression can
 * itself contain `}}` (an object in an object), so the end of each one is
 * the first `}}` at which what came before compiles. `\{{` is a literal `{{`.
 */
export function parseTemplate(text: string): Template {
  const parts: (string | Program)[] = [];
  let literal = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("{{", pos);
    if (open < 0) {
      literal += text.slice(pos);
      break;
    }
    if (open > 0 && text[open - 1] === "\\") {
      literal += `${text.slice(pos, open - 1)}{{`;
      pos = open + 2;
      continue;
    }
    literal += text.slice(pos, open);
    let program: Program | null = null;
    let firstError: unknown = null;
    let end = text.indexOf("}}", open + 2);
    while (end >= 0) {
      const inner = text.slice(open + 2, end).trim();
      if (inner) {
        try {
          program = expression(inner);
          break;
        } catch (e) {
          firstError ??= e;
        }
      }
      end = text.indexOf("}}", end + 1);
    }
    if (!program) {
      const shown = text.slice(open, open + 60);
      if (firstError instanceof Error) {
        throw new PipelineError(
          `the reference ${shown} isn't a valid expression: ${firstError.message}`,
        );
      }
      throw new PipelineError(`the reference ${shown} is empty or has no closing }}`);
    }
    if (literal) parts.push(literal);
    literal = "";
    parts.push(program);
    pos = end + 2;
  }
  if (literal) parts.push(literal);
  return { parts, single: parts.length === 1 && typeof parts[0] !== "string" };
}

/** What references and expressions can read. */
export interface Scope {
  inputs: Record<string, unknown>;
  /** The outputs of the steps finished so far, by id. */
  steps: Record<string, unknown>;
  item?: unknown;
  index?: number;
  project: string;
  run: { id: string; dir: string };
}

const VARIABLES = ["inputs", "steps", "item", "index", "project", "run"];

/**
 * The one value of an expression: none gives null, several are an error,
 * because a reference stands for exactly one thing.
 */
export function evaluate(program: Program, scope: Scope, input: unknown = scope.item ?? null) {
  let outputs: unknown[];
  try {
    outputs = program.run(input, {
      vars: {
        inputs: scope.inputs,
        steps: scope.steps,
        item: scope.item ?? null,
        index: scope.index ?? null,
        project: scope.project,
        run: scope.run,
      },
    });
  } catch (e) {
    if (e instanceof JqError) throw new PipelineError(`${program.source}: ${e.message}`);
    throw e;
  }
  if (outputs.length > 1) {
    throw new PipelineError(
      `${program.source}: gave ${outputs.length} values where one is needed; wrap it in [ ] to get them as one list`,
    );
  }
  return outputs.length ? outputs[0] : null;
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** A string with its references filled in. A string that is one reference gives that value as it is. */
export function renderString(text: string, scope: Scope): unknown {
  if (!text.includes("{{")) return text;
  const t = parseTemplate(text);
  if (t.single) return evaluate(t.parts[0] as Program, scope);
  return t.parts.map((p) => (typeof p === "string" ? p : asText(evaluate(p, scope)))).join("");
}

/** Any JSON value with the references in its strings filled in. Values that come from references are never scanned again. */
export function render(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return renderString(value, scope);
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope)]));
  }
  return value;
}

/** A `when` condition or other bare expression, with or without `{{ }}` around it. */
export function bare(text: string): string {
  const t = text.trim();
  return t.startsWith("{{") && t.endsWith("}}") ? t.slice(2, -2).trim() : t;
}

// Reading a pipeline before it runs ----------------------------------------

interface Reads {
  steps: Set<string>;
  inputs: Set<string>;
  /** `$steps` used as a whole: it then depends on every earlier step. */
  allSteps: boolean;
  item: boolean;
  unknown: Set<string>;
}

const noReads = (): Reads => ({
  steps: new Set(),
  inputs: new Set(),
  allSteps: false,
  item: false,
  unknown: new Set(),
});

function addReads(into: Reads, p: Program) {
  for (const v of p.freeVars) {
    if (!VARIABLES.includes(v)) into.unknown.add(v);
    if (v === "item" || v === "index") into.item = true;
  }
  for (const ref of p.refs) {
    const [root, name] = ref;
    if (root === "steps") {
      if (name === undefined) into.allSteps = true;
      else into.steps.add(name);
    } else if (root === "inputs" && name !== undefined) into.inputs.add(name);
  }
}

/** Every reference in the strings of a JSON value. */
function readsOf(value: unknown, into: Reads) {
  if (typeof value === "string") {
    if (value.includes("{{"))
      for (const p of parseTemplate(value).parts) if (typeof p !== "string") addReads(into, p);
  } else if (Array.isArray(value)) for (const v of value) readsOf(v, into);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) readsOf(v, into);
}

/** What a step reads; throws PipelineError on an expression that doesn't compile. */
function stepReads(s: PipelineStep): Reads {
  const r = noReads();
  const expr = (source: string) => {
    try {
      addReads(r, expression(source));
    } catch (e) {
      throw new PipelineError(`${source}: ${e instanceof Error ? e.message : e}`);
    }
  };
  if (s.when) expr(bare(s.when));
  if (s.kind === "tool") {
    readsOf(s.args, r);
    if (s.each) readsOf(s.each, r);
  } else if (s.kind === "transform") {
    expr(s.transform);
    readsOf(s.input, r);
  } else {
    readsOf(s.claude, r);
    readsOf(s.input, r);
  }
  return r;
}

/** The steps that must be finished before the step at `index` starts. */
export function prerequisites(p: Pipeline, index: number): string[] {
  const s = p.steps[index] as PipelineStep;
  const earlier = p.steps.slice(0, index).map((x) => x.id);
  const r = stepReads(s);
  if (r.allSteps) return earlier;
  const before = s.after === null ? earlier.slice(-1) : s.after;
  return [...new Set([...before, ...r.steps])].filter((id) => earlier.includes(id));
}

/** The tool calls a pipeline makes, each once. */
export function toolCalls(p: Pipeline): { piece: string; tool: string }[] {
  const seen = new Set<string>();
  const out: { piece: string; tool: string }[] = [];
  for (const s of p.steps) {
    if (s.kind !== "tool" || seen.has(`${s.piece}/${s.tool}`)) continue;
    seen.add(`${s.piece}/${s.tool}`);
    out.push({ piece: s.piece, tool: s.tool });
  }
  return out;
}

/** `piece/tool`: how an approved call is recorded. */
export const callKey = (piece: string, tool: string) => `${piece}/${tool}`;

/** Whether a tool may change things: anything its server doesn't mark as read-only, or that Encela hasn't seen yet. */
export function mayChange(tool: string, known: KnownTool[] | null): boolean {
  return !known?.find((t) => t.name === tool)?.readOnly;
}

/**
 * The problems of a tool step's arguments against the tool's schema.
 * Before a run, arguments that hold references aren't known yet and are
 * skipped; once rendered, everything is checked.
 */
export function argProblems(args: unknown, tool: KnownTool, rendered: boolean): string[] {
  if (!rendered && hasReference(args)) return [];
  return check(args, tool.inputSchema, "args", rendered ? {} : { unknown: hasReference });
}

// Normalising --------------------------------------------------------------

export interface PipelineContext {
  /** The blueprint's pieces by id: kind, name, and the tools the blueprint allows (all when empty). */
  pieces: Map<string, { kind: string; name: string; tools: string[] }>;
  /** The piece id for what the author wrote (an id or a bare name), or null. */
  resolve(ref: string): string | null;
  /** The tools a piece showed the last time it ran, or null when it never has. */
  known(pieceName: string): KnownTool[] | null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

function int(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
  what: string,
  problems: string[],
) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${what} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

/**
 * Pipelines from what Claude wrote: fills what is missing and collects
 * every problem, so one round fixes them all.
 */
export function normalizePipelines(
  raw: unknown,
  ctx: PipelineContext,
): { pipelines: Pipeline[]; problems: string[] } {
  const problems: string[] = [];
  const pipelines: Pipeline[] = [];
  const list = Array.isArray(raw) ? raw.filter(isObject) : [];
  if (list.length > LIMITS.pipelines) problems.push(`pipelines: at most ${LIMITS.pipelines}`);

  for (const r of list.slice(0, LIMITS.pipelines)) {
    const name = text(r.name);
    const at = `pipelines: ${name || "(unnamed)"}`;
    const say = (m: string) => problems.push(`${at}: ${m}`);
    if (!SLUG.test(name)) say("name must be lowercase letters, digits and dashes");
    if (pipelines.some((p) => p.name === name)) say("two pipelines have this name");

    const inputs: Record<string, PipelineInput> = {};
    for (const [key, v] of Object.entries(isObject(r.inputs) ? r.inputs : {})) {
      if (!IDENT.test(key)) {
        say(`input "${key}": names are letters, digits and underscores`);
        continue;
      }
      const spec = isObject(v) ? v : { description: v };
      const hasDefault = Object.hasOwn(spec, "default");
      inputs[key] = {
        description: text(spec.description),
        default: hasDefault ? spec.default : null,
        required: !hasDefault,
      };
    }

    const steps: PipelineStep[] = [];
    const rawSteps = Array.isArray(r.steps) ? r.steps.filter(isObject) : [];
    if (!rawSteps.length) say("steps is empty");
    if (rawSteps.length > LIMITS.steps) say(`at most ${LIMITS.steps} steps`);
    rawSteps.slice(0, LIMITS.steps).forEach((s, i) => {
      const id = text(s.id) || `s${i + 1}`;
      const here = (m: string) => say(`step ${id}: ${m}`);
      const local: string[] = [];
      if (!IDENT.test(id)) {
        here("id must be letters, digits and underscores (it is read as $steps.<id>)");
      }
      if (steps.some((x) => x.id === id)) here("two steps have this id");

      const kinds = (["tool", "transform", "claude"] as const).filter((k) => text(s[k]));
      if (kinds.length !== 1) {
        here(
          'needs exactly one of "tool" (with "piece"), "transform" (a jq program) or "claude" (an instruction)',
        );
        return;
      }
      const kind = kinds[0] as StepKind;
      const step: PipelineStep = {
        id,
        kind,
        piece: "",
        tool: "",
        args: {},
        each: "",
        concurrency: DEFAULT_CONCURRENCY,
        timeout: DEFAULT_TIMEOUT,
        transform: "",
        claude: "",
        expect: "text",
        schema: null,
        input: null,
        when: text(s.when),
        retry: int(s.retry, 0, 0, LIMITS.retry, "retry", local),
        onError: s.onError === "continue" ? "continue" : "stop",
        after: Array.isArray(s.after) ? s.after.map(text).filter(Boolean) : null,
      };
      if (s.onError !== undefined && s.onError !== "stop" && s.onError !== "continue") {
        local.push('onError is "stop" or "continue"');
      }

      if (kind === "tool") {
        step.tool = text(s.tool);
        const piece = ctx.resolve(text(s.piece));
        const entry = piece ? ctx.pieces.get(piece) : undefined;
        if (!piece || !entry) {
          local.push(
            `piece "${text(s.piece)}" isn't one of this blueprint's pieces (a tool step needs "piece" and "tool")`,
          );
        } else if (entry.kind !== "mcp") {
          local.push(
            `${piece} isn't an MCP server, so a pipeline can't call it; use a claude step`,
          );
        } else {
          step.piece = piece;
          if (entry.tools.length && !entry.tools.includes(step.tool)) {
            local.push(
              `the blueprint only allows ${piece}'s tools ${entry.tools.join(", ")}, not ${step.tool}`,
            );
          }
        }
        step.args = s.args ?? {};
        if (!isObject(step.args) && !hasReference(step.args)) {
          local.push("args must be an object (or one reference that gives an object)");
        }
        step.each = text(s.each);
        step.concurrency = int(
          s.concurrency,
          DEFAULT_CONCURRENCY,
          1,
          LIMITS.concurrency,
          "concurrency",
          local,
        );
        step.timeout = int(s.timeout, DEFAULT_TIMEOUT, 1, LIMITS.timeout, "timeout", local);
      } else {
        for (const k of ["each", "piece", "args"]) {
          if (s[k] !== undefined) local.push(`"${k}" belongs to tool steps only`);
        }
        if (kind === "transform") {
          step.transform = text(s.transform);
          step.input = s.input ?? null;
        } else {
          step.claude = text(s.claude);
          step.input = s.input ?? null;
          if (step.input !== null && !isObject(step.input)) {
            local.push("input must be an object of named values");
          }
          step.schema = isObject(s.schema) ? s.schema : null;
          step.expect =
            s.expect === "json" || (s.expect === undefined && step.schema) ? "json" : "text";
          if (s.expect !== undefined && s.expect !== "text" && s.expect !== "json") {
            local.push('expect is "text" or "json"');
          }
          if (step.retry) local.push("retry doesn't apply to a claude step");
        }
      }
      if (kind !== "claude" && (s.expect !== undefined || s.schema !== undefined)) {
        local.push('"expect" and "schema" belong to claude steps only');
      }

      // References: they must compile and read only what exists before this step.
      const earlier = steps.map((x) => x.id);
      try {
        if (step.each && !parseTemplate(step.each).single) {
          local.push(
            "each must be one reference that gives a list, e.g. {{ $steps.list.json.files }}",
          );
        }
        const reads = stepReads(step);
        for (const v of reads.unknown) {
          local.push(`$${v} doesn't exist; there are ${VARIABLES.map((x) => `$${x}`).join(", ")}`);
        }
        for (const ref of reads.steps) {
          if (ref === id) local.push("it reads its own output");
          else if (!earlier.includes(ref)) {
            local.push(`it reads $steps.${ref}, which isn't a step listed before it`);
          }
        }
        for (const ref of reads.inputs) {
          if (!Object.hasOwn(inputs, ref))
            local.push(`it reads $inputs.${ref}, which isn't in inputs`);
        }
        if (reads.item && !step.each) local.push("$item and $index exist only in a step with each");
      } catch (e) {
        local.push(e instanceof Error ? e.message : String(e));
      }
      for (const ref of step.after ?? []) {
        if (!earlier.includes(ref)) local.push(`after: "${ref}" isn't a step listed before it`);
      }

      // The tool itself, when the piece has run before.
      if (kind === "tool" && step.piece) {
        const known = ctx.known(ctx.pieces.get(step.piece)?.name ?? "");
        if (known) {
          const tool = known.find((t) => t.name === step.tool);
          if (!tool) {
            local.push(
              `${step.piece} has no tool "${step.tool}"; it has ${known.map((t) => t.name).join(", ")}`,
            );
          } else local.push(...argProblems(step.args, tool, false));
        }
      }

      for (const m of local) here(m);
      steps.push(step);
    });

    let output = text(r.output);
    if (output) {
      try {
        const reads = noReads();
        readsOf(output, reads);
        for (const ref of reads.steps) {
          if (!steps.some((s) => s.id === ref))
            say(`output reads $steps.${ref}, which isn't a step`);
        }
        for (const ref of reads.inputs) {
          if (!Object.hasOwn(inputs, ref))
            say(`output reads $inputs.${ref}, which isn't in inputs`);
        }
        if (reads.item) say("output can't read $item");
      } catch (e) {
        say(`output: ${e instanceof Error ? e.message : e}`);
        output = "";
      }
    }
    pipelines.push({ name, description: text(r.description), inputs, steps, output });
  }
  return { pipelines, problems };
}

/** A pipeline as lines of text for the user to read before approving. */
export function describe(p: Pipeline, changes: (piece: string, tool: string) => boolean): string[] {
  const out = [`- ${p.name}${p.description ? `: ${p.description}` : ""}`];
  const names = Object.keys(p.inputs);
  if (names.length) out.push(`  Inputs: ${names.join(", ")}`);
  p.steps.forEach((s, i) => {
    let what: string;
    if (s.kind === "tool") {
      const mark = changes(s.piece, s.tool) ? " (may change things)" : "";
      what = `calls ${s.piece} ${s.tool}${mark}${s.each ? ", once for each item of a list" : ""}`;
    } else if (s.kind === "transform") what = "reshapes data";
    else what = `asks Claude: ${s.claude.length > 100 ? `${s.claude.slice(0, 99)}…` : s.claude}`;
    out.push(`  ${i + 1}. ${s.id}: ${what}`);
  });
  return out;
}
