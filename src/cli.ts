// The `encela` command.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { check } from "./check";
import { run as runHook } from "./hook";
import { home, lang, VERSION } from "./paths";
import { KINDS, type PieceKind } from "./piece";
import { Recipes, recipeLine } from "./recipe";
import { Registry } from "./registry";
import { line, search } from "./search";
import { run as runServer } from "./server";
import { setup, uninstall } from "./setup";

const HELP = `encela ${VERSION} - Encela for Claude Code

Usage:
  encela setup [--no-auto] [--no-view] [--no-claude] Install the Claude Code plugin
  encela status                                      What Encela has and where
  encela check [piece] [--yes]                       Whether this computer is ready, or whether one piece starts here
  encela pieces [words...] [--kind <kind>]           List or search the pieces
  encela add <file.json>                             Keep a piece of your own (see README for the format)
  encela remove <id>                                 Remove one of your own pieces
  encela recipes [remove <name>]                     List the recipes you kept, or remove one
  encela import [mcp-hub.json]                       Take in the modules of an earlier Encela
  encela uninstall                                   Remove the Claude Code plugin (your pieces stay)
  encela mcp                                         Run the MCP server (the plugin starts it)
  encela hook                                        Run the prompt hook (the plugin starts it)
  encela --version

  --no-auto     Don't add a note to every prompt; use /encela:go <request> instead
  --no-view     Leave out the pane and the line that show a build going on
  --no-claude   Only write the files; install the plugin yourself`;

function status(): number {
  const registry = new Registry();
  const all = registry.all();
  console.log(`encela ${VERSION}`);
  console.log(`Your Encela folder: ${home()}`);
  console.log(`Your own pieces: ${registry.own().length} (${registry.file})`);
  console.log(`Your recipes: ${new Recipes().list().length}`);
  console.log(
    `Pieces: ${all.length} (${KINDS.map((k) => `${all.filter((p) => p.kind === k).length} ${k}`).join(", ")})`,
  );
  return 0;
}

function pieces(args: string[]): number {
  const at = args.indexOf("--kind");
  const kind = at >= 0 ? (args[at + 1] as PieceKind) : undefined;
  const query = args.filter((a, i) => a !== "--kind" && (at < 0 || i !== at + 1)).join(" ");
  const all = new Registry().all();
  const list = query.trim()
    ? search(all, [query], { kinds: kind ? [kind] : undefined, limit: 30 }).map((m) => m.piece)
    : all.filter((p) => !kind || p.kind === kind);
  for (const p of list) console.log(line(p, lang()));
  if (!list.length) console.log("No piece matches.");
  return 0;
}

/** Where an earlier Encela kept its modules, if it did. */
function legacyFile(): string | null {
  const id = "io.github.alsrb060303collab.aimanagement";
  const h = homedir();
  const found = [
    join(home(), "mcp-hub.json"),
    join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), id, "mcp-hub.json"),
    join(h, "Library", "Application Support", id, "mcp-hub.json"),
    join(process.env.XDG_DATA_HOME?.trim() || join(h, ".local", "share"), id, "mcp-hub.json"),
  ].find((f) => existsSync(f));
  return found ?? null;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "--version":
    case "-v":
    case "version":
      console.log(VERSION);
      return 0;
    case "setup":
      return setup({
        auto: !rest.includes("--no-auto"),
        view: !rest.includes("--no-view"),
        noClaude: rest.includes("--no-claude"),
      });
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    case "check":
      return check(rest);
    case "pieces":
      return pieces(rest);
    case "add": {
      if (!rest[0]) throw new Error("Which file? encela add <file.json>");
      const piece = new Registry().add(JSON.parse(readFileSync(rest[0], "utf8")), "user");
      console.log(`Kept ${piece.id}.`);
      return 0;
    }
    case "remove": {
      const gone = new Registry().remove(rest[0] ?? "");
      console.log(gone ? `Removed ${rest[0]}.` : `${rest[0]} isn't one of your own pieces.`);
      return gone ? 0 : 1;
    }
    case "recipes": {
      const recipes = new Recipes();
      if (rest[0] === "remove") {
        const gone = recipes.remove(rest[1] ?? "");
        console.log(gone ? `Removed the recipe ${rest[1]}.` : `No recipe "${rest[1] ?? ""}".`);
        return gone ? 0 : 1;
      }
      const all = recipes.list();
      for (const r of all) console.log(recipeLine(r));
      if (!all.length)
        console.log("No recipe yet. Claude offers to keep one when a build is done.");
      else console.log(`\n${recipes.dir}`);
      return 0;
    }
    case "import": {
      const file = rest[0] ?? legacyFile();
      if (!file)
        throw new Error("Found no earlier modules file. Give its path: encela import <file>");
      const added = new Registry().importLegacy(file);
      console.log(
        `${file}: took in ${added.length} piece(s)${added.length ? `: ${added.map((p) => p.id).join(", ")}` : ""}.`,
      );
      return 0;
    }
    case "mcp":
      await runServer();
      return 0;
    case "hook":
      await runHook();
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

// The bundle is also started as a worker thread to evaluate expressions (src/sandbox.ts); there is no command to run then.
if (isMainThread)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
