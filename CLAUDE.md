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
- `src/blueprint.ts` blueprint shape, checks, rendering, storage, what an approval records. `assemble.ts` working copies and worker briefs. `seal.ts` the key in the user's Encela folder that makes an approval or a run count.
- `src/pipeline.ts` pipeline shape, checks before a run, `{{ }}` references, marks and fingerprints. `engine.ts` runs (scheduling, each, retries, waiting claude steps, state on disk, reports). `jq.ts` the expression language (own jq subset, cases recorded from jq 1.7 in `test/fixtures/jq-cases.json` and `jq-review-cases.json`; `jq-review-cases.gen.mjs` records the latter again where jq 1.7 is installed). `sandbox.ts` evaluates expressions in a worker thread with a time limit. `schema.ts` a small JSON Schema check. `tools.ts` cache of each MCP piece's tool list.
- `src/server.ts` the MCP server (15 tools, the hub that starts MCP pieces on demand, the approval gate, the pipeline tools). `client.ts` MCP client for the pieces.
- `src/hook.ts` UserPromptSubmit hook. `setup.ts` writes and installs the plugin. `cli.ts` the command.
- `src/live.ts` what Encela is doing right now, kept as `.encela/live.json` for the view: written before each tool's answer, and a moment after anything changes in between. Nothing reads it back.
- `plugin/` the plugin's static files: `skills/orchestrate/SKILL.md` (the orchestrator's instructions), `agents/assembler.md`, `agents/pipeliner.md`.
- `plugin/hooks/view.tsx` the view (작업 화면): a hooks module Claude Code runs itself, a pane (`/encela-view`) and one line above the prompt. `hooks/model.ts` works out what to show from the state alone, and how each line looks at each tick (no drawing, tested by `test/view.test.mjs`). `hooks/motion.tsx` is a surface module: where the surface redraws a region by itself (terminal, desktop app) Claude Code runs it on its drawing thread, and it moves the lines (spinners, a pulse, a light along the bar, a flash on change); elsewhere `view.tsx` draws them as they stand. `types/index.d.ts` the shapes the server and the view share, and what the view keeps in the session's state. `tests/view.test.tsx` runs inside Claude Code (`pnpm check:view`), and stays out of the package.
- `docs/pipeline-design.md` why pipelines work the way they do (the draft, the critique, the decisions).
- `catalog/` bundled pieces: `builtin/`, `external/<source>/` (with LICENSE), `modules.json` (MCP servers, CLIs, libraries: not bundled, only how to start or add them). `build.mjs` turns it into `dist/catalog.json`. `candidates/` is research output: what was checked at its source, the manifest of converted documents, and `check_docs.py`, which prints how each bundled document differs from its source.

## Commands

```bash
pnpm lint        # Biome; `pnpm format` to fix
pnpm typecheck
pnpm test        # builds, then node --test
pnpm check:view  # the view, checked by Claude Code itself (`claude plugin validate` and `plugin test`)
```

Run the first three before committing, and `pnpm check:view` after touching `plugin/hooks`, `plugin/types` or `src/live.ts` (CI can't: it needs the `claude` command). To try it in Claude Code: `node dist/cli.js setup` (or `--no-claude` and `claude --plugin-dir ~/.encela/claude-plugin/plugins/encela`).

## Rules

- Nothing is assembled or run before the user approves the blueprint. A piece Claude found outside (`origin: external`) is untrusted until a blueprint with it is approved. Don't add paths around this.
- The project folder is not trusted: a repository can ship its own `.encela/`. An approval and a run count only with this computer's seal (`src/seal.ts`); a blueprint without one is a draft, a run folder without one is ignored. Build every path under `.encela` with `inEncela` (it refuses links), write a run's files with the engine's `put`, and never take a path from a file in the project.
- Pipelines: a marked call runs only if the user saw it, as it is, when approving, and only after a direct approval (the user answered Encela's own question). "As it is" includes where it is, its `when` and `retry`, and every step and input that feeds it (`stepPrint`, `feeds` in `pipeline.ts`): anything new that decides what a marked call does belongs in that print and in the approval text. A question the client closed unanswered (Claude Code does this without a terminal) is not an answer: the approval is then relayed through Claude and marked calls stay off. A call whose fate is unknown (timeout, lost connection) is never repeated automatically unless the tool is known to be read-only or idempotent. The server reads and writes only inside `.encela/`. Expressions never run in the server's own thread.
- The view only watches. Its hooks hand every call on unchanged and never fail one (what goes wrong while watching is swallowed), and a session that calls no Encela tool pays one check per call. `.encela/live.json` is a file in the project, so the view takes it only as a plain file where Encela keeps it, in the folder the session was in when it first called Encela, written since then and not dated ahead of now, and reads it field by field (`parse` in `model.ts`). A line handed to `motion.tsx` holds no key without a value (Claude Code refuses such props and the pane goes blank), a frame keeps to its rows with the step in progress in it, and a tool's answer never waits for the view's reading. Claude Code lets `$` go only to functions declared at the top of the module: keep it that way or `claude plugin validate` fails. Motion says that something is going on: nothing moves once Claude's turn is over and no run or call is out, and the clock then asks for no redraw. Colours are the theme's keys, never raw ones, and a worker's colour is none of those that say how things stand.
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
3. [x] Pipeline engine: blueprint `pipelines` run inside the server (tool, transform and Claude steps), results kept out of context
4. [ ] GitHub finder: search, read a repository, draft a piece
5. [ ] Recipes: save a blueprint that worked and reuse it

## Open

- Stage 3 was reviewed adversarially (five reviewers, every finding reproduced and re-checked); what it changed is in `docs/pipeline-design.md`, "Decisions after the review", and each finding has a test. An interactive session was run since (Claude Code 2.1.325 in a terminal): Encela's approval dialog was answered there and counted as direct, and the view drew the whole flow. Not checked: Windows beyond CI, the view on the desktop app, in VS Code and on a phone (only through Claude Code's test kit, which draws each surface's tree).
- The MCP entries added to the catalog last (each carries the warning "Not start-tested by Encela yet") were not started: running that many third-party servers was not permitted in the session that added them. `encela` has no command yet that start-tests an entry on the user's machine: worth adding.
- `src/jq.ts` differs from jq 1.7 in 18 recorded cases (`test/fixtures/jq-known-differences.json`, each with its reason).
