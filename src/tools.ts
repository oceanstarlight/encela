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
      writeJson(this.file(piece), {
        piece,
        config: configKey(config),
        at: new Date().toISOString(),
        tools: tools.map(knownTool).filter((t) => t.name),
      });
    } catch {
      // The cache is a convenience; a disk that won't take it changes nothing else.
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
