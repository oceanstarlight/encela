// What the user switched on or off, kept in their Encela folder as
// `settings.json`. A file that can't be read is the defaults.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths";

export interface Settings {
  /** The prompt hook also names pieces and recipes that match the prompt. */
  hints: boolean;
}

const DEFAULTS: Settings = { hints: false };

const fileOf = (folder: string) => join(folder, "settings.json");

export function readSettings(folder = home()): Settings {
  try {
    const kept = JSON.parse(readFileSync(fileOf(folder), "utf8")) as Record<string, unknown>;
    return { hints: kept.hints === true };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Changes some settings and keeps what else the file holds. */
export function writeSettings(change: Partial<Settings>, folder = home()): Settings {
  let kept: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(fileOf(folder), "utf8"));
    if (read && typeof read === "object" && !Array.isArray(read)) kept = read;
  } catch {
    // Nothing kept yet.
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(fileOf(folder), `${JSON.stringify({ ...kept, ...change }, null, 2)}\n`);
  return readSettings(folder);
}

/** Whether the hook names matching pieces and recipes: `ENCELA_HINTS` (1 or 0) decides before the file. */
export function hintsOn(folder = home()): boolean {
  const env = process.env.ENCELA_HINTS?.trim();
  if (env === "1") return true;
  if (env === "0") return false;
  return readSettings(folder).hints;
}
