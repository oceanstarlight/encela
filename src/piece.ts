// A piece: one thing Encela can put into a build. MCP servers, command line
// tools and libraries run; skills, rules, instructions and subagents are
// documents Claude reads. Every kind shares one description, so a blueprint
// can pick and connect them the same way.
import type { Text } from "./paths";

export const RUN_KINDS = ["mcp", "cli", "library"] as const;
export const DOC_KINDS = ["skill", "rule", "instruction", "subagent"] as const;
export const KINDS = [...RUN_KINDS, ...DOC_KINDS] as const;
export type PieceKind = (typeof KINDS)[number];

export const isDocument = (kind: PieceKind) => (DOC_KINDS as readonly string[]).includes(kind);

export interface McpConfig {
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

export interface Source {
  /** `owner/name` on GitHub. */
  repo: string;
  commit: string;
  path: string;
  license: string;
  copyright: string;
}

export interface Piece {
  /** `<kind>:<name>`, or `<kind>:<source>/<name>` for the catalog's external documents. */
  id: string;
  kind: PieceKind;
  name: string;
  title: Text;
  summary: Text;
  /** Longer text on when to use it; only searched. */
  detail: string;
  tags: string[];
  /** What it can do (`search`, `diagram`), and what it takes and gives (`source-code`, `text`). */
  capabilities: string[];
  inputs: string[];
  outputs: string[];
  /** `builtin`: shipped with Encela. `user`: added by the user. `external`: found by Claude. */
  origin: "builtin" | "user" | "external";
  /** Whether the user has accepted it; an untrusted piece runs only after a blueprint with it is approved. */
  trusted: boolean;
  source: Source | null;
  license: string;
  warnings: string[];
  /** Documents: the text, the files it applies to (rules) and reference files next to a skill. */
  body: string;
  paths: string[];
  files: Record<string, string>;
  /** MCP servers: how to start or reach it. */
  config: McpConfig | null;
  /** Set-up commands the user must approve, a usage guide, and the runtime it needs (`node`, `uv`). */
  install: string[];
  guide: string;
  needs: string;
}

const PERMISSIVE = /^(mit|apache-2\.0|bsd-[23]-clause|bsd|isc|zlib|unlicense|cc0-1\.0|0bsd)$/i;

/** Whether `license` allows changing and passing on what it covers. */
export const permissive = (license: string) => PERMISSIVE.test(license.trim());

const EMPTY_CONFIG: McpConfig = {
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

const record = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {};

const both = (v: unknown, fallback: string): Text => {
  if (typeof v === "string" && v.trim()) return { ko: v.trim(), en: v.trim() };
  if (v && typeof v === "object") {
    const t = v as Partial<Text>;
    const en = String(t.en ?? t.ko ?? fallback).trim();
    return { ko: String(t.ko ?? en).trim(), en };
  }
  return { ko: fallback, en: fallback };
};

const MAX_BODY = 200_000;

/**
 * A piece from what a person or Claude wrote: fills what is missing and
 * throws with every problem it finds.
 */
export function normalizePiece(raw: unknown, origin: Piece["origin"], trusted: boolean): Piece {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A piece is a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const kind = String(r.kind ?? "") as PieceKind;
  if (!(KINDS as readonly string[]).includes(kind)) {
    problems.push(`kind must be one of ${KINDS.join(", ")}`);
  }
  const name = String(r.name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    problems.push("name must be 1-64 letters, digits, dots, dashes or underscores");
  }
  const summary = both(r.summary ?? r.description, "");
  if (!summary.en) problems.push("summary is missing: one line on what the piece is for");

  const body = typeof r.body === "string" ? r.body : "";
  const guide = typeof r.guide === "string" ? r.guide : "";
  const install = strings(r.install);
  let config: McpConfig | null = null;
  if (kind === "mcp") {
    const c = (r.config ?? {}) as Partial<McpConfig>;
    config = {
      ...EMPTY_CONFIG,
      transport: String(c.transport ?? (c.url ? "http" : "stdio")),
      command: String(c.command ?? ""),
      args: strings(c.args),
      env: record(c.env),
      url: String(c.url ?? ""),
      headers: record(c.headers),
    };
    if (config.transport === "stdio" && !config.command) {
      problems.push("config.command is missing: what starts the server");
    }
    if (config.transport !== "stdio" && !config.url) {
      problems.push("config.url is missing: where the server is");
    }
  } else if (isDocument(kind)) {
    if (!body.trim()) problems.push("body is missing: the document's text");
    if (body.length > MAX_BODY) problems.push(`body is over ${MAX_BODY} characters`);
  } else if ((KINDS as readonly string[]).includes(kind) && !guide.trim() && !install.length) {
    problems.push("guide is missing: how to use the tool or library");
  }
  if (problems.length) throw new Error(`This piece can't be kept:\n- ${problems.join("\n- ")}`);

  const s = (r.source ?? null) as Partial<Source> | null;
  const source: Source | null =
    s && typeof s === "object" && s.repo
      ? {
          repo: String(s.repo)
            .replace(/^https?:\/\/github\.com\//, "")
            .replace(/\.git$/, ""),
          commit: String(s.commit ?? ""),
          path: String(s.path ?? ""),
          license: String(s.license ?? r.license ?? ""),
          copyright: String(s.copyright ?? ""),
        }
      : null;
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    title: both(r.title, name),
    summary,
    detail: typeof r.detail === "string" ? r.detail : "",
    tags: strings(r.tags),
    capabilities: strings(r.capabilities),
    inputs: strings(r.inputs),
    outputs: strings(r.outputs),
    origin,
    trusted,
    source,
    license: String(r.license ?? source?.license ?? ""),
    warnings: strings(r.warnings),
    body,
    paths: strings(r.paths),
    files: record(r.files),
    config,
    install,
    guide,
    needs: typeof r.needs === "string" ? r.needs : "",
  };
}

/** `${VAR}` names a config needs that aren't set (those with a `:-default` are fine). */
export function missingEnv(config: McpConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const texts = [
    config.command,
    config.url,
    ...config.args,
    ...Object.values(config.env),
    ...Object.values(config.headers),
  ];
  const names = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
      if (!env[m[1] as string]) names.add(m[1] as string);
    }
  }
  return [...names];
}

/** What the user should know before a piece is used: where it is from and what it runs. */
export function cautions(p: Piece): string[] {
  const out: string[] = [];
  if (p.origin === "external") {
    const from = p.source
      ? `${p.source.repo}${p.source.commit ? `@${p.source.commit.slice(0, 10)}` : " (no pinned commit)"}`
      : "an unknown source";
    out.push(`Not from Encela's catalog: found outside, from ${from}`);
  }
  if (p.origin !== "builtin" || !isDocument(p.kind)) {
    if (!p.license) out.push("No license stated");
    else if (!permissive(p.license)) {
      out.push(`License ${p.license}: check before changing or passing it on`);
    }
  }
  if (p.install.length) out.push(`Runs set-up commands: ${p.install.join(" && ")}`);
  if (p.kind === "mcp" && p.config && p.origin !== "builtin") {
    out.push(
      p.config.transport === "stdio"
        ? `Starts a program on this computer: ${[p.config.command, ...p.config.args].join(" ")}`
        : `Connects to ${p.config.url}`,
    );
    // What it is started with, and which of the user's own values it is handed.
    const env = Object.entries(p.config.env);
    const set = env.filter(([, v]) => !/^\$\{[A-Za-z0-9_]+(:-[^}]*)?\}$/.test(v));
    const handed = env.filter(([k, v]) => !set.some(([n]) => n === k) && v !== "");
    if (set.length) out.push(`Sets for it: ${set.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (handed.length) {
      out.push(
        `Is handed your ${handed.map(([k]) => k).join(", ")} from this computer's environment`,
      );
    }
  }
  if (p.config) {
    const missing = missingEnv(p.config);
    if (missing.length) out.push(`Needs the environment variable ${missing.join(", ")}`);
  }
  return [...out, ...p.warnings];
}
