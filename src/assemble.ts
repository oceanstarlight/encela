// Assembling an approved blueprint's documents: each skill, rule,
// instruction and subagent gets a working copy in the project
// (`.encela/build/<blueprint>/`). The copy is what gets adapted to the build
// and read while building; the piece itself is never changed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Blueprint, type BlueprintPiece, MAIN, shared } from "./blueprint";
import { isDocument, type Piece } from "./piece";

const FOLDER: Record<string, string> = {
  skill: "skills",
  rule: "rules",
  instruction: "instructions",
  subagent: "subagents",
};

/** `skill:obra_superpowers/writing-plans` → `obra_superpowers__writing-plans`. */
const folderName = (p: Piece) => (p.id.split(":")[1] ?? p.name).replaceAll("/", "__");

/** Where a document piece's working copy is, inside the build folder. */
export function copyPath(buildDir: string, p: Piece): string {
  const base = join(buildDir, FOLDER[p.kind] ?? p.kind);
  return p.kind === "skill"
    ? join(base, folderName(p), "SKILL.md")
    : join(base, `${folderName(p)}.md`);
}

const quote = (s: string) => JSON.stringify(s);

/** The copy's text: the piece's body under frontmatter that keeps where it came from. */
function copyText(p: Piece): string {
  const fm = [`name: ${p.name}`, `description: ${quote(p.detail || p.summary.en)}`];
  if (p.paths.length) fm.push("paths:", ...p.paths.map((x) => `  - ${quote(x)}`));
  if (p.license) fm.push(`license: ${p.license}`);
  if (p.source) {
    const at = p.source.commit ? `/blob/${p.source.commit}/${p.source.path}` : "";
    fm.push(`source: https://github.com/${p.source.repo}${at}`);
    if (p.source.copyright) fm.push(`copyright: ${quote(p.source.copyright)}`);
  }
  fm.push(`encela_piece: ${p.id}`);
  return `---\n${fm.join("\n")}\n---\n\n${p.body.trim()}\n`;
}

export interface Copy {
  piece: Piece;
  entry: BlueprintPiece;
  /** The working copy, relative to the project. */
  path: string;
  /** False when a copy was already there (perhaps adapted) and was kept. */
  written: boolean;
}

/** Writes the working copies that don't exist yet. */
export function writeCopies(
  b: Blueprint,
  find: (id: string) => Piece | null,
  buildDir: string,
  project: string,
): Copy[] {
  const copies: Copy[] = [];
  for (const entry of b.pieces) {
    const piece = find(entry.piece);
    if (!piece || !isDocument(piece.kind)) continue;
    const file = copyPath(buildDir, piece);
    const written = !existsSync(file);
    if (written) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, copyText(piece));
      for (const [rel, content] of Object.entries(piece.files)) {
        // A reference file stays next to its skill.
        if (rel.split(/[\\/]/).includes("..")) continue;
        const target = join(dirname(file), rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    copies.push({ piece, entry, path: relative(project, file).split("\\").join("/"), written });
  }
  return copies;
}

/** How one piece is used while building. */
export type Usage = (pieceId: string) => string;

/**
 * What each worker is handed: its role, its steps and how to use each of
 * its pieces. `main` is the orchestrator's own part.
 */
export function briefs(b: Blueprint, usage: Usage): { worker: string; text: string }[] {
  const everyone = shared(b);
  return [MAIN, ...b.workers.map((w) => w.name)]
    .map((worker) => {
      const steps = b.steps.filter((s) => s.worker === worker);
      if (!steps.length) return null;
      const role = b.workers.find((w) => w.name === worker)?.role ?? "";
      const pieces = [...new Set([...everyone, ...steps.flatMap((s) => s.pieces)])];
      const lines = [
        worker === MAIN ? "Your own steps (the orchestrator):" : `Worker "${worker}": ${role}`,
        `Goal of the whole build: ${b.goal}`,
        "Steps:",
        ...steps.map((s) => {
          const after = s.after.length ? ` (after ${s.after.join(", ")})` : "";
          return `- ${s.id}: ${s.title}${after}${s.detail ? `. ${s.detail}` : ""}`;
        }),
      ];
      if (pieces.length) lines.push("Pieces to use:", ...pieces.map((id) => `- ${usage(id)}`));
      return { worker, text: lines.join("\n") };
    })
    .filter((x): x is { worker: string; text: string } => !!x);
}
