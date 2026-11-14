// Builds the package: bundles src/cli.ts into one file and gathers what it
// ships with: the catalog as one list of pieces (dist/catalog.json), each
// external source's LICENSE text, and the Claude Code plugin's files.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = join(here, "catalog");
const dist = join(here, "dist");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "licenses"), { recursive: true });

/** `key: value` lines and `key:` + `  - item` lists, as the catalog writes them. */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      fm[list].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    list = null;
    if (kv[2] === "") {
      fm[kv[1]] = [];
      list = kv[1];
    } else fm[kv[1]] = unquote(kv[2]);
  }
  return { fm, body: text.slice(m[0].length).trim() };
}

function unquote(v) {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t.replace(/^'(.*)'$/, "$1");
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

const DOC_KINDS = { instruction: "instruction", rule: "rule", skill: "skill", agent: "subagent" };
const pieces = [];

/** A catalog Markdown file as a document piece. */
function addDocument(source, dir, file) {
  const parsed = frontmatter(readFileSync(join(dir, file), "utf8"));
  const kind = parsed && DOC_KINDS[parsed.fm.kind];
  if (!kind) return;
  const { fm, body } = parsed;
  const stem = file.replace(/\.md$/, "");
  // Reference files a skill keeps next to its SKILL.md.
  const files = {};
  const companions = join(dir, stem);
  if (existsSync(companions) && statSync(companions).isDirectory()) {
    for (const rel of walk(companions)) files[rel] = readFileSync(join(companions, rel), "utf8");
  }
  const category = [fm.category_en, fm.category].filter(Boolean);
  pieces.push({
    id: source === "builtin" ? `${kind}:${stem}` : `${kind}:${source}/${stem}`,
    kind,
    name: fm.name || stem,
    title: { ko: fm.title || stem, en: fm.title_en || fm.title || stem },
    summary: { ko: fm.summary || "", en: fm.summary_en || fm.summary || "" },
    detail: [fm.description, fm.detail_en].filter(Boolean).join(" "),
    tags: [...new Set(category)],
    capabilities: [],
    inputs: [],
    outputs: [],
    origin: "builtin",
    trusted: true,
    source: fm.source_repo
      ? {
          repo: fm.source_repo,
          commit: fm.source_commit || "",
          path: fm.source_path || "",
          license: fm.license || "",
          copyright: fm.copyright || "",
        }
      : null,
    license: fm.license || pkg.license,
    warnings: [],
    body,
    paths: Array.isArray(fm.paths) ? fm.paths : [],
    files,
    config: null,
    install: [],
    guide: "",
    needs: "",
  });
}

for (const f of readdirSync(join(catalog, "builtin")).sort()) {
  if (f.endsWith(".md")) addDocument("builtin", join(catalog, "builtin"), f);
}
for (const source of readdirSync(join(catalog, "external")).sort()) {
  const dir = join(catalog, "external", source);
  for (const f of readdirSync(dir).sort()) if (f.endsWith(".md")) addDocument(source, dir, f);
  const licenses = readdirSync(dir).filter((f) => /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(f));
  if (licenses.length) mkdirSync(join(dist, "licenses", source), { recursive: true });
  for (const l of licenses) copyFileSync(join(dir, l), join(dist, "licenses", source, l));
}

// MCP servers, command line tools and libraries: not bundled, only how to start them.
const modules = JSON.parse(readFileSync(join(catalog, "modules.json"), "utf8"));
for (const m of modules.modules) {
  pieces.push({
    id: `${m.kind}:${m.name}`,
    kind: m.kind,
    name: m.name,
    title: { ko: m.name, en: m.name },
    summary: m.description,
    detail: "",
    tags: m.tags ?? [],
    capabilities: m.capabilities ?? [],
    inputs: m.inputs ?? [],
    outputs: m.outputs ?? [],
    origin: "builtin",
    trusted: true,
    source: m.source
      ? {
          repo: m.source.repo,
          commit: m.source.commit || "",
          path: "",
          license: m.source.license || "",
          copyright: "",
        }
      : null,
    license: m.source?.license || "",
    warnings: m.warnings?.en ?? [],
    body: "",
    paths: [],
    files: {},
    config: m.config ?? null,
    install: m.install ?? [],
    guide: m.guide?.en ?? "",
    needs: m.needs ?? "",
  });
}

const ids = new Set();
for (const p of pieces) {
  if (ids.has(p.id)) throw new Error(`Two catalog pieces share the id ${p.id}`);
  ids.add(p.id);
}
writeFileSync(join(dist, "catalog.json"), JSON.stringify({ version: pkg.version, pieces }));
cpSync(join(here, "plugin"), join(dist, "plugin"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
};
await build({
  ...common,
  entryPoints: [join(here, "src", "cli.ts")],
  outfile: join(dist, "cli.js"),
  banner: { js: "#!/usr/bin/env node" },
});
if (process.argv.includes("--test")) {
  await build({
    ...common,
    entryPoints: [join(here, "src", "lib.ts")],
    outfile: join(here, "test", ".build", "lib.js"),
  });
  // The expression language is tested on its own.
  if (existsSync(join(here, "src", "jq.ts"))) {
    await build({
      ...common,
      entryPoints: [join(here, "src", "jq.ts")],
      outfile: join(here, "test", ".build", "jq.js"),
    });
  }
}
const count = (kinds) => pieces.filter((p) => kinds.includes(p.kind)).length;
console.log(
  `encela ${pkg.version}: ${pieces.length} pieces (${count(["mcp", "cli", "library"])} modules, ${count(["skill", "rule", "instruction", "subagent"])} documents)`,
);
