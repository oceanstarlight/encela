// `encela check`: whether Encela can work on this computer, and whether one
// piece starts here. A piece's start command comes from a README or a
// catalog entry; only starting it on the user's own machine says that it
// works there. The user names the piece, so this is their own doing: an
// outside piece nobody approved yet still asks for `--yes`.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Client } from "./client";
import { home, VERSION } from "./paths";
import { cautions, isDocument, missingEnv, type Piece } from "./piece";
import { marksOf } from "./pipeline";
import { Registry } from "./registry";
import { findOnWindows, launch } from "./spawn";
import { driftText, knownTool, ToolCache } from "./tools";

type Log = (line: string) => void;

/** Where a command is on this computer, or null. */
export function whereIs(
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string | null {
  if (platform === "win32") return findOnWindows(command, { env });
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, command);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** The first line a program prints for `--version`, or "". */
function versionOf(command: string): string {
  try {
    const run = launch(command, ["--version"]);
    const r = spawnSync(run.command, run.args, {
      encoding: "utf8",
      windowsVerbatimArguments: run.verbatim,
      windowsHide: true,
      timeout: 15_000,
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** What Encela needs here, and what its pieces are most often started with. */
function computer(log: Log): number {
  let bad = 0;
  const row = (ok: boolean, name: string, said: string) => {
    if (!ok) bad++;
    log(`${ok ? "ok  " : "MISS"} ${name}${said ? `: ${said}` : ""}`);
  };
  log(`encela ${VERSION}`);
  const major = Number(process.versions.node.split(".")[0]);
  row(
    major >= 20,
    "node",
    `${process.versions.node}${major >= 20 ? "" : " (20 or newer is needed)"}`,
  );
  try {
    mkdirSync(home(), { recursive: true });
    accessSync(home(), constants.W_OK);
    row(true, "Encela folder", home());
  } catch {
    row(false, "Encela folder", `${home()} can't be written`);
  }
  row(
    !!whereIs("claude"),
    "claude",
    whereIs("claude") ? versionOf("claude") : "Claude Code isn't on PATH",
  );
  const manifest = join(
    home(),
    "claude-plugin",
    "plugins",
    "encela",
    ".claude-plugin",
    "plugin.json",
  );
  let plugin = "";
  try {
    plugin = String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "");
  } catch {
    // Not written yet.
  }
  row(
    plugin === VERSION,
    "plugin",
    plugin === VERSION
      ? `written for ${plugin}`
      : plugin
        ? `written for ${plugin}, this is ${VERSION}: run \`encela setup\` again`
        : "not written yet: run `encela setup`",
  );
  // Not needed by Encela itself: most MCP pieces are started with one of them.
  for (const [command, what] of [
    ["npx", "starts the pieces published on npm"],
    ["uvx", "starts the pieces published on PyPI (install uv to have it)"],
  ] as const) {
    const at = whereIs(command);
    log(
      `${at ? "ok  " : "none"} ${command}: ${at ? versionOf(command) || at : `not on PATH; it ${what}`}`,
    );
  }
  log(
    bad
      ? `\n${bad} thing(s) to fix above.`
      : "\nThis computer is ready. `encela check <piece>` starts one piece to see that it works here.",
  );
  return bad ? 1 : 0;
}

export interface CheckOptions {
  yes?: boolean;
  registry?: Registry;
  tools?: ToolCache;
  cwd?: string;
  timeout?: number;
}

/** Starts one piece here and says what it offers. 0 when it works. */
export async function checkPiece(id: string, log: Log, opts: CheckOptions = {}): Promise<number> {
  const registry = opts.registry ?? new Registry();
  const piece: Piece | null =
    registry.find(id) ?? registry.all().find((p) => p.name === id && p.kind === "mcp") ?? null;
  if (!piece) {
    log(`No piece "${id}". \`encela pieces <words>\` searches them.`);
    return 1;
  }
  log(`${piece.id}: ${piece.summary.en}`);
  for (const c of cautions(piece)) log(`  ! ${c}`);
  if (isDocument(piece.kind)) {
    log("A document: nothing to start.");
    return 0;
  }
  if (piece.kind !== "mcp" || !piece.config) {
    const runtime = piece.needs ? whereIs(piece.needs === "uv" ? "uvx" : piece.needs) : null;
    if (piece.needs)
      log(`${runtime ? "ok  " : "MISS"} needs ${piece.needs}${runtime ? "" : ": not on PATH"}`);
    log("Not an MCP server: Encela doesn't start it. Its guide says how it is used.");
    return piece.needs && !runtime ? 1 : 0;
  }
  if (!piece.trusted && !opts.yes) {
    log(
      "\nThis piece was found outside Encela and you haven't approved it in a blueprint. Read what it starts above; `encela check " +
        `${piece.id} --yes\` starts it anyway.`,
    );
    return 1;
  }
  const config = piece.config;
  const missing = missingEnv(config);
  if (missing.length) {
    log(
      `\nMISS environment: set ${missing.join(", ")} first (in your shell's own settings, not in a chat).`,
    );
    return 1;
  }
  if (config.transport === "stdio" && !whereIs(config.command)) {
    log(`\nMISS ${config.command}: not on PATH, so this piece can't start here.`);
    return 1;
  }
  log(
    config.transport === "stdio"
      ? `\nStarting: ${[config.command, ...config.args].join(" ")}`
      : `\nConnecting to ${config.url}`,
  );
  let client: Client;
  const began = Date.now();
  try {
    client = await Client.start(config, opts.cwd ?? process.cwd());
  } catch (e) {
    log(`FAIL ${e instanceof Error ? e.message : e}`);
    if (piece.prepare.length) log(`It needs this ready first: ${piece.prepare.join("; ")}`);
    return 1;
  }
  try {
    const listed = client.tools();
    const known = listed.map(knownTool);
    log(
      `ok   started in ${((Date.now() - began) / 1000).toFixed(1)}s with ${listed.length} tool(s):`,
    );
    for (const t of known.slice(0, 40)) {
      const m = marksOf(t.name, known, !!piece.paid);
      const tags = `${m.changes ? " [may change things]" : ""}${m.outside ? " [may reach outside]" : ""}${m.costs ? " [may cost money]" : ""}`;
      log(`  - ${t.name}${tags}`);
    }
    if (known.length > 40) log(`  ... and ${known.length - 40} more`);
    // Kept as when a blueprint starts it: the next blueprint can be checked against it.
    const cache = opts.tools ?? new ToolCache();
    cache.save(piece.name, config, listed);
    const drift = cache.drift(piece.name, config);
    if (drift) {
      log(
        `\n!    Its tools are not what you accepted before (${driftText(drift)}). Encela holds those back until you approve a blueprint with this piece again.`,
      );
    }
    return 0;
  } finally {
    client.close();
  }
}

export async function check(args: string[], log: Log = console.log): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) return computer(log);
  return checkPiece(id, log, { yes: args.includes("--yes") });
}
