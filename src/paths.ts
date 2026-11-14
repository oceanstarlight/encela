// Where things live: the package's own files, the user's Encela folder and a
// project's `.encela` folder.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __VERSION__: string;
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

export type Lang = "ko" | "en";
export type Text = { ko: string; en: string };

/** Korean when the system language is Korean, else English (ENCELA_LANG overrides). */
export function lang(): Lang {
  const env = process.env.ENCELA_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? "";
  if (/^ko/i.test(env)) return "ko";
  if (env) return "en";
  try {
    return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "ko" : "en";
  } catch {
    return "en";
  }
}

/** The user's Encela folder: their own pieces and the Claude Code plugin. */
export function home(): string {
  return process.env.ENCELA_HOME?.trim() ? process.env.ENCELA_HOME : join(homedir(), ".encela");
}

/** A file or folder the package ships with (`catalog.json`, `plugin`). */
export function asset(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [
    join(here, name),
    join(here, "..", "dist", name),
    join(here, "..", "..", "dist", name),
  ].find((f) => existsSync(f));
  if (!found) throw new Error(`${name} is missing: build the package first`);
  return found;
}

/** The project a session works in. */
export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR?.trim() ? process.env.CLAUDE_PROJECT_DIR : process.cwd();
}

/** The project's Encela folder: blueprints and the working copies built from them. */
export const projectHome = (project: string) => join(project, ".encela");
