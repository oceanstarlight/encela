// The registry: every piece Encela knows. The catalog's pieces ship with the
// package; the user's own (and the ones Claude found outside) live in
// `<home>/pieces.json`.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asset, home } from "./paths";
import { normalizePiece, type Piece } from "./piece";

const FILE = "pieces.json";

let shipped: Piece[] | null = null;

/** The catalog's pieces (dist/catalog.json, made by build.mjs). */
export function catalogPieces(): Piece[] {
  if (!shipped) {
    shipped = (JSON.parse(readFileSync(asset("catalog.json"), "utf8")) as { pieces: Piece[] })
      .pieces;
  }
  return shipped;
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e instanceof Error ? e.message : e})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} isn't a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Writes a JSON file whole or not at all. A link at its name is replaced, never written through. */
export function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, file);
}

export class Registry {
  constructor(
    private dir = home(),
    private catalog: () => Piece[] = catalogPieces,
  ) {}

  get file() {
    return join(this.dir, FILE);
  }

  /** The user's Encela folder this registry lives in. */
  get folder() {
    return this.dir;
  }

  /** The user's own pieces. */
  own(): Piece[] {
    const map = readJson(this.file);
    return Array.isArray(map?.pieces) ? (map.pieces as Piece[]) : [];
  }

  private store(pieces: Piece[]) {
    const map = readJson(this.file) ?? {};
    map.version = 1;
    map.pieces = pieces;
    mkdirSync(this.dir, { recursive: true });
    writeJson(this.file, map);
  }

  all(): Piece[] {
    return [...this.catalog(), ...this.own()];
  }

  /** The piece with this id; a bare name works when only one piece has it. */
  find(id: string): Piece | null {
    const all = this.all();
    const exact = all.find((p) => p.id === id);
    if (exact) return exact;
    const named = all.filter((p) => p.name === id || p.id.split(":")[1] === id);
    return named.length === 1 ? (named[0] as Piece) : null;
  }

  get(id: string): Piece {
    const p = this.find(id);
    if (!p) throw new Error(`No piece "${id}". Look for ids with find_pieces.`);
    return p;
  }

  /**
   * Keeps a piece. One the user adds is trusted; one Claude found waits for
   * the user to approve a blueprint that has it.
   */
  add(raw: unknown, by: "user" | "claude"): Piece {
    const piece = normalizePiece(raw, by === "user" ? "user" : "external", by === "user");
    if (this.catalog().some((p) => p.id === piece.id)) {
      throw new Error(`${piece.id} is already in Encela's catalog: use that one, or pick a name`);
    }
    const own = this.own();
    const at = own.findIndex((p) => p.id === piece.id);
    if (at >= 0) {
      const before = own[at] as Piece;
      if (by === "claude" && before.origin === "user") {
        throw new Error(
          `${piece.id} is a piece the user added themselves: it is not replaced. Give this one another name.`,
        );
      }
      // Changing what an accepted piece runs, says or is needs the user's
      // word again: its command, its text, the files beside it, its guide,
      // and where it comes from.
      const what = (p: Piece) =>
        JSON.stringify([
          p.kind,
          p.config,
          p.install,
          p.body,
          Object.entries(p.files ?? {}).sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0)),
          p.paths,
          p.guide,
          p.source?.repo ?? "",
          p.source?.commit ?? "",
          p.license,
        ]);
      if (by === "claude") {
        if (what(before) === what(piece)) piece.trusted = before.trusted;
        // What the user was to be told about it is not taken back by a later call.
        piece.warnings = [...new Set([...before.warnings, ...piece.warnings])];
      }
      own[at] = piece;
    } else own.push(piece);
    this.store(own);
    return piece;
  }

  remove(id: string): boolean {
    const own = this.own();
    const left = own.filter((p) => p.id !== id);
    if (left.length === own.length) return false;
    this.store(left);
    return true;
  }

  /** Marks the user's own pieces among `ids` as accepted. */
  trust(ids: string[]) {
    const own = this.own();
    let changed = false;
    for (const p of own) {
      if (ids.includes(p.id) && !p.trusted) {
        p.trusted = true;
        changed = true;
      }
    }
    if (changed) this.store(own);
  }

  /**
   * Takes in the modules of an earlier Encela (`mcp-hub.json`, the app's and
   * the first npm package's file) whose names aren't taken; the ones added.
   */
  importLegacy(file: string): Piece[] {
    const map = readJson(file);
    if (!map) throw new Error(`${file} doesn't exist`);
    const added: Piece[] = [];
    for (const m of (Array.isArray(map.servers) ? map.servers : []) as Record<string, unknown>[]) {
      const kind = String(m.kind ?? "mcp");
      if (this.find(`${kind}:${m.name}`)) continue;
      const source = m.source as Record<string, unknown> | null;
      try {
        added.push(
          this.add(
            {
              ...m,
              kind,
              summary: m.description || m.name,
              source: source?.repo ? source : null,
              license: source?.license ?? "",
            },
            "user",
          ),
        );
      } catch {
        // An entry that isn't a usable piece stays behind.
      }
    }
    return added;
  }
}
