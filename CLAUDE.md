# CLAUDE.md

Encela: an npm package (`encela`) that gives Claude Code one MCP server and a plugin. The user writes one request; Claude (the orchestrator, in the user's own session) writes a blueprint, the user approves it, and Encela assembles the pieces it names. Encela never calls a model itself.

Successor of `oceanstarlight/ai-management-pg-fo-desktop` (the desktop app is frozen; its catalog and `packages/encela` hub code were carried over).

## Terms

- Piece (부품): one thing a build can use. Runs: `mcp`, `cli`, `library`. Documents: `skill`, `rule`, `instruction`, `subagent`. One shape for all (`src/piece.ts`).
- Blueprint (설계도): goal, requirements, pieces with roles, workers, steps, choices. Kept in the project as `.encela/blueprints/<id>.json`.
- Assemble (조립): start the blueprint's MCP pieces, write working copies of its documents to `.encela/build/<id>/`. Only copies are adapted; pieces never change.
- Worker (작업자): a Claude Code subagent that does some of the steps.
- Pipeline (파이프라인): a chain of steps in a blueprint that Encela runs itself, passing data from piece to piece: tool steps (a tool of an MCP piece), transform steps (jq), claude steps (handed to Claude, the run waits). A run (실행) keeps its state and outputs in `.encela/runs/<run>/`.
- Marked call: a pipeline tool call that may change things or may reach outside (its server doesn't say otherwise). The user is shown each with its arguments when approving.

## Layout

- `src/piece.ts` piece shape, checks, what the user is warned about. `registry.ts` catalog + the user's `~/.encela/pieces.json`. `search.ts` keyword search.
- `src/blueprint.ts` blueprint shape, checks, rendering, storage, what an approval records. `assemble.ts` working copies and worker briefs.
- `src/pipeline.ts` pipeline shape, checks before a run, `{{ }}` references, marks and fingerprints. `engine.ts` runs (scheduling, each, retries, waiting claude steps, state on disk, reports). `jq.ts` the expression language (own jq subset, cases recorded from jq 1.7 in `test/fixtures/jq-cases.json`). `sandbox.ts` evaluates expressions in a worker thread with a time limit. `schema.ts` a small JSON Schema check. `tools.ts` cache of each MCP piece's tool list.
- `src/server.ts` the MCP server (15 tools, the hub that starts MCP pieces on demand, the approval gate, the pipeline tools). `client.ts` MCP client for the pieces.
- `src/hook.ts` UserPromptSubmit hook. `setup.ts` writes and installs the plugin. `cli.ts` the command.
- `plugin/` the plugin's static files: `skills/orchestrate/SKILL.md` (the orchestrator's instructions), `agents/assembler.md`, `agents/pipeliner.md`.
- `docs/pipeline-design.md` why pipelines work the way they do (the draft, the critique, the decisions).
- `catalog/` bundled pieces: `builtin/`, `external/<source>/` (with LICENSE), `modules.json` (MCP servers, CLIs, libraries: not bundled, only how to start or add them). `build.mjs` turns it into `dist/catalog.json`. `candidates/` is research output: what was checked at its source, the manifest of converted documents, and `check_docs.py`, which prints how each bundled document differs from its source.

## Commands

```bash
pnpm lint        # Biome; `pnpm format` to fix
pnpm typecheck
pnpm test        # builds, then node --test
```

Run all three before committing. To try it in Claude Code: `node dist/cli.js setup` (or `--no-claude` and `claude --plugin-dir ~/.encela/claude-plugin/plugins/encela`).

## Rules

- Nothing is assembled or run before the user approves the blueprint. A piece Claude found outside (`origin: external`) is untrusted until a blueprint with it is approved. Don't add paths around this.
- Pipelines: a marked call runs only if the user saw it, as it is, when approving, and only after a direct approval (the user answered Encela's own question). A call whose fate is unknown (timeout, lost connection) is never repeated automatically unless the tool is known to be read-only or idempotent. The server reads and writes only inside `.encela/`. Expressions never run in the server's own thread.
- Never read, copy or store Claude credentials. Run the user's own `claude` only.
- Windows matters: the plugin's MCP command goes through `cmd /c`, the hook command must not (see `setup.ts`). CI runs the tests on Windows.
- Text Claude reads (tool results, the skill) is English; Claude shows it to the user in their language.
- Bundled catalog content: only MIT, Apache-2.0, BSD, ISC, Zlib, Unlicense, CC0, at a pinned commit, with `license`/`copyright`/`source_*` frontmatter, the LICENSE text in `catalog/external/<source>/`, and a row in `THIRD_PARTY_NOTICES.md`. No scripts, hooks, ads, telemetry. Pieces the user fetches at run time are not bundled and only get warnings.
- Do not use "Claude" or "Anthropic" in the product's name or branding.

## Subagents

- Ask the user before running a workflow or spawning subagents.
- Simple or repetitive work, verification and fact-checking: model `sonnet`. Web research: `sonnet` or `haiku`.
- Heavy reasoning (design critique, hard implementation): `opus` is fine.

## Roadmap

1. [x] Pieces, registry, hub
2. [x] Blueprint, approval, orchestrate skill, hook
3. [ ] Pipeline engine: blueprint `pipelines` run inside the server (tool, transform and Claude steps), results kept out of context
4. [ ] GitHub finder: search, read a repository, draft a piece
5. [ ] Recipes: save a blueprint that worked and reuse it

## In progress (remove when done)

Stage 3, pipeline engine. Everything is written; it has not been compiled or tested yet because `src/jq.ts` was still being built when this was last updated.

- [ ] `src/jq.ts`: own jq subset, built and attacked by a workflow (differential testing against jq 1.7). If it is missing or a stub, that work was cut off: build it to the API in `docs/pipeline-design.md` ("The jq subset") with `compile(source) -> { source, freeVars, refs, run(input, { vars }) }`, `run`, `JqError`
- [ ] `pnpm typecheck`, then `test/pipeline.test.mjs` (engine and server tests, written against the design, never run)
- [ ] Review of the stage 3 code; a real end-to-end run with real MCP pieces and a headless Claude Code run
- [ ] README: tick stage 3 in the roadmap once the above holds

Catalog: done (256 pieces). The new MCP entries were not start-tested (running that many third-party servers was not permitted in the session that added them); each carries a warning. `encela` has no command yet that start-tests an entry on the user's machine: worth adding.
