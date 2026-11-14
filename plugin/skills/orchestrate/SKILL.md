---
name: orchestrate
description: Turns a request into a blueprint the user approves, then assembles the pieces it needs (MCP servers, CLIs, skills, rules, subagents) and builds with them. Use when a request builds, changes or produces something beyond a quick answer or a small edit, when an "[Encela]" note says to, or for /encela:go.
---

# Orchestrating a build with Encela

You are the orchestrator. The user gave one request; you write the blueprint, they approve it, you assemble the pieces and build. Think of a box of bricks: the user names the model, you draw the instructions, pick the bricks and put them together, and the user has the last word on which bricks go in.

The encela MCP tools do the bookkeeping. Their names end in `find_pieces`, `get_piece`, `piece_add`, `blueprint_save`, `blueprint_get`, `blueprint_approve`, `blueprint_assemble`, `blueprint_step`, `piece_open`, `piece_tools`, `piece_call`, `piece_close`.

Skip all of this for questions, explanations and small edits: just answer.

## 1. Analyse

Work out, from the request and a quick look at the project:

- the goal: one sentence on what will exist when this is done
- the requirements: what it must do, constraints, the stack already in use
- the unknowns: what only the user can decide. These become the blueprint's `choices`, not questions you ask one at a time now.

## 2. Find pieces

Call `find_pieces` with several English keyword queries at once. Search for what the task needs, not for the user's words: "an app like Paint" needs `frontend design`, `canvas drawing`, `e2e testing`; "why is this binary crashing" needs `reverse engineering`, `debugging`.

- Cover each kind of help: tools that do things (kinds `mcp`, `cli`, `library`), know-how (`skill`), conventions for the stack (`rule`, `instruction`), and specialists to hand work to (`subagent`).
- Read the promising ones with `get_piece` before choosing. A piece's `takes` and `gives` tell you which pieces feed each other.
- If something clearly needed is missing, look outside (web search, GitHub), then keep it with `piece_add`: its kind, name, summary, source repository and commit, license, and for an MCP server how to start it. Pieces from outside are shown to the user with warnings and cannot run until the blueprint is approved.
- Keep only pieces that clearly help. Three that fit beat ten that might. A blueprint with no pieces is fine.

## 3. Write the blueprint

Call `blueprint_save` with:

- `request`: the user's words. `goal`, `requirements`.
- `pieces`: for each, `piece` (its id), `role` (what it does in this build), `why` (why this one). For a document, `adapt`: how its working copy should change for this build (for example "use pnpm and Vitest instead of npm and Jest; drop the Docker section"). For an MCP server, optionally `tools` (the only tools to expose) and `env`.
- `workers`: named roles for parts that can run side by side as subagents, each with a `role`. Leave empty for a small build.
- `steps`: ordered, each with `id`, `title`, `detail`, `worker` (a worker's name, or leave out for yourself), `pieces` it uses, and `after` (ids of steps that must finish first). A piece no step names applies to the whole build.
- `choices`: what the user should decide, each with `question` and `options`.

If the tool reports problems, fix them all and save again.

## 4. Get approval

Show the user the blueprint in their language: the goal, every piece with its role and any warning marked `!`, the steps, and the choices. Then call `blueprint_approve`.

- If the tool asks the user itself, wait for its result.
- If it says the user hasn't decided, ask with AskUserQuestion (approve, change something, cancel; include the choices and let them drop or swap pieces), then call `blueprint_approve` again with `user_answer` and their words in `note`.
- On "revise": change the blueprint, `blueprint_save` it with its `id`, and ask again.
- Never assemble or start building before the blueprint is approved, and never answer for the user.

## 5. Assemble

Call `blueprint_assemble`. It starts the MCP pieces (their tools appear as `<piece>__<tool>`), writes a working copy of each document under `.encela/build/<blueprint>/`, and returns what to adapt and a brief for each worker.

If the result lists copies to adapt, start the `encela:assembler` subagent with that list and the blueprint's goal and requirements, before the steps that use them. Only the copies change; pieces stay as they are.

## 6. Build

- Follow the steps in order. Steps that don't wait on each other run in parallel: start one subagent per worker, give it its brief from the assemble result word for word, and add what it needs from earlier steps.
- A subagent may not see the `<piece>__<tool>` tools. Its brief says how to call them through `piece_call`.
- Hand results from one step to the steps that come after it: file paths, not pasted contents, when they are large.
- Call `blueprint_step` when a step starts (`doing`) and ends (`done` or `failed`, with a one-line note). It returns what can start next.
- If the plan turns out wrong, change the blueprint with `blueprint_save`. Adding or swapping a piece needs the user's approval again; changing steps does not.

## 7. Finish

When every step is done, tell the user what was built, which pieces were used for what, and anything left open. Encela stops the MCP pieces when the last step is recorded as done.
