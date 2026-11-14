// Assembling an approved blueprint's documents: each skill, rule,
// instruction and subagent gets a working copy in the project
// (`.encela/build/<blueprint>/`). The copy is what gets adapted to the build
// and read while building; the piece itself is never changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Blueprint, type BlueprintPiece, MAIN, shared } from "./blueprint";
import { inEncela, projectHome } from "./paths";
import { isDocument, type Piece } from "./piece";
import { writeJson } from "./registry";
import { place, type Seals } from "./seal";

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
  /** False when a copy Encela wrote here earlier (perhaps adapted since) was kept. */
  written: boolean;
  /** True when a file was already there that Encela hadn't written: it was replaced. */
  replaced: boolean;
}

const LEDGER = "copies.json";

/** The copies of a blueprint that this computer's Encela wrote, by path inside the build folder. */
function ours(project: string, id: string, seals: Seals): Set<string> {
  try {
    const data = JSON.parse(readFileSync(inEncela(project, "build", id, LEDGER), "utf8")) as {
      paths?: unknown;
      seal?: unknown;
    };
    const paths = Array.isArray(data.paths) ? data.paths.filter((x) => typeof x === "string") : [];
    return seals.matches(data.seal, "build", place(project), id, ...paths)
      ? new Set(paths)
      : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Writes a blueprint's working copies. A copy Encela wrote here before is
 * kept, since it may have been adapted. A file that was already there
 * without Encela having written it (it came with the project) is replaced:
 * the user approved the piece, not that file.
 */
export function writeCopies(
  b: Blueprint,
  find: (id: string) => Piece | null,
  project: string,
  seals?: Seals,
): Copy[] {
  const copies: Copy[] = [];
  const root = inEncela(project, "build", b.id);
  const known = seals ? ours(project, b.id, seals) : null;
  /** A path under the build folder, checked for links all the way down. */
  const inside = (file: string) =>
    inEncela(project, ...relative(projectHome(project), file).split(sep));
  const put = (file: string, content: string) => {
    mkdirSync(inside(join(file, "..")), { recursive: true });
    writeFileSync(inside(file), content);
  };
  const paths: string[] = [];
  for (const entry of b.pieces) {
    const piece = find(entry.piece);
    if (!piece || !isDocument(piece.kind)) continue;
    const file = inside(copyPath(root, piece));
    const name = relative(root, file).split(sep).join("/");
    const there = existsSync(file);
    const keep = there && (!known || known.has(name));
    if (!keep) {
      put(file, copyText(piece));
      for (const [rel, content] of Object.entries(piece.files)) {
        // A reference file stays next to its skill.
        const parts = rel.split(/[\\/]/).filter(Boolean);
        if (!parts.length || parts.includes("..") || parts.includes(".")) continue;
        put(join(file, "..", ...parts), content);
      }
    }
    paths.push(name);
    copies.push({
      piece,
      entry,
      path: relative(project, file).split(sep).join("/"),
      written: !keep,
      replaced: there && !keep,
    });
  }
  if (seals && paths.length) {
    const all = [...new Set([...(known ?? []), ...paths])].sort();
    mkdirSync(root, { recursive: true });
    writeJson(inEncela(project, "build", b.id, LEDGER), {
      paths: all,
      seal: seals.sign("build", place(project), b.id, ...all),
    });
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
          // A step a pipeline does is run, not done by hand: that is what the user approved.
          const run = s.pipeline
            ? ` Do it by running the pipeline: pipeline_run {id: "${b.id}", pipeline: "${s.pipeline}"}, then do what the report's last line says.`
            : "";
          return `- ${s.id}: ${s.title}${after}${s.detail ? `. ${s.detail}` : ""}${run}`;
        }),
      ];
      if (pieces.length) lines.push("Pieces to use:", ...pieces.map((id) => `- ${usage(id)}`));
      return { worker, text: lines.join("\n") };
    })
    .filter((x): x is { worker: string; text: string } => !!x);
}
