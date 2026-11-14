import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Blueprints,
  catalogPieces,
  cautions,
  exposed,
  hookCommandFor,
  hookContext,
  launcherFor,
  normalizeBlueprint,
  normalizePiece,
  permissive,
  Registry,
  ready,
  render,
  Server,
  search,
  wantsEncela,
  writePlugin,
} from "./.build/lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const temp = (name) => mkdtempSync(join(tmpdir(), `encela-${name}-`));
const echo = {
  kind: "mcp",
  name: "echo",
  summary: "Says things back",
  capabilities: ["echo"],
  config: { command: process.execPath, args: [join(here, "fixtures", "echo-server.mjs")] },
  source: { repo: "https://github.com/someone/echo.git", commit: "abc123def4567890" },
};
const said = (result) => result.content[0].text;

/** A server in a fresh project and Encela folder, with what it sent. */
function start(capabilities = {}) {
  const sent = [];
  const registry = new Registry(temp("home"));
  const project = temp("project");
  const server = new Server((m) => sent.push(m), { project, registry });
  const ready = server.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities },
  });
  return { server, sent, registry, project, ready };
}

test("the catalog is one list of pieces with unique ids", () => {
  const pieces = catalogPieces();
  assert.ok(pieces.length > 100);
  assert.equal(new Set(pieces.map((p) => p.id)).size, pieces.length);
  for (const kind of ["mcp", "cli", "skill", "rule", "instruction", "subagent"]) {
    assert.ok(
      pieces.some((p) => p.kind === kind),
      kind,
    );
  }
  const skill = pieces.find((p) => p.id === "skill:obra_superpowers/writing-plans");
  assert.equal(skill.source.repo, "obra/superpowers");
  assert.equal(skill.license, "MIT");
  assert.ok(skill.body.length > 100);
  assert.ok(pieces.every((p) => p.trusted && p.origin === "builtin"));
  // Reference files travel with their skill.
  const harness = pieces.find((p) => p.id === "skill:revfactory_harness/harness");
  assert.ok(Object.keys(harness.files).some((f) => f.startsWith("references/")));
});

test("search ranks by name and what a piece does, across queries", () => {
  const pieces = catalogPieces();
  const top = search(pieces, ["mermaid diagram"]).slice(0, 2);
  assert.ok(top.some((m) => m.piece.id === "mcp:mcp-mermaid"));
  assert.ok(!search(pieces, ["pack"]).some((m) => m.piece.id.includes("laravel-package")));
  const rust = search(pieces, ["rust"], { kinds: ["rule", "subagent"] }).map((m) => m.piece.id);
  assert.ok(rust.includes("rule:rust"));
  assert.ok(rust.every((id) => /^(rule|subagent):/.test(id)));
  assert.deepEqual(search(pieces, ["zzzqqq"]), []);
  assert.deepEqual(search(pieces, ["the and of"]), []);
  // Korean titles match too.
  assert.ok(search(pieces, ["리팩터링"]).length > 0);
});

test("a piece is checked when it is added", () => {
  assert.throws(() => normalizePiece({ kind: "mcp", name: "x" }, "user", true), /summary/);
  assert.throws(
    () => normalizePiece({ kind: "mcp", name: "x", summary: "s" }, "user", true),
    /config.command/,
  );
  assert.throws(
    () => normalizePiece({ kind: "skill", name: "x", summary: "s" }, "user", true),
    /body/,
  );
  assert.throws(() => normalizePiece({ kind: "nope", name: "bad name" }, "user", true), /kind/);
  const p = normalizePiece(echo, "external", false);
  assert.equal(p.id, "mcp:echo");
  assert.equal(p.source.repo, "someone/echo");
  assert.equal(p.config.transport, "stdio");
  const notes = cautions(p).join("\n");
  assert.match(notes, /Not from Encela's catalog.*someone\/echo@abc123def4/);
  assert.match(notes, /No license stated/);
  assert.match(notes, /Starts a program on this computer/);
  assert.ok(permissive("MIT") && permissive("Apache-2.0") && !permissive("GPL-3.0"));
  const needs = normalizePiece(
    { ...echo, config: { ...echo.config, env: { KEY: "$" + "{ENCELA_TEST_MISSING}" } } },
    "user",
    true,
  );
  assert.match(cautions(needs).join("\n"), /ENCELA_TEST_MISSING/);
});

test("the registry keeps the user's pieces apart from the catalog", () => {
  const registry = new Registry(temp("home"));
  const before = registry.all().length;
  const mine = registry.add(
    { kind: "skill", name: "mine", summary: "Mine", body: "Do it" },
    "user",
  );
  assert.ok(mine.trusted);
  const found = registry.add(echo, "claude");
  assert.equal(found.trusted, false);
  assert.equal(found.origin, "external");
  assert.equal(registry.all().length, before + 2);
  assert.equal(registry.get("echo").id, "mcp:echo");
  assert.throws(() => registry.get("nothing-like-this"), /No piece/);
  assert.throws(
    () =>
      registry.add(
        { kind: "mcp", name: "repomix", summary: "s", config: { command: "x" } },
        "user",
      ),
    /already in Encela's catalog/,
  );
  registry.trust(["mcp:echo"]);
  assert.ok(registry.get("mcp:echo").trusted);
  // The same piece again stays accepted; one that runs something else doesn't.
  assert.ok(registry.add(echo, "claude").trusted);
  const other = { ...echo, config: { command: "other" } };
  assert.equal(registry.add(other, "claude").trusted, false);
  assert.ok(registry.remove("mcp:echo"));
  assert.equal(registry.remove("mcp:echo"), false);
  assert.equal(registry.own().length, 1);
});

test("earlier modules files are taken in as pieces", () => {
  const dir = temp("legacy");
  const file = join(dir, "mcp-hub.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      servers: [
        { name: "repomix", kind: "mcp", description: "already in the catalog" },
        {
          name: "my-server",
          kind: "mcp",
          description: "My server",
          config: { transport: "stdio", command: "node", args: ["s.js"], env: {} },
          source: { repo: "me/my-server", commit: "", license: "MIT", licenseOk: true },
        },
        { name: "broken", kind: "mcp", description: "no command" },
      ],
    }),
  );
  const registry = new Registry(dir);
  const added = registry.importLegacy(file);
  assert.deepEqual(
    added.map((p) => p.id),
    ["mcp:my-server"],
  );
  assert.equal(registry.get("mcp:my-server").license, "MIT");
});

const draft = {
  request: "Draw this repository's structure",
  goal: "A diagram of the repository's modules",
  requirements: ["Mermaid", "one file"],
  pieces: [
    { piece: "cli:ast-grep", role: "Pack the repository", why: "One file to read" },
    { piece: "mcp:mcp-mermaid", role: "Draw the diagram", why: "Renders Mermaid" },
    {
      piece: "skill:obra_superpowers/writing-plans",
      role: "Plan the work",
      why: "Keeps steps small",
      adapt: "Use pnpm",
    },
    { piece: "rule:rust", role: "Rust conventions", why: "The repo is Rust" },
  ],
  workers: [{ name: "mapper", role: "Reads the code" }],
  steps: [
    { id: "pack", title: "Pack the repo", worker: "mapper", pieces: ["cli:ast-grep"] },
    { id: "draw", title: "Draw", pieces: ["mcp-mermaid"], after: ["pack"] },
    { id: "plan", title: "Plan", pieces: ["skill:obra_superpowers/writing-plans"] },
  ],
  choices: [{ question: "Which direction?", options: ["top-down", "left-right"] }],
};

test("a blueprint is checked against the registry and rendered for the user", () => {
  const registry = new Registry(temp("home"));
  const b = normalizeBlueprint(draft, registry, null, new Date("2026-11-14T00:00:00Z"));
  assert.equal(b.id, "a-diagram-of-the-repository-s-modules-20261114");
  assert.equal(b.status, "draft");
  assert.equal(b.steps[1].pieces[0], "mcp:mcp-mermaid");
  assert.equal(b.steps[1].worker, "main");
  assert.deepEqual(
    ready(b).map((s) => s.id),
    ["pack", "plan"],
  );
  const shown = render(b, registry);
  assert.match(shown, /# Blueprint: A diagram/);
  assert.match(shown, /mcp-mermaid \(mcp:mcp-mermaid\): Draw the diagram/);
  assert.match(shown, /Adapted for this build: Use pnpm/);
  assert.match(shown, /Which direction\? \(top-down \/ left-right\)/);

  const bad = {
    goal: "",
    pieces: [{ piece: "mcp:nope", role: "x" }, { piece: "cli:ast-grep" }],
    workers: [{ name: "main" }],
    steps: [
      { id: "a", title: "A", worker: "ghost", pieces: ["rule:rust"], after: ["b"] },
      { id: "b", title: "", after: ["a"] },
    ],
  };
  assert.throws(
    () => normalizeBlueprint(bad, registry, null),
    (e) => {
      for (const part of [
        "goal is missing",
        'no piece "mcp:nope"',
        "cli:ast-grep has no role",
        'other than "main"',
        'worker "ghost"',
        "isn't in this blueprint's pieces",
        "b has no title",
      ]) {
        assert.ok(e.message.includes(part), part);
      }
      return true;
    },
  );
  assert.throws(
    () =>
      normalizeBlueprint(
        {
          goal: "g",
          steps: [
            { id: "a", title: "A", after: ["b"] },
            { id: "b", title: "B", after: ["a"] },
          ],
        },
        registry,
        null,
      ),
    /circle/,
  );
});

test("changing an approved blueprint's pieces asks again; changing steps doesn't", () => {
  const registry = new Registry(temp("home"));
  const approved = { ...normalizeBlueprint(draft, registry, null), status: "approved" };
  approved.approvedAt = approved.createdAt;
  const moreSteps = { ...draft, steps: [...draft.steps, { id: "check", title: "Check" }] };
  assert.equal(normalizeBlueprint(moreSteps, registry, approved).status, "approved");
  const fewerPieces = { ...draft, pieces: draft.pieces.slice(0, 3) };
  const again = normalizeBlueprint(fewerPieces, registry, approved);
  assert.equal(again.status, "draft");
  assert.equal(again.approvedAt, null);
  assert.equal(again.id, approved.id);
});

test("the whole flow: save, approve, assemble, build, done", async () => {
  const { server, sent, registry, project, ready: init } = start();
  await init;
  const call = (name, args) => server.call(name, args);

  const found = said(
    await call("find_pieces", { queries: ["structural search rewrite", "mermaid diagram"] }),
  );
  assert.match(found, /cli:ast-grep/);
  assert.match(found, /mcp:mcp-mermaid/);
  assert.match(said(await call("get_piece", { id: "cli:ast-grep" })), /How to use it:/);

  // A piece from outside waits for the user.
  const added = said(await call("piece_add", { piece: echo }));
  assert.match(added, /Kept mcp:echo.*once the user approves/s);
  const early = await call("piece_open", { id: "mcp:echo" });
  assert.ok(early.isError);
  assert.match(said(early), /hasn't approved/);

  const blueprint = {
    ...draft,
    pieces: [
      ...draft.pieces.filter((p) => p.piece !== "mcp:mcp-mermaid"),
      {
        piece: "mcp:echo",
        role: "Say it back",
        why: "For the test",
        tools: ["echo"],
        env: { ECHO_PREFIX: ">" },
      },
    ],
    steps: [
      { id: "pack", title: "Pack the repo", worker: "mapper", pieces: ["cli:ast-grep"] },
      { id: "say", title: "Say", pieces: ["mcp:echo"], after: ["pack"] },
      { id: "plan", title: "Plan", pieces: ["skill:obra_superpowers/writing-plans"] },
    ],
  };
  const saved = said(await call("blueprint_save", { blueprint }));
  assert.match(saved, /! Not from Encela's catalog/);
  assert.match(saved, /Only these tools: echo/);
  assert.match(saved, /call blueprint_approve/);
  const id = new Blueprints(project).list()[0].id;
  assert.ok(existsSync(join(project, ".encela", ".gitignore")));

  // Nothing is assembled before the user approves.
  const tooSoon = await call("blueprint_assemble", { id });
  assert.ok(tooSoon.isError);
  assert.match(said(tooSoon), /approve it first/);
  assert.match(said(await call("blueprint_approve", { id })), /hasn't decided yet/);
  const revise = said(
    await call("blueprint_approve", { id, user_answer: "revise", note: "no rust" }),
  );
  assert.match(revise, /wants changes: no rust/);
  assert.equal(new Blueprints(project).get(id).status, "draft");
  assert.match(said(await call("blueprint_approve", { id, user_answer: "approve" })), /Approved/);
  assert.ok(registry.get("mcp:echo").trusted);

  const assembled = said(await call("blueprint_assemble", { id }));
  assert.match(assembled, /mcp:echo is running with 1 tools/);
  assert.match(assembled, /## Adapt first/);
  assert.match(assembled, /Worker "mapper": Reads the code/);
  assert.match(assembled, /rule:rust \(Rust conventions\)/); // no step names it: everyone gets it
  assert.match(assembled, /Can start now: pack \(mapper\), plan \(main\)/);
  const copy = join(
    project,
    ".encela",
    "build",
    id,
    "skills",
    "obra_superpowers__writing-plans",
    "SKILL.md",
  );
  const copied = readFileSync(copy, "utf8");
  assert.match(copied, /^---\nname: writing-plans\n/);
  assert.match(copied, /license: MIT/);
  assert.match(copied, /source: https:\/\/github.com\/obra\/superpowers\/blob\//);
  assert.match(copied, /encela_piece: skill:obra_superpowers\/writing-plans/);
  assert.ok(existsSync(join(project, ".encela", "build", id, "rules", "rust.md")));

  // The MCP piece's allowed tool is in the list, and runs with the blueprint's settings.
  const names = (await server.toolList()).map((t) => t.name);
  assert.ok(names.includes("echo__echo"));
  assert.ok(!names.includes("echo__add"));
  assert.equal(said(await call("echo__echo", { text: "hi" })), ">hi");
  assert.equal(
    said(await call("piece_call", { id: "mcp:echo", tool: "echo", arguments: { text: "yo" } })),
    ">yo",
  );
  const blocked = await call("piece_call", { id: "mcp:echo", tool: "add", arguments: {} });
  assert.match(said(blocked), /doesn't allow/);
  assert.equal(JSON.parse(said(await call("piece_tools", { id: "mcp:echo" }))).length, 1);

  // An adapted copy survives assembling again.
  writeFileSync(copy, "adapted");
  assert.match(said(await call("blueprint_assemble", { id })), /kept the one already there/);
  assert.equal(readFileSync(copy, "utf8"), "adapted");

  assert.match(
    said(await call("blueprint_step", { id, step: "pack", status: "done", note: "ok" })),
    /say \(main\)/,
  );
  assert.match(said(await call("blueprint_get", {})), /\[x\] pack \[mapper\] Pack the repo/);
  await call("blueprint_step", { id, step: "say", status: "done" });
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "blueprint_step", arguments: { id, step: "plan", status: "done" } },
  });
  const last = said(reply.result);
  assert.match(last, /Every step of .* is done/);
  assert.equal(new Blueprints(project).get(id).status, "done");
  assert.ok(!(await server.toolList()).some((t) => t.name === "echo__echo"));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sent.some((m) => m.method === "notifications/tools/list_changed"));
  server.closeAll();
});

test("the user is asked directly when the client can ask", async () => {
  const { server, sent, project, ready: init } = start({ elicitation: {} });
  await init;
  await server.call("blueprint_save", { blueprint: { goal: "g", steps: [{ title: "Do it" }] } });
  const id = new Blueprints(project).list()[0].id;
  const answer = (content, action = "accept") => {
    const asked = sent.find((m) => m.method === "elicitation/create" && !m.answered);
    asked.answered = true;
    assert.match(asked.params.message, /Approve this blueprint\?/);
    return server.handle({ jsonrpc: "2.0", id: asked.id, result: { action, content } });
  };
  // What Claude passes doesn't count when the user can answer for themselves.
  let pending = server.call("blueprint_approve", { id, user_answer: "approve" });
  await answer({ decision: "revise", note: "smaller" });
  assert.match(said(await pending), /wants changes: smaller/);
  pending = server.call("blueprint_approve", { id });
  await answer({}, "cancel");
  assert.match(said(await pending), /closed the approval question without deciding/);
  assert.equal(new Blueprints(project).get(id).status, "draft");
  pending = server.call("blueprint_approve", { id });
  await answer({ decision: "approve" });
  assert.match(said(await pending), /Approved/);
  assert.equal(new Blueprints(project).get(id).status, "approved");
});

test("the server speaks MCP: tools, prompt, unknown methods", async () => {
  const { server, ready: init } = start();
  const hello = await init;
  assert.equal(hello.result.serverInfo.name, "encela");
  assert.match(hello.result.instructions, /blueprint_approve/);
  const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.result.tools.map((t) => t.name);
  assert.equal(names.length, 15);
  for (const n of names) assert.ok(`mcp__plugin_encela_encela__${n}`.length <= 64, n);
  const go = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/get",
    params: { name: "go", arguments: { request: "make a car" } },
  });
  assert.match(go.result.messages[0].content.text, /^make a car\n\n\[Encela\]/);
  const unknown = await server.handle({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(unknown.error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.ok(exposed("a-very-long-piece-name-indeed", "and_a_very_long_tool_name_too").length <= 37);
});

test("the prompt hook points at a blueprint, or at the one being built", () => {
  const registry = new Registry(temp("home"));
  const project = temp("project");
  assert.equal(hookContext("/help", project, registry), null);
  assert.equal(hookContext("ok", project, registry), null);
  assert.equal(hookContext("<task-notification>done</task-notification>", project, registry), null);
  assert.ok(!wantsEncela("continue [Encela] note"));
  const fresh = hookContext("Draw a mermaid diagram of this repository", project, registry);
  assert.match(fresh, /^\[Encela\] If this request builds/);
  assert.match(fresh, /mcp:mcp-mermaid/);
  const plain = hookContext("zzzqqq something entirely unrelated", project, registry);
  assert.ok(plain && !plain.includes("Pieces whose keywords match"));

  const store = new Blueprints(project);
  const b = normalizeBlueprint({ goal: "A car", steps: [{ title: "Wheels" }] }, registry, null);
  store.save({ ...b, status: "assembled" });
  const active = hookContext("now add the doors please", project, registry);
  assert.match(active, /The blueprint a-car-\d+ \("A car"\) is assembled, 0\/1 steps done/);
});

test("the plugin is written with its skill, subagent, hook and server", () => {
  const root = writePlugin(join(temp("plugin"), "claude-plugin"));
  const plugin = join(root, "plugins", "encela");
  const read = (...p) => readFileSync(join(plugin, ...p), "utf8");
  assert.match(read("skills", "orchestrate", "SKILL.md"), /^---\nname: orchestrate\n/);
  assert.match(read("agents", "assembler.md"), /^---\nname: assembler\n/);
  assert.match(read("commands", "go.md"), /\$ARGUMENTS/);
  const mcp = JSON.parse(read(".mcp.json")).mcpServers.encela;
  assert.equal(mcp.args.at(-1), "mcp");
  const hooks = JSON.parse(read("hooks", "hooks.json")).hooks.UserPromptSubmit[0].hooks[0];
  assert.match(hooks.command, / hook$/);
  assert.equal(JSON.parse(read(".claude-plugin", "plugin.json")).name, "encela");
  assert.ok(!existsSync(join(writePlugin(root, false), "plugins", "encela", "hooks")));
});

test("the plugin starts Encela the right way on each OS", () => {
  const cli = "C:\\Users\\me\\AppData\\npm\\node_modules\\encela\\dist\\cli.js";
  assert.deepEqual(launcherFor("win32", true, cli, "node.exe"), {
    command: "cmd",
    args: ["/c", "encela"],
  });
  assert.deepEqual(launcherFor("linux", false, "/x/cli.js", "/usr/bin/node"), {
    command: "/usr/bin/node",
    args: ["/x/cli.js"],
  });
  assert.equal(launcherFor("darwin", false, "/h/.npm/_npx/ab/cli.js", "node").command, "npx");
  // The hook runs in a POSIX shell, Git Bash on Windows: no cmd /c, no backslashes.
  assert.equal(hookCommandFor("win32", true, cli, "node.exe"), "encela hook");
  assert.equal(
    hookCommandFor("win32", false, cli, "C:\\Program Files\\nodejs\\node.exe"),
    "'C:/Program Files/nodejs/node.exe' C:/Users/me/AppData/npm/node_modules/encela/dist/cli.js hook",
  );
});
