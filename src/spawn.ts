// How a program is started. On macOS and Linux a command and its arguments
// go to the system as they are. On Windows two things go wrong with that:
// `npx`, `claude` and most of npm's commands are `.cmd` files, which only
// cmd.exe can run and which read their arguments as cmd.exe does, not as a
// program does; and a bare name is looked for in the folder the program is
// started in before PATH, which here is the project, a folder that isn't
// trusted. So the name is found on PATH by this file, and a `.cmd` or `.bat`
// is handed to cmd.exe as one line, each argument escaped for it (the way
// the `cross-spawn` package does it).
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface Launch {
  command: string;
  args: string[];
  /** The arguments are one finished line: Node must not quote them again. */
  verbatim: boolean;
}

export interface Where {
  platform?: string;
  env?: Record<string, string | undefined>;
  exists?: (file: string) => boolean;
}

/** A variable of `env` whatever its case, as Windows reads them. */
function variable(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

const SCRIPT = /\.(cmd|bat)$/i;

/**
 * The file a command name stands for on Windows, or null. A name with a
 * folder in it is taken where it says; a bare one is looked for on PATH
 * only, never in the folder the program will run in.
 */
export function findOnWindows(command: string, where: Where = {}): string | null {
  const env = where.env ?? process.env;
  const exists = where.exists ?? existsSync;
  const exts = (variable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  // `npx` without an extension is a shell script beside `npx.cmd`: not that one.
  const named = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));
  const names = named ? [command] : exts.map((e) => command + e);
  if (/[\\/]/.test(command)) return names.find((n) => exists(n)) ?? null;
  const dirs = (variable(env, "PATH") ?? "")
    .split(";")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => win32.isAbsolute(d));
  for (const dir of dirs) {
    for (const name of names) {
      const file = win32.join(dir, name);
      if (exists(file)) return file;
    }
  }
  return null;
}

const META = /([()\][%!^"`<>&|;, *?])/g;
const PLAIN = /^[A-Za-z0-9_\-+=:.\\/@]+$/;

/** One argument as cmd.exe must be given it so that a program started from a script reads it back whole. */
function scriptArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("An argument with a line break can't be passed to a .cmd file on Windows");
  }
  if (PLAIN.test(arg)) return arg;
  // For the program: quotes, with backslashes before a quote or the end doubled.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  // For cmd.exe, twice: it reads the line, then the script reads `%*` again.
  return quoted.replace(META, "^$1").replace(META, "^$1");
}

/** What to hand to `spawn` so that `command` runs with exactly `args`. */
export function launch(command: string, args: string[], where: Where = {}): Launch {
  const platform = where.platform ?? process.platform;
  if (platform !== "win32") return { command, args, verbatim: false };
  const file = findOnWindows(command, where);
  if (!file) {
    throw new Error(/[\\/]/.test(command) ? `${command} isn't there` : `${command} isn't on PATH`);
  }
  if (!SCRIPT.test(file)) return { command: file, args, verbatim: false };
  const line = [file.replace(META, "^$1"), ...args.map(scriptArg)].join(" ");
  return {
    command: variable(where.env ?? process.env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}
