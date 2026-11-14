# CLAUDE.md

Encela: an npm package (`encela`) that gives Claude Code one MCP server and a plugin. The user writes one request; Claude (the orchestrator, in the user's own session) writes a blueprint, the user approves it, and Encela assembles the pieces it names. Encela never calls a model itself.

Successor of `oceanstarlight/ai-management-pg-fo-desktop` (the desktop app is frozen; its catalog and `packages/encela` hub code were carried over).

## Terms

- Piece (부품): one thing a build can use. Runs: `mcp`, `cli`, `library`. Documents: `skill`, `rule`, `instruction`, `subagent`. One shape for all (`src/piece.ts`).
- Blueprint (설계도): goal, requirements, pieces with roles, workers, steps, choices. Kept in the project as `.encela/blueprints/<id>.json`.
- Assemble (조립): start the blueprint's MCP pieces, write working copies of its documents to `.encela/build/<id>/`. Only copies are adapted; pieces never change.
- Worker (작업자): a Claude Code subagent that does some of the steps.

## Layout

- `src/piece.ts` piece shape, checks, what the user is warned about. `registry.ts` catalog + the user's `~/.encela/pieces.json`. `search.ts` keyword search.
- `src/blueprint.ts` blueprint shape, checks, rendering, storage. `assemble.ts` working copies and worker briefs.
- `src/server.ts` the MCP server (12 tools, the hub that starts MCP pieces on demand, the approval gate). `client.ts` MCP client for the pieces.
- `src/hook.ts` UserPromptSubmit hook. `setup.ts` writes and installs the plugin. `cli.ts` the command.
- `plugin/` the plugin's static files: `skills/orchestrate/SKILL.md` (the orchestrator's instructions), `agents/assembler.md`.
- `catalog/` bundled pieces: `builtin/`, `external/<source>/` (with LICENSE), `modules.json`. `build.mjs` turns it into `dist/catalog.json`.

## Commands

```bash
pnpm lint        # Biome; `pnpm format` to fix
pnpm typecheck
pnpm test        # builds, then node --test
```

Run all three before committing. To try it in Claude Code: `node dist/cli.js setup` (or `--no-claude` and `claude --plugin-dir ~/.encela/claude-plugin/plugins/encela`).

## Rules

- Nothing is assembled or run before the user approves the blueprint. A piece Claude found outside (`origin: external`) is untrusted until a blueprint with it is approved. Don't add paths around this.
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
