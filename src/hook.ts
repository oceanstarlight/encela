// `encela hook`: the plugin's UserPromptSubmit hook. It reads the prompt
// Claude Code is about to send and adds a short note: start with a
// blueprint (or carry on with the one being built), plus a few pieces whose
// keywords match. Claude sizes the request: simple (Encela stays out), medium
// (the light path) or difficult (the full flow).
// It never stops the prompt: any failure leaves the prompt as it was.
import { Blueprints, progress } from "./blueprint";
import { projectDir } from "./paths";
import { Recipes, recipeLine } from "./recipe";
import { Registry } from "./registry";
import { line, search } from "./search";

const MIN_CHARS = 8;
/** Keyword matches less sure than this stay out of the prompt. */
export const HINT_MIN = 12;
const HINTS = 3;

/** The note on a prompt: short, because it rides on every one. The levels in full are in the server's instructions. */
const NOTE =
  "Simple (a question, a small edit, one thing you do by yourself such as a commit, a PR or a deploy): ignore Encela, say nothing of it. Medium (a small page or script, a follow-up change): say so in one line, find_pieces once, then quick_build. Difficult (a new app or workflow, many parts): say so, then the encela:orchestrate skill. Unsure: the smaller. A level the user named stands.";

/** Not for commands, shell lines, memory notes, or text a program wrote. */
export function wantsEncela(prompt: string): boolean {
  const t = prompt.trim();
  return t.length >= MIN_CHARS && !/^[/!#<]/.test(t) && !t.includes("[Encela]");
}

/** The context to add for `prompt`, or null for none. */
export function hookContext(
  prompt: string,
  project: string,
  registry: Registry,
  recipes: Recipes = new Recipes(registry.folder),
): string | null {
  if (!wantsEncela(prompt) || process.env.ENCELA_AUTO === "0") return null;
  const active = new Blueprints(project).active();
  if (active) {
    return `[Encela] The blueprint ${active.id} ("${active.goal}") is ${active.status}, ${progress(active)}. If this message continues that work, keep following it (blueprint_get shows where it stands; record steps with blueprint_step). If it asks for something new, size it: ${NOTE}`;
  }
  const hints = search(registry.all(), [prompt], { limit: HINTS })
    .filter((m) => m.score >= HINT_MIN && m.piece.trusted)
    .map((m) => line(m.piece));
  const found = hints.length
    ? `\nPieces whose keywords match (judge them yourself, and search for more):\n${hints.join("\n")}`
    : "";
  let known = "";
  try {
    const matches = recipes.search([prompt], 2);
    if (matches.length) {
      known = `\nRecipes the user kept from builds like this (recipe_get {name} gives a blueprint to start from):\n${matches.map((m) => recipeLine(m.recipe)).join("\n")}`;
    }
  } catch {
    // No recipes to point at.
  }
  return `[Encela] ${NOTE}${found}${known}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(): Promise<void> {
  try {
    const input = JSON.parse((await readStdin()) || "{}") as { prompt?: unknown; cwd?: unknown };
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const project = typeof input.cwd === "string" && input.cwd ? input.cwd : projectDir();
    const context = hookContext(prompt, project, new Registry());
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        }),
      );
    }
  } catch {
    // A hook that fails must not get in the way of the prompt.
  }
}
