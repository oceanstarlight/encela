// A pipeline: a chain of steps a blueprint declares and Encela runs inside
// the server, so data goes from piece to piece without passing through
// Claude. A step calls a tool of an MCP piece, reshapes data with a jq
// program, or hands a piece of work to Claude. This file is the shape of a
// pipeline, the checks done before anything runs, the `{{ }}` references
// steps use to read each other's output, and what the user is shown and
// asked to approve. The specification is docs/pipeline-design.md.
import { createHash } from "node:crypto";
import { compile, type Program } from "./jq";
import { check, typeOf } from "./schema";
import type { KnownTool } from "./tools";

export type StepKind = "tool" | "transform" | "claude";
export const INPUT_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export interface PipelineInput {
  description: string;
  /** Checked, and a numeric or boolean string converted, when the run starts; any value when empty. */
  type: InputType | "";
  /** Used when the run gives no value; an input without one must be given. */
  default: unknown;
  required: boolean;
}

export interface PipelineStep {
  id: string;
  kind: StepKind;
  /** Tool step: a tool of an MCP piece of the blueprint, and its arguments (strings may hold references). */
  piece: string;
  tool: string;
  args: unknown;
  /** Tool step: a jq expression that gives a list; the step runs once per element (`$item`, `$index`). */
  each: string;
  /** Calls of an `each` step in flight at once; 0 picks 4 for a read-only tool and 1 otherwise. */
  concurrency: number;
  /** Seconds one call may take. */
  timeout: number;
  /** Transform step: a jq program, and the expression whose value is its `.`. */
  transform: string;
  from: string;
  /** Claude step: the instruction (no references), named values handed over with it, and what the answer must be. */
  claude: string;
  input: Record<string, unknown>;
  expect: "text" | "json";
  schema: unknown;
  /** A jq expression; the step is skipped when it gives false, null or nothing. */
  when: string;
  /** Extra attempts after a failure, and whether a final failure stops the run. */
  retry: number;
  onError: "stop" | "continue";
  /** Wait only for the steps it reads and those in `after`, instead of every step listed before it. */
  parallel: boolean;
  /** Earlier steps to wait for as well. */
  after: string[];
}

export interface Pipeline {
  name: string;
  description: string;
  inputs: Record<string, PipelineInput>;
  steps: PipelineStep[];
  /** A string with references: what the run reports as its result (the last step's text when empty). */
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
const DEFAULT_TIMEOUT = 300;

/** A pipeline that can't be run as written, or a step that failed for a reason its author can fix. */
export class PipelineError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// References ---------------------------------------------------------------

const programs = new Map<string, Program>();

/** A compiled jq expression. Compiling checks it; running it happens in the sandbox. */
export function expression(source: string): Program {
  let p = programs.get(source);
  if (!p) {
    p = compile(source);
    if (programs.size > 2000) programs.clear();
    programs.set(source, p);
  }
  return p;
}

/** Literal text and expressions, in order. */
export interface Template {
  parts: (string | Program)[];
  /** One expression and nothing else: its value keeps its type. */
  single: boolean;
}

export const hasReference = (v: unknown): v is string => typeof v === "string" && v.includes("{{");

/**
 * Splits a string into text and `{{ expression }}` parts. An expression can
 * itself contain `}}` (an object in an object), so each one ends at the
 * first `}}` at which what came before is a valid expression. A literal
 * `{{` is written `{{ "{{" }}`.
 */
export function parseTemplate(text: string): Template {
  const parts: (string | Program)[] = [];
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("{{", pos);
    if (open < 0) break;
    let program: Program | null = null;
    let first: unknown = null;
    let end = text.indexOf("}}", open + 2);
    while (end >= 0) {
      const inner = text.slice(open + 2, end).trim();
      if (inner) {
        try {
          program = expression(inner);
          break;
        } catch (e) {
          first ??= e;
        }
      }
      end = text.indexOf("}}", end + 1);
    }
    if (!program) {
      const shown = text.slice(open, open + 60);
      throw new PipelineError(
        first
          ? `the reference ${shown} isn't a valid expression: ${message(first)} (a literal {{ is written {{ "{{" }})`
          : `the reference ${shown} is empty or has no closing }}`,
      );
    }
    if (open > pos) parts.push(text.slice(pos, open));
    parts.push(program);
    pos = end + 2;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return { parts, single: parts.length === 1 && typeof parts[0] !== "string" };
}

/** A whole-expression field (`each`, `when`, `from`): bare jq, with one pair of `{{ }}` around it tolerated. */
export function bare(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{{") || !t.endsWith("}}")) return t;
  try {
    const parsed = parseTemplate(t);
    if (parsed.single) return (parsed.parts[0] as Program).source;
  } catch {
    // Not a wrapped expression: it is checked as written.
  }
  return t;
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

/** Runs a program away from the server's thread and gives all its outputs (src/sandbox.ts). */
export type Evaluator = (
  source: string,
  input: unknown,
  vars: Record<string, unknown>,
) => Promise<unknown[]>;

/**
 * The variables a program reads, and of `$steps` only the parts it reads:
 * they are copied to the sandbox, and step outputs can be large.
 */
export function varsFor(p: Program, scope: Scope): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const all: Record<string, unknown> = {
    inputs: scope.inputs,
    item: scope.item ?? null,
    index: scope.index ?? null,
    project: scope.project,
    run: scope.run,
  };
  for (const name of p.freeVars) if (Object.hasOwn(all, name)) vars[name] = all[name];
  if (!p.freeVars.includes("steps")) return vars;
  const refs = p.refs.filter((r) => r[0] === "steps");
  if (refs.some((r) => r.length < 2)) {
    vars.steps = scope.steps;
    return vars;
  }
  const steps: Record<string, unknown> = {};
  for (const [, id, field] of refs as [string, string, string | undefined][]) {
    const out = scope.steps[id];
    if (field === undefined || !isObject(out)) steps[id] = out ?? null;
    else if (steps[id] !== out) {
      const part = isObject(steps[id]) ? (steps[id] as Record<string, unknown>) : {};
      steps[id] = { ...part, [field]: Object.hasOwn(out, field) ? out[field] : null };
    }
  }
  vars.steps = steps;
  return vars;
}

/**
 * The one value of an expression. A reference stands for exactly one
 * thing, so several values are an error, and so is none (except where the
 * caller says none means something, as in `when`).
 */
export async function evaluate(
  run: Evaluator,
  source: string,
  scope: Scope,
  input: unknown = scope.item ?? null,
  none?: { value: unknown },
): Promise<unknown> {
  const program = expression(source);
  let outputs: unknown[];
  try {
    outputs = await run(source, input, varsFor(program, scope));
  } catch (e) {
    throw new PipelineError(`${source}: ${message(e)}`);
  }
  if (outputs.length === 1) return outputs[0];
  if (!outputs.length) {
    if (none) return none.value;
    throw new PipelineError(
      `${source}: gave no value (a select or .[] that matched nothing?); add a default with // or wrap it in [ ]`,
    );
  }
  throw new PipelineError(
    `${source}: gave ${outputs.length} values where one is needed; wrap it in [ ] to get them as one list`,
  );
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Any JSON value with the references in its strings filled in. A string
 * that is one reference gives that value as it is. Values that come from
 * references are never scanned again.
 */
export async function render(run: Evaluator, value: unknown, scope: Scope): Promise<unknown> {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const t = parseTemplate(value);
    if (t.single) return evaluate(run, (t.parts[0] as Program).source, scope);
    let out = "";
    for (const p of t.parts) {
      out += typeof p === "string" ? p : asText(await evaluate(run, p.source, scope));
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await render(run, v, scope));
    return out;
  }
  if (isObject(value)) {
    const out: [string, unknown][] = [];
    for (const [k, v] of Object.entries(value)) out.push([k, await render(run, v, scope)]);
    return Object.fromEntries(out);
  }
  return value;
}

// Reading a pipeline before it runs ----------------------------------------

interface Reads {
  /** Step ids, each with the fields read from it (empty when the whole output is read). */
  steps: Map<string, Set<string>>;
  inputs: Set<string>;
  /** `$steps` used as a whole: it then depends on every earlier step. */
  allSteps: boolean;
  item: boolean;
  unknown: Set<string>;
}

const noReads = (): Reads => ({
  steps: new Map(),
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
  for (const [root, name, field] of p.refs) {
    if (root === "steps") {
      if (name === undefined) into.allSteps = true;
      else {
        const fields = into.steps.get(name) ?? new Set();
        if (field !== undefined) fields.add(field);
        into.steps.set(name, fields);
      }
    } else if (root === "inputs" && name !== undefined) into.inputs.add(name);
  }
}

/** Every reference in the strings of a JSON value. */
function readsOf(value: unknown, into: Reads) {
  if (typeof value === "string") {
    if (!value.includes("{{")) return;
    for (const p of parseTemplate(value).parts) if (typeof p !== "string") addReads(into, p);
  } else if (Array.isArray(value)) for (const v of value) readsOf(v, into);
  else if (isObject(value)) for (const v of Object.values(value)) readsOf(v, into);
}

/** What a step reads, apart from its `when`. Throws PipelineError on something that doesn't compile. */
function stepReads(s: PipelineStep): Reads {
  const r = noReads();
  const expr = (source: string) => {
    try {
      addReads(r, expression(source));
    } catch (e) {
      throw new PipelineError(`${source}: ${message(e)}`);
    }
  };
  if (s.kind === "tool") {
    readsOf(s.args, r);
    if (s.each) expr(s.each);
  } else if (s.kind === "transform") {
    expr(s.transform);
    if (s.from) expr(s.from);
  } else readsOf(s.input, r);
  return r;
}

function whenReads(s: PipelineStep): Reads {
  const r = noReads();
  if (s.when) addReads(r, expression(s.when));
  return r;
}

/** The steps that must be finished before the step at `index` starts. */
export function prerequisites(p: Pipeline, index: number): string[] {
  const s = p.steps[index] as PipelineStep;
  const earlier = p.steps.slice(0, index).map((x) => x.id);
  if (!s.parallel) return earlier;
  const reads = stepReads(s);
  const when = whenReads(s);
  if (reads.allSteps || when.allSteps) return earlier;
  return [...new Set([...s.after, ...reads.steps.keys(), ...when.steps.keys()])].filter((id) =>
    earlier.includes(id),
  );
}

/**
 * The steps whose being skipped skips this one too: those it reads, unless
 * its own `when` looks at their `skipped`.
 */
export function skipsWith(s: PipelineStep): string[] {
  const handled = new Set<string>();
  for (const [id, fields] of whenReads(s).steps) if (fields.has("skipped")) handled.add(id);
  return [...stepReads(s).steps.keys()].filter((id) => !handled.has(id));
}

// Approval -----------------------------------------------------------------

/** What makes a tool call something the user must have seen. */
export interface Marks {
  /** It may change things: its server doesn't say it only reads. */
  changes: boolean;
  /** It may reach outside this computer: its server doesn't say it stays inside. */
  outside: boolean;
}

/** The marks of a tool. One Encela has never seen has both. */
export function marksOf(tool: string, known: KnownTool[] | null): Marks {
  const t = known?.find((x) => x.name === tool);
  return { changes: !t?.readOnly, outside: !t || t.openWorld };
}

/** What an approval of a marked step covers: the piece, the tool, its arguments as written, and what it iterates. */
export function stepPrint(s: PipelineStep): string {
  return createHash("sha256")
    .update(JSON.stringify([s.piece, s.tool, s.args, s.each]))
    .digest("hex")
    .slice(0, 16);
}

/** The marked tool steps of some pipelines, with their fingerprints. */
export function markedSteps(
  pipelines: Pipeline[],
  marks: (piece: string, tool: string) => Marks,
): { pipeline: string; step: PipelineStep; marks: Marks; print: string }[] {
  const out = [];
  for (const p of pipelines) {
    for (const step of p.steps) {
      if (step.kind !== "tool") continue;
      const m = marks(step.piece, step.tool);
      if (m.changes || m.outside)
        out.push({ pipeline: p.name, step, marks: m, print: stepPrint(step) });
    }
  }
  return out;
}

/** A pipeline as lines of text for the user to read before approving. */
export function describe(p: Pipeline, marks: (piece: string, tool: string) => Marks): string[] {
  const out = [`- ${p.name}${p.description ? `: ${p.description}` : ""}`];
  const inputs = Object.entries(p.inputs).map(
    ([name, i]) => `${name}${i.required ? "" : ` (default ${JSON.stringify(i.default)})`}`,
  );
  if (inputs.length) out.push(`  Inputs chosen when it runs: ${inputs.join(", ")}`);
  p.steps.forEach((s, i) => {
    const n = `  ${i + 1}. ${s.id}:`;
    if (s.kind === "transform") out.push(`${n} reshapes data`);
    else if (s.kind === "claude") out.push(`${n} asks Claude: ${s.claude}`);
    else {
      const m = marks(s.piece, s.tool);
      const tags = `${m.changes ? " [may change things]" : ""}${m.outside ? " [may reach outside]" : ""}`;
      out.push(
        `${n} calls ${s.piece} ${s.tool}${tags}${s.each ? `, once for each of ${s.each}` : ""}`,
      );
      // What a marked call does is in its arguments: the user sees them as written.
      if (m.changes || m.outside) out.push(`     with ${JSON.stringify(s.args)}`);
    }
  });
  return out;
}

// Checking and normalising -------------------------------------------------

/**
 * The problems of a tool step's arguments against the tool's schema.
 * Before a run, values that hold references aren't known yet and are
 * skipped; once rendered, everything is checked.
 */
export function argProblems(args: unknown, tool: KnownTool, rendered: boolean): string[] {
  if (!rendered && hasReference(args)) return [];
  return check(args, tool.inputSchema, "args", {
    unknown: rendered ? undefined : hasReference,
    strict: true,
  });
}

/** An input's value as its declared type, converting a numeric or boolean string; throws when it doesn't fit. */
export function coerce(value: unknown, type: InputType | "", name: string): unknown {
  if (!type) return value;
  let v = value;
  if (typeof v === "string") {
    const t = v.trim();
    if ((type === "number" || type === "integer") && t !== "" && Number.isFinite(Number(t)))
      v = Number(t);
    else if (type === "boolean" && (t === "true" || t === "false")) v = t === "true";
  }
  const actual = typeOf(v);
  if (actual === type || (type === "number" && actual === "integer")) return v;
  throw new PipelineError(
    `input "${name}" must be ${type}, and ${JSON.stringify(value)} is ${typeOf(value)}`,
  );
}

export interface PipelineContext {
  /** The blueprint's pieces by id: kind, name, and the tools the blueprint allows (all when empty). */
  pieces: Map<string, { kind: string; name: string; tools: string[] }>;
  /** The piece id for what the author wrote (an id or a bare name), or null. */
  resolve(ref: string): string | null;
  /** The tools a piece showed the last time it ran, or null when it never has. */
  known(piece: string): KnownTool[] | null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
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
    const say = (m: string) => problems.push(`pipelines: ${name || "(unnamed)"}: ${m}`);
    if (!SLUG.test(name)) say("name must be lowercase letters, digits and dashes");
    if (pipelines.some((p) => p.name === name)) say("two pipelines have this name");

    const inputs: Record<string, PipelineInput> = {};
    for (const [key, v] of Object.entries(isObject(r.inputs) ? r.inputs : {})) {
      if (!IDENT.test(key)) {
        say(`input "${key}": names are letters, digits and underscores`);
        continue;
      }
      const spec = isObject(v) ? v : { description: v };
      const type = text(spec.type) as InputType | "";
      if (type && !INPUT_TYPES.includes(type)) {
        say(`input "${key}": type is one of ${INPUT_TYPES.join(", ")}`);
      }
      const hasDefault = Object.hasOwn(spec, "default");
      inputs[key] = {
        description: text(spec.description),
        type: INPUT_TYPES.includes(type as InputType) ? type : "",
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
      const local: string[] = [];
      if (!IDENT.test(id)) {
        local.push("id must be letters, digits and underscores (it is read as $steps.<id>)");
      }
      if (steps.some((x) => x.id === id)) local.push("two steps have this id");

      const kinds = (["tool", "transform", "claude"] as const).filter((k) => text(s[k]));
      if (kinds.length !== 1) {
        say(
          `step ${id}: needs exactly one of "tool" (with "piece"), "transform" (a jq program) or "claude" (an instruction)`,
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
        concurrency: 0,
        timeout: DEFAULT_TIMEOUT,
        transform: "",
        from: "",
        claude: "",
        input: {},
        expect: "text",
        schema: null,
        when: bare(text(s.when)),
        retry: int(s.retry, 0, 0, LIMITS.retry, "retry", local),
        onError: s.onError === "continue" ? "continue" : "stop",
        parallel: s.parallel === true,
        after: Array.isArray(s.after) ? s.after.map(text).filter(Boolean) : [],
      };
      if (s.onError !== undefined && s.onError !== "stop" && s.onError !== "continue") {
        local.push('onError is "stop" or "continue"');
      }
      const only = (keys: string[], owner: string) => {
        for (const k of keys)
          if (s[k] !== undefined) local.push(`"${k}" belongs to ${owner} steps only`);
      };

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
        step.each = bare(text(s.each));
        step.concurrency = int(s.concurrency, 0, 1, LIMITS.concurrency, "concurrency", local);
        step.timeout = int(s.timeout, DEFAULT_TIMEOUT, 1, LIMITS.timeout, "timeout", local);
        only(["from", "input", "expect", "schema"], "transform or claude");
      } else if (kind === "transform") {
        step.transform = text(s.transform);
        step.from = bare(text(s.from));
        if (s.input !== undefined)
          local.push('a transform takes its value from "from" (a jq expression), not "input"');
        only(
          ["piece", "args", "each", "concurrency", "timeout", "expect", "schema"],
          "tool or claude",
        );
      } else {
        step.claude = text(s.claude);
        if (/\{\{[^}]*\$(steps|inputs|item|index)\b/.test(step.claude)) {
          local.push(
            'the instruction can\'t hold references; put each value in "input" (e.g. "input": {"notes": "{{ $steps.x.text }}"}) and name it in the instruction',
          );
        }
        if (s.input !== undefined && !isObject(s.input)) {
          local.push("input must be an object of named values");
        } else step.input = (s.input as Record<string, unknown>) ?? {};
        step.schema = isObject(s.schema) ? s.schema : null;
        step.expect =
          s.expect === "json" || (s.expect === undefined && step.schema) ? "json" : "text";
        if (s.expect !== undefined && s.expect !== "text" && s.expect !== "json") {
          local.push('expect is "text" or "json"');
        }
        if (step.retry) local.push("retry doesn't apply to a claude step");
        only(["piece", "args", "each", "concurrency", "timeout", "from"], "tool or transform");
      }

      // Expressions must compile and read only what exists before this step.
      const earlier = steps.map((x) => x.id);
      try {
        const reads = stepReads(step);
        const when = whenReads(step);
        for (const v of new Set([...reads.unknown, ...when.unknown])) {
          local.push(`$${v} doesn't exist; there are ${VARIABLES.map((x) => `$${x}`).join(", ")}`);
        }
        for (const ref of new Set([...reads.steps.keys(), ...when.steps.keys()])) {
          if (ref === id) local.push("it reads its own output");
          else if (!earlier.includes(ref)) {
            local.push(`it reads $steps.${ref}, which isn't a step listed before it`);
          }
        }
        for (const ref of new Set([...reads.inputs, ...when.inputs])) {
          if (!Object.hasOwn(inputs, ref))
            local.push(`it reads $inputs.${ref}, which isn't in inputs`);
        }
        // `each` itself is evaluated before there is an item.
        const inEach = step.each ? noReads() : null;
        if (inEach) addReads(inEach, expression(step.each));
        if ((reads.item && !step.each) || when.item || inEach?.item) {
          local.push("$item and $index exist only in the args of a step with each");
        }
      } catch (e) {
        local.push(message(e));
      }
      for (const ref of step.after) {
        if (!earlier.includes(ref)) local.push(`after: "${ref}" isn't a step listed before it`);
      }

      // The tool itself, when the piece has run before.
      if (kind === "tool" && step.piece) {
        const known = ctx.known(step.piece);
        if (known) {
          const tool = known.find((t) => t.name === step.tool);
          if (!tool) {
            local.push(
              `${step.piece} has no tool "${step.tool}"; it has ${known.map((t) => t.name).join(", ")}`,
            );
          } else local.push(...argProblems(step.args, tool, false));
        }
      }

      for (const m of local) say(`step ${id}: ${m}`);
      steps.push(step);
    });

    let output = text(r.output);
    if (output) {
      try {
        const reads = noReads();
        readsOf(output, reads);
        for (const ref of reads.steps.keys()) {
          if (!steps.some((s) => s.id === ref))
            say(`output reads $steps.${ref}, which isn't a step`);
        }
        for (const ref of reads.inputs) {
          if (!Object.hasOwn(inputs, ref))
            say(`output reads $inputs.${ref}, which isn't in inputs`);
        }
        if (reads.item) say("output can't read $item");
        for (const v of reads.unknown) say(`output: $${v} doesn't exist`);
      } catch (e) {
        say(`output: ${message(e)}`);
        output = "";
      }
    }
    pipelines.push({ name, description: text(r.description), inputs, steps, output });
  }
  return { pipelines, problems };
}
