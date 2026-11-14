// `encela hook`: the plugin's UserPromptSubmit hook. It reads the prompt
// Claude Code is about to send and adds a short note: start with a
// blueprint (or carry on with the one being built), plus a few pieces whose
// keywords match. Claude decides whether the request is big enough for one.
// It never stops the prompt: any failure leaves the prompt as it was.
import { Blueprints, progress } from "./blueprint";
import { projectDir } from "./paths";
import { Registry } from "./registry";
import { line, search } from "./search";

const MIN_CHARS = 8;
/** Keyword matches less sure than this stay out of the prompt. */
export const HINT_MIN = 8;
const HINTS = 5;

/** Not for commands, shell lines, memory notes, or text a program wrote. */
export function wantsEncela(prompt: string): boolean {
  const t = prompt.trim();
  return t.length >= MIN_CHARS && !/^[/!#<]/.test(t) && !t.includes("[Encela]");
}

/** The context to add for `prompt`, or null for none. */
export function hookContext(prompt: string, project: string, registry: Registry): string | null {
  if (!wantsEncela(prompt) || process.env.ENCELA_AUTO === "0") return null;
  const active = new Blueprints(project).active();
  if (active) {
    return `[Encela] The blueprint ${active.id} ("${active.goal}") is ${active.status}, ${progress(active)}. If this message continues that work, keep following it (blueprint_get shows where it stands; record steps with blueprint_step). If it asks for something new and not small, make a new blueprint with the encela:orchestrate skill.`;
  }
  const hints = search(registry.all(), [prompt], { limit: HINTS })
    .filter((m) => m.score >= HINT_MIN && m.piece.trusted)
    .map((m) => line(m.piece));
  const found = hints.length
    ? `\nPieces whose keywords match (judge them yourself, and search for more):\n${hints.join("\n")}`
    : "";
  return `[Encela] If this request builds, changes or produces something beyond a quick answer or a small edit, use the encela:orchestrate skill before starting: analyse the request, find pieces (find_pieces), write a blueprint (blueprint_save), get the user's approval (blueprint_approve), assemble (blueprint_assemble), then build. For questions, explanations and small edits, ignore this note.${found}`;
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
