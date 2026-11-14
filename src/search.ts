// Finding pieces by words. This only narrows the list: Claude reads the
// matches and decides which ones a request needs.
import type { Lang } from "./paths";
import type { Piece, PieceKind } from "./piece";

const STOP = new Set(
  "a an the and or of to for in on with by from at as is are be it this that into using use make build create add new my our your app want need please help".split(
    " ",
  ),
);

export function words(text: string): string[] {
  const all = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(all)];
}

const has = (list: string[], w: string) => list.some((x) => x.toLowerCase() === w);

/** Whether `text` has the word `w`: whole words for Latin text, anywhere for Korean. */
function mentions(text: string, w: string): boolean {
  if (!/^[a-z0-9+#.]+$/.test(w)) return text.includes(w);
  const escaped = w.replace(/[.+#]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(s|es)?([^a-z0-9]|$)`).test(text);
}

/** How well one word matches a piece: the name and what it does count most. */
function wordScore(p: Piece, w: string): number {
  const name = p.name.toLowerCase();
  const nameParts = name.split(/[^a-z0-9+#]+/);
  if (name === w) return 8;
  if (nameParts.includes(w)) return 6;
  if (has(p.tags, w) || has(p.capabilities, w)) return 5;
  if (has(p.inputs, w) || has(p.outputs, w)) return 3;
  const title = `${p.title.en} ${p.title.ko}`.toLowerCase();
  if (mentions(title, w)) return 4;
  if (mentions([...p.tags, ...p.capabilities].join(" ").toLowerCase(), w)) return 3;
  const summary = `${p.summary.en} ${p.summary.ko}`.toLowerCase();
  if (mentions(summary, w)) return 2;
  if (mentions(p.detail.toLowerCase(), w)) return 1;
  return 0;
}

export interface Match {
  piece: Piece;
  score: number;
}

/** The pieces matching any of `queries`, best first. */
export function search(
  pieces: Piece[],
  queries: string[],
  opts: { kinds?: PieceKind[]; limit?: number } = {},
): Match[] {
  const pool = opts.kinds?.length ? pieces.filter((p) => opts.kinds?.includes(p.kind)) : pieces;
  const sets = queries.map(words).filter((w) => w.length);
  if (!sets.length) return [];
  const found: Match[] = [];
  for (const piece of pool) {
    let best = 0;
    let hits = 0;
    for (const set of sets) {
      let sum = 0;
      for (const w of set) sum += wordScore(piece, w);
      if (sum > 0) hits++;
      best = Math.max(best, sum);
    }
    // A piece several queries point at is likelier to matter.
    if (best > 0) found.push({ piece, score: best + (hits - 1) });
  }
  found.sort((a, b) => b.score - a.score || a.piece.id.localeCompare(b.piece.id));
  return found.slice(0, opts.limit ?? 15);
}

/** One line on a piece, for a list Claude picks from. */
export function line(p: Piece, l: Lang = "en"): string {
  const io =
    p.inputs.length || p.outputs.length
      ? ` (takes: ${p.inputs.join(", ") || "-"}; gives: ${p.outputs.join(", ") || "-"})`
      : "";
  const title = p.title[l] !== p.name ? ` "${p.title[l]}"` : "";
  const mark = p.trusted ? "" : " [not yet approved by the user]";
  return `- ${p.id}${title}: ${p.summary[l] || p.summary.en}${io}${mark}`;
}
