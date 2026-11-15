// `encela setup`: writes the Claude Code plugin (MCP server, prompt hook,
// the orchestrate skill, the assembler subagent, /encela:go) as a local
// marketplace under the Encela folder and installs it with the user's own
// `claude`. `encela uninstall` takes it out again.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asset, home, PACKAGE, VERSION } from "./paths";
import { Registry } from "./registry";
import { FLOW } from "./server";

export const MARKETPLACE = "encela";
export const PLUGIN = "encela";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

/** A file in the folder npx keeps what it fetched in. */
const NPX = /[\\/]_npx[\\/]/;

/** How the plugin starts this package: `encela` on PATH, this install, or npx. */
export function launcher(): { command: string; args: string[] } {
  return launcherFor(process.platform, ...installed());
}

/** Whether `encela` is on PATH, this file and Node: what picks how to start it. */
function installed(): [boolean, string, string] {
  return [onPath("encela"), realpathSync(fileURLToPath(import.meta.url)), process.execPath];
}

/** The command that starts this install, before any wrapping for the OS. */
function bareLauncher(
  encelaOnPath: boolean,
  cli: string,
  execPath: string,
): { command: string; args: string[] } {
  // npx runs from a cache folder that can be cleared: point at the registry
  // instead. This comes first: while npx runs, its own folder is on PATH, so
  // an `encela` is found there that is gone when the plugin starts.
  if (NPX.test(cli)) return { command: "npx", args: ["-y", `${PACKAGE}@${VERSION}`] };
  if (encelaOnPath) return { command: "encela", args: [] };
  return { command: execPath, args: [cli] };
}

/**
 * [`launcher`] for a given OS. On Windows `encela` and `npx` are `.cmd`
 * files, which Claude Code can't start directly (the MCP server's
 * connection just closes): they go through `cmd /c`, as Claude Code's docs
 * say for npx servers.
 */
export function launcherFor(
  platform: string,
  encelaOnPath: boolean,
  cli: string,
  execPath: string,
): { command: string; args: string[] } {
  const run = bareLauncher(encelaOnPath, cli, execPath);
  return platform === "win32" && run.command !== execPath
    ? { command: "cmd", args: ["/c", run.command, ...run.args] }
    : run;
}

/**
 * The command line for hooks.json. Claude Code runs hooks in a POSIX shell,
 * Git Bash on Windows, so `cmd /c` must stay out of it: Git Bash turns `/c`
 * into a path, cmd opens interactively and runs the hook's stdin, the user's
 * prompt included, as commands. The shell finds npm's `encela` and `npx` by
 * itself, and it would eat a path's backslashes.
 */
export function hookCommandFor(
  platform: string,
  encelaOnPath: boolean,
  cli: string,
  execPath: string,
): string {
  const run = bareLauncher(encelaOnPath, cli, execPath);
  const parts = [run.command, ...run.args, "hook"];
  return parts
    .map((p) => (platform === "win32" ? p.replaceAll("\\", "/") : p))
    .map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

function onPath(name: string): boolean {
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (
    (process.env.PATH ?? "")
      .split(delimiter)
      // What npx put on PATH for one run is not on it later.
      .filter((dir) => dir && !NPX.test(`${dir}/`))
      .some((dir) => exts.some((e) => existsSync(join(dir, name + e.toLowerCase()))))
  );
}

const GO_COMMAND = `---
description: Encela - blueprint a request, approve it, assemble the pieces, then build
argument-hint: <request>
---
Request: $ARGUMENTS

Use the encela:orchestrate skill for this request, even if it looks small.

${FLOW}
`;

/**
 * Writes the plugin as a local marketplace; its folder. `auto` adds the note
 * to every prompt, `view` the pane and the line that show a build going on
 * (`plugin/hooks/view.tsx`, a hooks module Claude Code runs itself).
 */
export function writePlugin(
  root = join(home(), "claude-plugin"),
  auto = true,
  view = true,
): string {
  const run = launcher();
  const plugin = join(root, "plugins", PLUGIN);
  rmSync(root, { recursive: true, force: true });
  for (const d of [join(root, ".claude-plugin"), join(plugin, ".claude-plugin")]) {
    mkdirSync(d, { recursive: true });
  }
  // The skill and the subagent, as shipped.
  cpSync(asset("plugin"), plugin, { recursive: true });
  const json = (file: string, value: unknown) =>
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  json(join(root, ".claude-plugin", "marketplace.json"), {
    name: MARKETPLACE,
    owner: { name: "Encela" },
    metadata: { description: "Encela: blueprints and pieces for Claude Code" },
    plugins: [{ name: PLUGIN, source: `./plugins/${PLUGIN}`, version: VERSION }],
  });
  json(join(plugin, ".claude-plugin", "plugin.json"), {
    name: PLUGIN,
    version: VERSION,
    author: { name: "Encela" },
    homepage: "https://github.com/oceanstarlight/encela",
    license: "Apache-2.0",
    description:
      "Turns a request into a blueprint you approve, then assembles the pieces it needs (MCP servers, CLIs, skills, rules, subagents) and builds.",
    // What the view keeps in the session's state.
    ...(view ? { types: "./types/index.d.ts" } : {}),
  });
  json(join(plugin, ".mcp.json"), {
    mcpServers: { encela: { command: run.command, args: [...run.args, "mcp"] } },
  });
  const hooks: Record<string, unknown> = {};
  if (auto) {
    hooks.hooks = {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: hookCommandFor(process.platform, ...installed()),
              timeout: 10,
            },
          ],
        },
      ],
    };
  }
  if (view) hooks.modules = ["./view.tsx"];
  else {
    // Without the view its files don't go along: nothing of it is loaded.
    rmSync(join(plugin, "hooks"), { recursive: true, force: true });
    rmSync(join(plugin, "types"), { recursive: true, force: true });
  }
  if (auto || view) {
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    json(join(plugin, "hooks", "hooks.json"), hooks);
  }
  mkdirSync(join(plugin, "commands"), { recursive: true });
  writeFileSync(join(plugin, "commands", "go.md"), GO_COMMAND);
  return root;
}

/** The user's `claude`; its output, or why it failed. */
function claude(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("claude", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" },
  });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface SetupOptions {
  auto: boolean;
  /** The pane and the line in Claude Code that show a build going on. */
  view: boolean;
  /** Only write files; don't run `claude` (for tests, or to install by hand). */
  noClaude: boolean;
}

export function setup(opts: SetupOptions, log: (s: string) => void = console.log): number {
  const registry = new Registry();
  log(
    `Pieces: ${registry.all().length} (${registry.own().length} of your own in ${registry.file})`,
  );
  const root = writePlugin(undefined, opts.auto, opts.view);
  log(`Plugin: ${root}${opts.auto ? "" : " (no automatic hook)"}${opts.view ? "" : " (no view)"}`);
  if (opts.noClaude) {
    log(
      `Install it yourself: claude plugin marketplace add "${root}" && claude plugin install ${PLUGIN_ID}`,
    );
    return 0;
  }
  if (!claude(["--version"]).ok) {
    log(
      "Couldn't find Claude Code (the claude command). Install it, then run `encela setup` again.",
    );
    return 1;
  }
  const added = claude(["plugin", "marketplace", "add", root]);
  if (!added.ok) {
    const updated = claude(["plugin", "marketplace", "update", MARKETPLACE]);
    if (!updated.ok) {
      log(`Couldn't add the marketplace:\n${added.out}`);
      return 1;
    }
  }
  const done = claude(["plugin", "install", PLUGIN_ID, "--scope", "user"]);
  if (!done.ok && !/already/i.test(done.out)) {
    log(`Couldn't install the plugin:\n${done.out}`);
    return 1;
  }
  claude(["plugin", "update", PLUGIN_ID, "--scope", "user"]);
  log(
    `Done. Start a new Claude Code session (or run /reload-plugins).\n- Just write your request: Encela has Claude start with a blueprint${opts.auto ? "" : " (automatic hook off: use the command)"}.\n- Or run /encela:go <request>.${opts.view ? "\n- /encela-view shows what is being built: the steps, the pieces and the workers." : ""}`,
  );
  return 0;
}

export function uninstall(log: (s: string) => void = console.log): number {
  const removed = claude(["plugin", "uninstall", PLUGIN_ID, "--scope", "user"]);
  claude(["plugin", "marketplace", "remove", MARKETPLACE]);
  rmSync(join(home(), "claude-plugin"), { recursive: true, force: true });
  log(
    removed.ok
      ? `Removed the Claude Code plugin. Your own pieces stay in ${new Registry().file}.`
      : `The plugin wasn't installed (or claude isn't available):\n${removed.out}`,
  );
  return 0;
}
