// Recipes: a blueprint that worked, kept in the user's Encela folder to start
// the next build of its kind from. A recipe is only a starting point: using
// one gives Claude a draft to adapt, and that draft goes to the user for
// approval like any other blueprint. Nothing a recipe holds is approved.
//
// They live in the user's own folder (`<home>/recipes/<name>.json`), never
// in a project: a repository's files don't get to pose as what worked before.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Blueprint } from "./blueprint";
import { home } from "./paths";
import { writeJson } from "./registry";
import { words } from "./search";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Characters a recipe's file may hold, and recipes a person may keep. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECIPES = 500;

export interface RecipePiece {
  piece: string;
  role: string;
  why: string;
  adapt: string;
  tools: string[];
  /** Only references to the user's environment (`${NAME}`) are kept; values set for one build are not. */
  env: Record<string, string>;
}

export interface Recipe {
  version: 1;
  name: string;
  summary: string;
  tags: string[];
  /** What was learned in the build it comes from: what to do the same, what to do differently. */
  notes: string;
  request: string;
  goal: string;
  requirements: string[];
  pieces: RecipePiece[];
  workers: { name: string; role: string }[];
  steps: {
    id: string;
    title: string;
    detail: string;
    worker: string;
    pieces: string[];
    after: string[];
    pipeline: string;
  }[];
  /** What the user was asked, and what they chose then: shown as last time's answer, asked again. */
  choices: { question: string; options: string[]; last: string }[];
  pipelines: unknown[];
  savedAt: string;
  /** How often a blueprint was started from it, and when last. */
  uses: number;
  usedAt: string;
}

const text = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const texts = (v: unknown, max = 50) =>
  (Array.isArray(v) ? v : [])
    .map((x) => text(x, 400))
    .filter(Boolean)
    .slice(0, max);
const things = (v: unknown) =>
  (Array.isArray(v) ? v : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x),
  );

export function recipeName(given: unknown): string {
  const name = text(given, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (!NAME.test(name)) {
    throw new Error("A recipe's name is letters, digits and dashes, e.g. landing-page");
  }
  return name;
}

/** A recipe from what a file or a blueprint holds, every part taken as what it should be; null when it isn't one. */
function shaped(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 64);
  const goal = text(r.goal);
  const steps = things(r.steps).map((s) => ({
    id: text(s.id, 80),
    title: text(s.title, 400),
    detail: text(s.detail),
    worker: text(s.worker, 80),
    pieces: texts(s.pieces),
    after: texts(s.after),
    pipeline: text(s.pipeline, 80),
  }));
  if (!NAME.test(name) || !goal || !steps.length || steps.some((s) => !s.id)) return null;
  return {
    version: 1,
    name,
    summary: text(r.summary, 400),
    tags: texts(r.tags, 12).map((t) => t.toLowerCase()),
    notes: text(r.notes),
    request: text(r.request),
    goal,
    requirements: texts(r.requirements),
    pieces: things(r.pieces)
      .map((p) => ({
        piece: text(p.piece, 200),
        role: text(p.role, 400),
        why: text(p.why, 400),
        adapt: text(p.adapt),
        tools: texts(p.tools, 200),
        env: Object.fromEntries(
          Object.entries(
            p.env && typeof p.env === "object" && !Array.isArray(p.env)
              ? (p.env as Record<string, unknown>)
              : {},
          ).filter(
            (e): e is [string, string] =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) &&
              typeof e[1] === "string" &&
              /^\$\{[A-Za-z0-9_]+\}$/.test(e[1]),
          ),
        ),
      }))
      .filter((p) => p.piece),
    workers: things(r.workers)
      .map((w) => ({ name: text(w.name, 80), role: text(w.role, 400) }))
      .filter((w) => w.name),
    steps,
    choices: things(r.choices)
      .map((c) => ({
        question: text(c.question, 400),
        options: texts(c.options, 20),
        last: text(c.last ?? c.answer, 400),
      }))
      .filter((c) => c.question),
    pipelines: things(r.pipelines),
    savedAt: text(r.savedAt, 40),
    uses: Number.isFinite(Number(r.uses)) ? Math.max(0, Math.floor(Number(r.uses))) : 0,
    usedAt: text(r.usedAt, 40),
  };
}

export interface RecipeMatch {
  recipe: Recipe;
  score: number;
}

export class Recipes {
  constructor(private root = home()) {}

  get dir() {
    return join(this.root, "recipes");
  }

  private file(name: string) {
    if (!NAME.test(name)) throw new Error(`"${name}" isn't a recipe's name`);
    return join(this.dir, `${name}.json`);
  }

  /** Every recipe, the one used or saved last first. A file that isn't a recipe is left alone. */
  list(): Recipe[] {
    if (!existsSync(this.dir)) return [];
    const all: Recipe[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const found = this.find(f.slice(0, -5));
      if (found) all.push(found);
    }
    const when = (r: Recipe) => r.usedAt || r.savedAt;
    return all.sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
  }

  find(name: string): Recipe | null {
    if (!NAME.test(name)) return null;
    try {
      const raw = readFileSync(this.file(name), "utf8");
      if (raw.length > MAX_BYTES) return null;
      const recipe = shaped(JSON.parse(raw));
      return recipe && recipe.name === name ? recipe : null;
    } catch {
      return null;
    }
  }

  get(name: string): Recipe {
    const found = this.find(recipeName(name));
    if (!found) {
      const have = this.list().map((r) => r.name);
      throw new Error(
        `No recipe "${name}".${have.length ? ` There are: ${have.join(", ")}` : " None is saved yet."}`,
      );
    }
    return found;
  }

  /**
   * Keeps a finished blueprint as a recipe. What belonged to that one build
   * is left behind: where each step stood, the approval, and values set for
   * a piece's environment.
   */
  save(
    b: Blueprint,
    given: { name?: unknown; summary?: unknown; tags?: unknown; notes?: unknown },
    now = new Date(),
  ): { recipe: Recipe; replaced: boolean; dropped: string[] } {
    if (b.status !== "done") {
      throw new Error(
        `${b.id} is ${b.status}: a recipe is made from a blueprint whose every step is done`,
      );
    }
    const name = recipeName(given.name || b.goal);
    const before = this.find(name);
    if (!before && this.list().length >= MAX_RECIPES) {
      throw new Error(
        `There are ${MAX_RECIPES} recipes already: remove one first (encela recipes)`,
      );
    }
    const dropped = b.pieces.flatMap((p) =>
      Object.entries(p.env)
        .filter(([, v]) => !/^\$\{[A-Za-z0-9_]+\}$/.test(v))
        .map(([k]) => `${p.piece}: ${k}`),
    );
    const recipe = shaped({
      ...b,
      name,
      summary: text(given.summary, 400) || b.goal,
      tags: given.tags,
      notes: given.notes,
      savedAt: now.toISOString(),
      uses: before?.uses ?? 0,
      usedAt: before?.usedAt ?? "",
    });
    if (!recipe) throw new Error(`${b.id} can't be kept as a recipe: it has no goal or no steps`);
    mkdirSync(this.dir, { recursive: true });
    writeJson(this.file(name), recipe);
    return { recipe, replaced: !!before, dropped };
  }

  /** Notes that a blueprint was started from a recipe. */
  used(name: string, now = new Date()) {
    const recipe = this.find(name);
    if (!recipe) return;
    recipe.uses++;
    recipe.usedAt = now.toISOString();
    writeJson(this.file(name), recipe);
  }

  remove(name: string): boolean {
    if (!this.find(name)) return false;
    rmSync(this.file(name), { force: true });
    return true;
  }

  /** The recipes whose words match any of `queries`, best first. */
  search(queries: string[], limit = 3): RecipeMatch[] {
    const sets = queries.map(words).filter((w) => w.length);
    if (!sets.length) return [];
    const found: RecipeMatch[] = [];
    for (const recipe of this.list()) {
      const strong = `${recipe.name.replaceAll("-", " ")} ${recipe.tags.join(" ")}`.toLowerCase();
      const weak =
        `${recipe.summary} ${recipe.goal} ${recipe.request} ${recipe.requirements.join(" ")}`.toLowerCase();
      let best = 0;
      for (const set of sets) {
        let sum = 0;
        for (const w of set) sum += strong.includes(w) ? 4 : weak.includes(w) ? 2 : 0;
        best = Math.max(best, sum);
      }
      if (best >= 4) found.push({ recipe, score: best });
    }
    return found.sort((a, b) => b.score - a.score || b.recipe.uses - a.recipe.uses).slice(0, limit);
  }
}

/** One line on a recipe, for a list Claude picks from. */
export function recipeLine(r: Recipe): string {
  const used = r.uses ? `, used ${r.uses} time${r.uses === 1 ? "" : "s"}` : "";
  return `- ${r.name}: ${r.summary} (${r.steps.length} steps, ${r.pieces.length} pieces${used})`;
}

/**
 * A recipe as Claude gets it: what it is, what was learned, and a blueprint
 * to adapt and save. `missing` are pieces it names that Encela no longer has.
 */
export function recipeText(r: Recipe, missing: string[], unapproved: string[]): string {
  const blueprint = {
    recipe: r.name,
    request: "",
    goal: r.goal,
    requirements: r.requirements,
    pieces: r.pieces.filter((p) => !missing.includes(p.piece)),
    workers: r.workers,
    steps: r.steps,
    choices: r.choices.map((c) => ({ question: c.question, options: c.options, last: c.last })),
    pipelines: r.pipelines,
  };
  const out = [
    `Recipe ${r.name}: ${r.summary}`,
    `Saved ${r.savedAt.slice(0, 10) || "?"}${r.uses ? `, used ${r.uses} time${r.uses === 1 ? "" : "s"}` : ""}. It was made for: ${r.request || r.goal}`,
  ];
  if (r.notes) out.push("", "What was learned:", r.notes);
  if (missing.length) {
    out.push(
      "",
      `Pieces it used that Encela no longer has (left out below; find others for their roles): ${missing.join(", ")}`,
    );
  }
  if (unapproved.length) {
    out.push(
      "",
      `Pieces from outside that the user hasn't approved on this computer (they are shown with their warnings again): ${unapproved.join(", ")}`,
    );
  }
  out.push(
    "",
    "A blueprint to start from:",
    JSON.stringify(blueprint, null, 1),
    "",
    "A recipe is a starting point, not a plan for this request: change the goal, the requirements, the steps and their details to what the user asks now, drop pieces that don't help this time and look for ones that would (find_pieces). Each choice carries what the user chose last time as `last`: ask again, with that as the default. Then save it with blueprint_save (keep `recipe` in it so Encela knows where it came from) and ask for approval with blueprint_approve as always: nothing in a recipe is approved.",
  );
  return out.join("\n");
}
