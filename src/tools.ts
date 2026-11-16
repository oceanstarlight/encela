// What Encela knows about the tools of MCP pieces. A piece's tool list
// (names, schemas, annotations) is only known once it has run, so each time
// Encela opens one it keeps the list in `<home>/tools/<piece>.json`. A
// blueprint written later can then be checked against real schemas, and the
// user can be told which tools may change things, before anything starts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths";
import { writeJson } from "./registry";

type Json = Record<string, unknown>;

export interface KnownTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  /** The server says this tool only reads (`annotations.readOnlyHint`). A hint, as trustworthy as the server. */
  readOnly: boolean;
  /** The server doesn't say the tool stays inside this computer (`openWorldHint` isn't false). */
  openWorld: boolean;
  /** The server says calling it again with the same arguments changes nothing more (`idempotentHint`). */
  idempotent: boolean;
  /** Its name or description speaks of money: credits, billing, a purchase. A guess from words. */
  costs: boolean;
}

/** Words that say a call may spend the user's money or credits. */
const MONEY =
  /\b(credits?|billing|billed|charged?|charges|paid|purchases?|buy|payments?|invoices?|checkout|subscription|refund|payout|top[- ]?up|costs? (money|credits))\b/i;

/** Whether a tool's own words say calling it may cost money. */
export const speaksOfMoney = (name: string, description: string) =>
  MONEY.test(name.replace(/[_-]+/g, " ")) || MONEY.test(description);

/**
 * A fingerprint of a tool as its server lists it: the name, every word of
 * its description, its schemas and what it says about itself. The model
 * reads the description as it comes, so one changed word is another tool.
 */
export function toolPrint(t: Json): string {
  const a = (t.annotations ?? {}) as Json;
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(t.name ?? ""),
        String(t.description ?? ""),
        t.inputSchema ?? null,
        t.outputSchema ?? null,
        [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint].map(
          (v) => v ?? null,
        ),
      ]),
    )
    .digest("hex")
    .slice(0, 20);
}

/** How a piece's tools differ from those the user accepted. */
export interface Drift {
  /** Tools whose description, schema or marks are no longer what was accepted. */
  changed: string[];
  /** Tools that were not there when it was accepted. */
  added: string[];
  /** Tools that are gone: said, but nothing to hold back. */
  removed: string[];
}

/** One line on a drift, for the user. */
export function driftText(d: Drift): string {
  const part = (label: string, names: string[]) =>
    names.length
      ? `${label}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}`
      : "";
  return [part("changed", d.changed), part("new", d.added), part("gone", d.removed)]
    .filter(Boolean)
    .join("; ");
}

const MAX_DESCRIPTION = 400;

/** A tool as an MCP server lists it, cut down to what Encela uses. */
export function knownTool(t: Json): KnownTool {
  const annotations = (t.annotations ?? {}) as Json;
  const description = String(t.description ?? "").trim();
  return {
    name: String(t.name ?? ""),
    description:
      description.length > MAX_DESCRIPTION
        ? `${description.slice(0, MAX_DESCRIPTION - 1)}…`
        : description,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    readOnly: annotations.readOnlyHint === true,
    openWorld: annotations.openWorldHint !== false,
    idempotent: annotations.idempotentHint === true,
    costs: speaksOfMoney(String(t.name ?? ""), description),
  };
}

/** A short fingerprint of how a piece is started. */
export function configKey(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(config ?? null))
    .digest("hex")
    .slice(0, 16);
}

/**
 * How a piece is started for one blueprint: its own configuration with the
 * blueprint's extra environment. What a server says about its tools holds
 * for the environment it said it in.
 */
export function withEnv<T extends { env: Record<string, string> }>(
  config: T | null,
  env: Record<string, string> | undefined,
): T | null {
  if (!config || !env || !Object.keys(env).length) return config;
  return { ...config, env: { ...config.env, ...env } };
}

interface Stored {
  piece?: string;
  config?: string;
  at?: string;
  tools?: KnownTool[];
  prints?: Record<string, string>;
  accepted?: Record<string, string>;
}

export class ToolCache {
  constructor(private dir = home()) {}

  private file(piece: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(piece))
      throw new Error(`"${piece}" isn't a piece name`);
    return join(this.dir, "tools", `${piece}.json`);
  }

  /**
   * Keeps the tool list of the MCP piece named `piece`. `config` is how the
   * piece is started: a piece defined anew under the same name is another
   * server, and what the old one said about its tools doesn't hold for it.
   */
  save(piece: string, config: unknown, tools: Json[]) {
    try {
      mkdirSync(join(this.dir, "tools"), { recursive: true });
      const prints: Record<string, string> = {};
      for (const t of tools) if (t.name) prints[String(t.name)] = toolPrint(t);
      // What the user accepted stays, for the piece as it is started now. A
      // list seen for the first time has nothing before it to differ from.
      const before = this.read(piece, config);
      writeJson(this.file(piece), {
        piece,
        config: configKey(config),
        at: new Date().toISOString(),
        tools: tools.map(knownTool).filter((t) => t.name),
        prints,
        accepted: before?.accepted ?? prints,
      });
    } catch {
      // The cache is a convenience; a disk that won't take it changes nothing else.
    }
  }

  private read(piece: string, config: unknown): Stored | null {
    try {
      const file = this.file(piece);
      if (!existsSync(file)) return null;
      const data = JSON.parse(readFileSync(file, "utf8")) as Stored;
      if (data.config !== configKey(config)) return null;
      const map = (v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : null;
      return {
        ...data,
        prints: map(data.prints) ?? undefined,
        accepted: map(data.accepted) ?? undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * How the piece's tools, as last listed, differ from those the user
   * accepted; null when nothing was changed or added (or nothing is known).
   * A server can change what a tool says without any new version: this is
   * how that is seen.
   */
  drift(piece: string, config: unknown): Drift | null {
    const data = this.read(piece, config);
    if (!data?.prints || !data.accepted) return null;
    const now = data.prints;
    const was = data.accepted;
    const changed = Object.keys(now).filter((n) => n in was && was[n] !== now[n]);
    const added = Object.keys(now).filter((n) => !(n in was));
    if (!changed.length && !added.length) return null;
    return { changed, added, removed: Object.keys(was).filter((n) => !(n in now)) };
  }

  /** The user accepted the piece with the tools it lists now. */
  accept(piece: string, config: unknown) {
    try {
      const data = this.read(piece, config);
      if (!data?.prints) return;
      writeJson(this.file(piece), { ...data, accepted: data.prints });
    } catch {
      // Nothing known to accept.
    }
  }

  /** The tools seen the last time the piece ran as it is configured now, or null. */
  load(piece: string, config: unknown): KnownTool[] | null {
    try {
      const file = this.file(piece);
      if (!existsSync(file)) return null;
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        config?: string;
        tools?: KnownTool[];
      };
      if (data.config !== configKey(config)) return null;
      return Array.isArray(data.tools) ? data.tools : null;
    } catch {
      return null;
    }
  }
}
