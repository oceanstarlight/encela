# Encela pipeline engine: design draft (stage 3)

Status: stage 3 is built, run for real and reviewed. The sections up to "Open questions" are the draft as it was critiqued; what the critique, the first real runs and the review changed is in the sections after them, and where they disagree the later section holds.

## Context

Encela (`/home/user/encela`, TypeScript) is an MCP server plus a Claude Code plugin. The user writes one request; Claude, in the user's own Claude Code session, writes a **blueprint** (goal, pieces, workers, steps), the user approves it, and Encela **assembles** it: MCP server pieces start through Encela's hub (their tools appear as `<piece>__<tool>`, or are called with `piece_call`), document pieces get working copies. Encela never calls a model itself. See `CLAUDE.md`, `src/server.ts`, `src/blueprint.ts`, `plugin/skills/orchestrate/SKILL.md`.

Today every tool result goes through Claude's context: Claude calls tool A, reads the output, and retypes parts of it as arguments of tool B. Stage 3 adds **pipelines**: declared chains of steps that Encela runs inside the server, passing data from piece to piece directly. Claude sees a short report and file paths, and is handed only the steps that need judgment.

Decisions already made with the user:

- The orchestrator is the user's Claude Code session. No model calls from Encela.
- Pipelines mix three kinds of step: **tool**, **transform**, **claude**.
- Approval: the blueprint's approval covers its pipelines. The approval text lists every tool a pipeline calls and marks the ones that may change things. After approval pipelines run without asking. If an approved blueprint is later changed so that a pipeline calls a tool that may change things and was not in the approved set, it needs approval again.

## Facts the design rests on (researched and fact-checked)

Claude Code as an MCP client (docs at code.claude.com/docs/en/mcp):

- A tool call has no practical wall-clock limit by default (about 28 hours), but there is an **idle limit**: a call that sends neither a result nor a progress notification for the idle window (30 minutes for a stdio server such as Encela, 5 minutes for HTTP servers) is aborted. In an interactive session a call still running after **2 minutes is moved to a background task**.
- Tool results: a warning above 10,000 tokens; above 25,000 tokens (or 50,000 characters of text) the result is **saved to a file and replaced by a message naming the path**. Error results longer than about 11,000 characters are cut to the first and last 5,000.
- Supported: elicitation (form and URL, since 2.1.287; not served in `claude -p`), `tools/list_changed`, roots, progress. Not documented: sampling, what the model sees of `structuredContent`.
- Subagents without a `tools` field inherit the session's MCP tools. A plugin server's tools are named `mcp__plugin_<plugin>_<server>__<tool>`. Whether a subagent sees tools added later through `list_changed` is not documented (Encela has `piece_call` for that case).
- `readOnlyHint` lets Claude Code run calls in parallel; it does not change permission prompts.

MCP specification (2025-06-18, 2025-11-25):

- A result is `content` (text, image, audio, resource_link, embedded resource blocks), optional `structuredContent` (an object; a server that declares `outputSchema` MUST return it, and SHOULD also return the same JSON as text), and `isError`. Tool failures, and since 2025-11-25 input validation failures too, SHOULD come back as results with `isError: true`, not protocol errors.
- Annotations: `readOnlyHint` defaults to false, `destructiveHint` to true, `idempotentHint` to false. "Clients MUST consider tool annotations to be untrusted unless they come from trusted servers."
- Progress: the request carries `_meta.progressToken`; `notifications/progress` has `progressToken`, `progress` (must increase), optional `total` and `message`, and must stop when the request completes.
- An experimental "tasks" mechanism for long calls exists (2025-11-25; reworked in a 2026-07-28 revision that also changes elicitation). Encela negotiates 2025-06-18 and does not use tasks.

Real servers (probed through Encela's hub; raw tool lists and about 130 raw results were captured in a scratch folder during the design):

- Of 48 tools across filesystem, git, memory, repomix, time, fetch and markitdown, 33 declare `outputSchema` and 30 say `readOnlyHint: true`.
- `structuredContent` is common and its shape varies: the data itself (memory: `{entities, relations}`; time; repomix: `{outputId, totalFiles, ...}`), or the text wrapped in one field (filesystem: `{content: "<text>"}`; markitdown: `{result: "<markdown>"}`). The git server (Python) returns plain text only.
- Handles are common: repomix packs a repository and returns an `outputId` that its read and grep tools take.
- An image came back as an image block and also as base64 inside `structuredContent`.
- Failures come back as `isError: true` with a text that is plain in some servers and JSON in others; an unknown tool also came back as an `isError` result.
- File and repository arguments are generally absolute paths.

Prior art: Step Functions (payload limit, pass references to stored data; Map with concurrency and tolerated failures; callbacks with task tokens for a pause), GitHub Actions (`steps.<id>.outputs`, string typing as a recurring pain), Temporal and n8n (re-run steps must be idempotent or recorded; partial re-runs reuse stored outputs), Anthropic's and Cloudflare's "code execution with MCP" (keeping intermediate results out of the model's context is the win; running model-written code needs a real sandbox, which a declarative step language avoids).

## Goals, in order

1. Data flows between pieces without entering Claude's context.
2. Declarative and checkable: a pipeline is data in the blueprint, shown to the user, validated before anything runs.
3. Claude does only what needs judgment, through pause and resume.
4. Safe: only approved pieces and tools, no arbitrary code, bounded work.
5. Observable and resumable: state and step outputs on disk.

## Pipeline definition

`blueprint.pipelines` is a list of:

```jsonc
{
  "name": "map-repo",                       // slug, unique in the blueprint
  "description": "Pack the repository and draw its structure",
  "inputs": { "dir": { "description": "Folder to pack", "default": "." } },
  "steps": [
    { "id": "pack", "piece": "mcp:repomix", "tool": "pack_codebase",
      "args": { "directory": "{{ $inputs.dir }}", "compress": true } },
    { "id": "outline", "claude": "List the modules of this repository and what each depends on.",
      "input": { "packed": "{{ $steps.pack.json.outputFilePath }}" },
      "expect": "json", "schema": { "type": "object", "required": ["modules"] } },
    { "id": "chart", "transform": "\"flowchart TD\\n\" + ($steps.outline.json.modules | map(\"  \\(.name)\") | join(\"\\n\"))" },
    { "id": "render", "piece": "mcp:mcp-mermaid", "tool": "generate_mermaid_diagram",
      "args": { "mermaid": "{{ $steps.chart.text }}", "outputType": "svg" } }
  ],
  "output": "{{ $steps.render.files[0] // $steps.render.text }}"
}
```

A step has an `id` (slug, unique in the pipeline) and exactly one of:

### Tool step: `piece` + `tool`

- `piece`: the id of an MCP piece listed in the blueprint's `pieces`. `tool`: one of its tools (inside the blueprint's `tools` allowlist for that piece, when there is one).
- `args`: any JSON value; strings anywhere inside it may hold `{{ }}` references.
- `each`: a reference that yields an array; the step then runs once per element with `$item` and `$index` set (and `.` = `$item`). `concurrency` (default 4, max 8). At most 1000 items.
- `timeout` in seconds (default 300, max 1800).

### Transform step: `transform`

- A jq program (Encela's jq subset, `src/jq.ts`). `.` is the value of the optional `input` reference, else null. It must produce exactly one output: none gives null, more than one is an error that says to wrap the program in `[ ]`.

### Claude step: `claude`

- `claude`: the instruction (may hold references; referenced values are stringified inline).
- `input`: named values (references). A value up to 4000 characters is given inline; a larger one is written to a file in the run folder and its path and size are given instead.
- `expect`: `text` (default) or `json`; `schema`: a small JSON Schema (type, properties, required, items, enum) the answer must match.
- The engine does not run this step. The run pauses there and reports the instruction and inputs; Claude (or a subagent it starts) does the work and gives the answer with `pipeline_resume`. An answer that fails `expect` or `schema` is refused with the reason and the step stays waiting.
- No `each` on claude steps in this version.

### Any step

- `when`: a jq expression; when its value is false or null the step is skipped (its output is `{ skipped: true, text: "", json: null }`).
- `retry`: extra attempts after a failure (0 to 5, default 0). `onError`: `stop` (default: the run fails at this step) or `continue` (the step's output gets `isError: true` and `error`, and the run goes on).
- `after`: see Order.

## References

`{{ expr }}` is a jq expression. When a string is exactly one reference, the value keeps its type (array, object, number); inside a longer string each reference is turned into text (strings as they are, other values as JSON). A reference must give exactly one output (none gives null).

Variables:

- `$inputs`: the run's inputs (defaults filled).
- `$steps.<id>`: the output of an earlier step, always this shape:
  - `text`: tool step: every text block of the result joined with newlines. Transform or claude step: the value if it is a string, else its JSON text.
  - `json`: tool step: `structuredContent` when the result has it; otherwise the text parsed as JSON when the whole text parses; otherwise null. Transform or claude step: the value.
  - `file`: absolute path of a file in the run folder that holds `text` (so a tool that takes a path can read another tool's output).
  - `files`: absolute paths of binary content saved from the result (images, audio, embedded resource blobs).
  - `content`: the result's content blocks with base64 data replaced by `{ type, mimeType, file }`; `resource_link` blocks as they are.
  - `isError`, and `error` (message) when it failed with `onError: continue`; `skipped` when skipped.
  - For an `each` step: `items` (one output per element, same shape), `text` (the items' texts joined with newlines), `json` (the list of the items' `json`), `isError` (true if any item failed).
- `$item`, `$index`: inside an `each` step.
- `$project`: the project folder. `$run`: `{ id, dir }`.

`src/jq.ts` reports, for each compiled expression, the literal field paths read from free variables (`$steps.pack.text` gives `["steps","pack","text"]`), so the engine knows statically which steps a step reads.

## Order

Steps run in the order listed, one at a time: each step waits for the one before it. This is the safe default, because a step may depend on an earlier step's side effect without reading its output.

A step that has `after` (a list of step ids, possibly empty) leaves that default: it waits only for the steps in `after` and for the steps its references read. Steps freed this way run side by side (at most 4 tool calls at once), and several claude steps can be waiting at the same time, to be handed to parallel subagents.

## Validation

**When the blueprint is saved** (no piece needs to be running): unique slugs; exactly one kind per step; `piece` is an MCP piece of the blueprint and `tool` is inside its allowlist; every reference and transform compiles (syntax, unknown functions); references name declared inputs and earlier steps only, no cycles; `each` only on tool steps; `expect` and `schema` only on claude steps; limits (50 steps, concurrency 8, retry 5). If the piece's tools are known from an earlier start (Encela caches each piece's tool list with schemas and annotations in `~/.encela/tools/<piece>.json` whenever it opens one), also: the tool exists, required arguments are present, no unknown arguments when the schema forbids them, literal values have the right type. Every problem is reported in one round.

**When a run starts** (pieces running, schemas fresh): the same schema checks as errors, and the approval check below. A run with problems does not start.

**During a run**: after a step's arguments are rendered, they are checked against the tool's input schema where the schema is simple (plain `type`, `required`, `enum`; schemas with `oneOf`, `anyOf`, `$ref` are not checked). A mismatch fails the step before the tool is called, with a message that names the argument and what the reference produced.

## Approval

- The approval text (what the user reads before approving) shows each pipeline: its steps in order, the piece and tool of each tool step, a mark on tools that may change things, and the claude steps.
- A tool "may change things" unless its cached annotations say `readOnlyHint: true`. A tool of a piece that has never been started is unknown, so it is marked.
- At approval the blueprint records `approvedWrites`: the `piece/tool` pairs its pipelines call that may change things.
- Saving an approved blueprint whose pipelines now call a may-change tool outside `approvedWrites` sets it back to draft. Other pipeline edits (reordering, new read-only calls, new transforms, new claude steps) keep the approval, as step edits do today.
- At run start the check is repeated with fresh annotations: a call to a tool that is not read-only and not in `approvedWrites` refuses the run and says the blueprint needs approval again.
- Tool annotations are hints from the server. For a piece found outside Encela's catalog they are only as trustworthy as the piece, which the user approved with warnings.

## Running

Three new tools on the Encela MCP server:

- `pipeline_run { id, pipeline, inputs?, wait? }`: checks the blueprint is approved (status assembled or done), opens the MCP pieces the pipeline needs if they are not running, validates, creates a run, starts it, and waits up to `wait` seconds (default 50, max 100: under Claude Code's 2 minute move to the background) for it to finish, fail, or need Claude. Returns the report. A run still going is reported as running, and `pipeline_get` with `wait` picks it up again.
- `pipeline_resume { run, answers?: [{ step, output? , file? }], retry?, cancel?, wait? }`: gives the answers of waiting claude steps (`output` inline, or `file`: a path inside the project holding the answer), or retries a failed step, or cancels; then waits as above. Also continues a run that was interrupted by a server restart.
- `pipeline_get { run?, step?, query?, max?, wait? }`: the report of a run (the latest when `run` is left out); with `step`, that step's output, optionally through a jq `query` over the output object (`.json[:5]`), cut at `max` characters (default 4000, max 20000) with the full size and file path noted.

The run goes on in the server while no call is waiting on it. If the `tools/call` carried a progress token, the server sends `notifications/progress` as steps finish.

The report is compact text, for example:

```
Run r-7f3a · pipeline map-repo · waiting for Claude · 1/4 steps · 2.1s
  done     pack     mcp:repomix/pack_codebase   1.8s  182,304 chars  .encela/runs/r-7f3a/pack.txt
  waiting  outline  claude
  todo     chart    transform
  todo     render   mcp:mcp-mermaid/generate_mermaid_diagram

Waiting for you. Do the work (independent steps in parallel subagents), then call pipeline_resume:
- outline: List the modules of this repository and what each depends on.
  packed: file .encela/runs/r-7f3a/pack.txt (182,304 chars; read it in parts)
  Answer as JSON matching {"type":"object","required":["modules"]}
```

When the run is done the report ends with the pipeline's `output` (inline up to `max` characters, else a preview and the file). Without `output`, the last step's text is used.

## State on disk

`.encela/runs/<run>/` (inside the project, ignored by git): `run.json` (the pipeline as it was when the run started, inputs, the status and timing of every step), and per step `<step>.txt` (the text), `<step>.json` (json, files, content, flags), binary files `<step>.<n>.<ext>`, and for each steps `<step>.<index>.*`. The server keeps the latest 20 runs of a project and removes older ones when a run starts. Step outputs may hold whatever the tools returned, secrets included; they stay on the user's disk.

After a server restart a run that was running is `interrupted`; `pipeline_resume` continues it from the finished steps. A tool step that was in flight runs again.

## Engine

- `src/pipeline.ts`: types, normalisation, static validation, reference rendering.
- `src/engine.ts`: runs. It is given a small interface (`callTool(piece, tool, args, timeout)`, `tools(piece)`, `ensureOpen(piece)`) so it can be tested without the server.
- Scheduling: find the steps whose prerequisites are finished; start tool and transform steps (up to the concurrency limit); mark claude steps waiting; the run is `waiting` when nothing is running and some step waits, `done` when every step is finished or skipped, `failed` when a step failed with `onError: stop` (later steps stay todo; `retry` runs it again).
- Limits: a step's text up to 50 MB; jq evaluation under `src/jq.ts` budgets (steps, outputs, string length).
- In the draft jq ran in the server's thread, where a pathological regular expression on hostile text could block the server (JavaScript has no regex timeout). It was the second open question below, and was decided the other way: see "Expressions run in a worker".

## Around the engine

- `get_piece` shows a piece's cached tools (names, arguments, read-only mark) so Claude can write pipelines against real schemas.
- A blueprint step can name a pipeline (`"pipeline": "map-repo"`): the worker's brief then says to run it.
- The orchestrate skill gains a section on when to write a pipeline (the same chain of tool calls on much data, or large outputs feeding other tools) and how to handle a waiting run.
- A new plugin subagent, `encela:pipeliner`: after assembling, it reads the real tool schemas (`piece_tools`), corrects the pipeline in the blueprint, makes a trial run, and reports.

## Out of scope for this version

Loops and branches beyond `each` and `when`; a pipeline calling another pipeline; running command line pieces as steps (that would be shell execution by the server, outside Claude Code's permission prompts); HTTP steps; MCP sampling.

## Open questions

1. Order: is "listed order unless `after` is given" the right rule, or should dependencies be purely by reference with an explicit way to order side effects?
2. jq in the server's thread versus a worker thread with a timeout (the package is one bundled file, `dist/cli.js`).
3. The shape of an `each` step's output, and whether claude steps need `each`.
4. The "exactly one output" rule for references and transforms.
5. `json` falling back to parsing the text: useful or surprising?
6. `approvedWrites`: is recording the approved may-change calls the simplest correct way to implement the approval rule?
7. The claude step protocol: inputs inline versus files, answers inline versus files, schema checking, several waiting at once.
8. The report: is it small and clear enough, and does it tell Claude exactly what to do next?
9. Restart, retry and idempotency.
10. What is missing for reuse (the same pipeline in a later blueprint)?

## Decisions after the critique

Four critics (author ergonomics, engine semantics, security, fit with Claude Code) reviewed the draft above and a sceptic checked each finding. Where this section and the draft disagree, this section wins; the draft is kept for the reasoning.

### References and outputs

- A tool step's `json` is the joined text parsed as JSON when it parses to an object or an array; otherwise `structuredContent`; otherwise null. `structured` is `structuredContent` exactly as returned. (Filesystem and markitdown wrap their text in one field, `{content: "..."}`: preferring `structuredContent` hid the data.) For a result with `isError`, `json` is null and `error` holds the text.
- `file` holds the step's own text. A tool that returns a handle or a path (repomix: `json.outputId`, `json.outputFilePath`) is followed through that value. The draft's example was wrong: it must read `{{ $steps.pack.json.outputFilePath }}`.
- An expression must give exactly one value: more than one is an error (wrap it in `[ ]`), and none is an error too (add `// default`), except in `when`, where none means false.
- Whole-expression fields are bare jq: `each`, `when`, `transform`, and a transform's `from` (was `input`). One pair of `{{ }}` around `each`, `when` or `from` is accepted and means the same. `{{ }}` templates appear only in strings inside `args`, a claude step's `input` values, and `output`.
- A reference ends at the first `}}` at which the text before it is a valid expression. A literal `{{` is written `{{ "{{" }}`. Templates are parsed once, from the blueprint; values put into them are never parsed again. `piece`, `tool`, `each`, `when` and `transform` come from the blueprint only.
- An argument name that isn't in the tool's `properties` is an error unless the schema sets `additionalProperties` (no probed server does, and their validators drop unknown names silently).
- Inputs: `{ description, type?, default? }` with type string, number, integer, boolean, array or object. An input without a default must be given. `pipeline_run` checks the type and turns a numeric or boolean string into the type asked for.
- A transform fails its step with jq's `error("...")`: the way to stop on a "soft" failure a tool reported as success.

### Order

- Steps run in the order listed; a step waits for every step listed before it.
- `parallel: true` lets a step wait only for the steps its references read and the ones in `after`. `after` only ever adds waiting, as in blueprint steps, and names earlier steps only, so the listed order is always valid.
- At most 8 tool calls of a run are in flight. An `each` step's `concurrency` defaults to 4 for a tool known to be read-only and to 1 otherwise.

### each

- `items` are in input order; each is the call's output plus `item` and `index`. `json` is the list of the items' `json`; `text` is the items' texts, each after a line `--- item <index> ---`.
- `retry` and `onError` apply to each item. Under `stop`, the first item to fail for good stops new items, calls in flight finish, and the step fails naming the item. Under `continue` the step is done, `failed` lists the failed indexes, and a failed item has `isError`, `error`, `json: null`.
- `each` must give a list. A retry of the run runs the whole step again.

### when

- A step that reads a skipped step is skipped too, unless its own `when` reads that step's `skipped`. A skipped output has the full shape.

### Claude steps

- No references in the `claude` text: values go in `input`. The instruction is what the user approved; everything else is data, shown in the report inside a block marked as data from tools, after Encela's own instructions.
- A waiting step's ask is shown in full once (and again by `pipeline_get {run, step}`); later reports say only that it waits.
- An answer is taken only for a waiting step; each answer is accepted or refused on its own, with the reason. Answers are still taken when the run has failed, so a retry doesn't redo Claude's work. An answer `file` must be inside the run's own folder (Claude writes it there with its own tools); the server reads no other file on Claude's behalf.

### Failures, timeouts, restarts

- A step's `timeout` counts per call from the moment the request is sent. A call that timed out or lost its connection may still have had its effect: it is retried automatically only for a tool known to be read-only or idempotent.
- A run that was running when the server stopped is `interrupted`. Its report names the steps that were in flight and which of them may have changed things. Nothing runs again until the caller asks (`retry`). A run that was waiting for Claude is intact. Handles from a piece that has restarted are dead; a step that uses one fails in the ordinary way.
- `pipeline_resume {run, retry: true}` reads the pipeline from the blueprint again and checks it again (approval included). Steps before the first changed or unfinished step keep their outputs; everything from there on runs again.
- Run folders record the server process that owns them. Another live server (a second session in the same project) can read such a run but not change it.
- Limits: 20 MB of text per call, 200 MB of output and 2000 tool calls per run, 1000 items per `each`; text is parsed as JSON only up to 5 MB. Only finished runs are removed (the newest 20 are kept).
- Existing code fixed along the way: closing a piece rejects its pending calls at once (they used to hang for the full timeout); a piece whose process died is started again when next needed; finishing a blueprint doesn't stop pieces a run still uses.
- A run uses a piece process started with the blueprint entry's own environment, and checks each call against the blueprint's allowlist for that piece.

### Expressions run in a worker

- Every jq evaluation of a run happens in a worker thread with a time limit (10 s), started from the same bundled file. JavaScript can't interrupt a regular expression, and one that backtracks without end on unlucky text would otherwise block the whole server. (V8's fallback to its linear engine was tried: it doesn't cover the `i` or `u` flags or lookaheads.) Compiling an expression to check it stays in the server's thread. The outputs come back from the worker as one JSON text (values JSON has no word for, such as nan and infinite, travel marked), so a value an expression uses many times is not copied once per use. The message of a stopped evaluation names both usual causes: a regular expression that backtracks without end, and work on very large values.

### Approval

- Two marks: a tool **changes things** unless its server says `readOnlyHint: true`; it **reaches outside** unless its server says `openWorldHint: false`. A tool Encela has never seen has both.
- The approval text shows, for every marked step, the tool, its arguments as written, and what `each` iterates over.
- At approval the blueprint records a fingerprint of every marked step (piece, tool, arguments, `each`; widened after the review, see "Decisions after the review"). Saving an approved blueprint with a marked step whose fingerprint isn't recorded sends it back to draft. Other pipeline edits keep the approval. The check is repeated when a run starts, with the tools as they are then.
- The blueprint records how it was approved. When the user answered Encela's own question it is `direct`. When Claude passed the answer on (a client that can't show the question), it is `relayed`, and Encela then won't run a pipeline that has a marked step: Claude calls those tools one at a time, where Claude Code shows each call to the user.
- A client can say it shows questions and still close one at once: Claude Code without a terminal (`claude -p`, 2.1.325) answers every elicitation with `cancel`. A question closed that way doesn't decide anything, and the next `blueprint_approve` for the same blueprint takes the answer Claude passes, as `relayed`. An explicit `decline` is not taken as that. A blueprint approved as `relayed` can be approved again by the user directly (`blueprint_approve` asks once more), which lets its marked pipelines run.
- `pipeline_run` and `pipeline_resume` are declared as tools that may change things and reach outside.
- The cached tool list of a piece is tied to the piece's configuration; a piece redefined under the same name starts unknown.

### Tools and reports

- `blueprint_save {blueprint: {id, pipelines: [...]}}` with nothing else replaces only those pipelines (by name) and reports only them. `blueprint_get {id, pipeline}` returns one pipeline as JSON; the blueprint's data line no longer carries pipelines.
- Reports use absolute paths, give sizes in characters and lines, end with the one call to make next, and answer with a single line when nothing changed since the caller's last report.

### Not in this version

MCP tasks; `each` on claude steps; command line pieces as steps; loading outputs from disk on demand; saving base64 found inside `structuredContent` as files; shipping catalog pieces' tool lists with the package; reuse of a pipeline across blueprints (stage 5).

### The jq subset

`src/jq.ts` implements jq 1.7's language for these uses: paths, slices, iteration, `..`, `?`, `//`, pipes and commas, arithmetic and comparison with jq's ordering, `if`, `try`/`catch`, `reduce`, `foreach`, `label`/`break`, variables and destructuring, `def`, string interpolation and formats (`@json @csv @tsv @html @uri @sh @base64 @base64d`), assignment operators (`= |= += -= *= /= %= //=`), and the usual builtins (map, select, keys, to_entries, group_by, sort_by, unique, add, any, all, flatten, range, limit, first, last, paths, getpath, setpath, del, walk, test, match, capture, scan, sub, gsub, split, join, ltrimstr, tojson, fromjson, tostring, tonumber, dates, IN, INDEX, error, and so on). Regular expressions are JavaScript's. Destructuring alternatives (`?//`) work in `as`, `reduce` and `foreach`, and `strptime/1` reads dates as jq 1.7 does, in UTC. `$ENV` and `env` are empty; `input`, `import`, `localtime` and the like are refused. A program may be 100,000 characters long; the outputs of one evaluation, written out, 20,000,000 characters (every string counted each time it occurs) and 2000 levels deep. Recorded cases from the real jq are in `test/fixtures/jq-cases.json` and `jq-review-cases.json`; where this implementation knowingly differs is in `jq-known-differences.json`, each case with its reason.

## What the first real runs showed

The engine and server tests were written against this document before any of it ran. Run for the first time, they found one error in the engine: a claude step told the caller it was waiting while it still counted as active, so a run whose only remaining work was that step was reported as `running`. The run's state is now decided first (`settle`), then the caller is told.

A run of the built server with a real piece (repomix: pack, grep, a jq transform, a claude step, resume) worked as designed. A headless Claude Code run with the plugin found the closed approval question described under Approval; with that fixed, the model found the piece, wrote a pipeline from the skill alone, got it approved, ran it and answered its claude step.

Not done then: an adversarial review by other agents (it followed, see below), and runs on Windows beyond what CI covers.

## Decisions after the review

Five reviewers each attacked one side of the engine (the approval gate, failures, containment, the expression language against jq 1.7, the texts given to Claude). A finding counted only with a script that showed it, and a second agent re-ran each one. 37 findings came back; 33 were confirmed, and the 4 judged "as designed" were real enough to change the design. Where this section disagrees with anything above, this section holds.

### The project folder is not trusted

- A cloned repository can ship its own `.encela/`. A blueprint file that says `approved` and `direct`, with its fingerprints filled in, used to run marked calls with no question to the user; a shipped run folder could be resumed. An approval and a run now count only with a seal: an HMAC over the facts that matter, made with a key in the user's Encela folder (`~/.encela/key`, never in the project). For a blueprint the facts are the project's real path, the id, how and when it was approved, the pieces with their tools and environment, and the approved calls. For a run: the project, the run id, its blueprint and when it started.
- A blueprint without a valid seal is read as a draft. A run folder without one is not a run: it isn't listed, read or resumed. Moving the project folder, or approving on another computer, means approving again.
- Nothing in `.encela` is followed if it is a link: not the folder, not `blueprints`, `build`, `runs`, a run folder or a file in it. Files of a run are written by removing what is at the name first, and read only if they are plain files. Paths in `run.json` are rebuilt, never taken from the file; step ids are checked against the pattern again.
- A working copy that is already in the build folder is kept only if this computer's Encela wrote it (a sealed list in the build folder says which). Anything else there is replaced by the piece and the reply says so: the user approved the piece, not a file that came with the project.

### What an approval of a marked call covers

- The fingerprint is now: the pipeline's name, the step's id, the call as written (piece, tool, arguments, `each`, `when`, `retry`), every step that feeds it, as written, followed all the way back (what its arguments, its `each` and its `when` read), and the inputs read on the way with their defaults.
- The approval text shows a marked call with its arguments, and every step that feeds it whole: a transform with its program, a call with its arguments, each with the note "feeds <step>".
- So one approval covers one call (a copy under another id is another call), and editing a transform that feeds a write needs the user again. Edits that no marked call reads still keep the approval.
- A blueprint piece's extra environment is shown at approval ("Started with: …"). Names that make a program load other code (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, `PYTHONPATH`, `npm_config_*` and the like) are refused in a blueprint.
- An answer to the approval question is an answer about the blueprint the user was shown. If the blueprint was saved again while the question was open, the answer is not applied.
- When a save sends an approved blueprint back to draft, its unfinished runs are stopped. After the new approval, `pipeline_resume {retry: true}` goes on from what was done.
- Answering a run that was started from an earlier version of a pipeline is refused when that version has marked calls the current approval doesn't cover; the blueprint's approval is left alone.
- The second question (a relayed approval made direct) takes all three answers: approve, changes (back to draft), cancel.
- What a piece said about its tools is kept per environment it ran with: a tool that only reads under one blueprint's settings is unknown under another's.

### Failures

- Once a call has returned, nothing makes it again: a result that is too large, or a disk error while keeping it, fails the step. The limits are checked before a call where they can be.
- The limits (20 MB per call, 200 MB per run) count text and the bytes of images, audio and other blobs, and are checked before anything of a result is written.
- A cancelled run starts no call that was waiting its turn. Steps that were in flight are recorded as failed with a note that their call may still have had its effect; the report names them as it does for an interrupted run. A cancelled run can be continued with `retry`.
- Going on with a run starts its limits over: calls from zero, size from what was kept.
- Who owns a run: a process id alone doesn't say a server is alive (ids are used again). Each engine keeps a small file fresh while it has runs (`runs/.alive-<engine>`, every 5 seconds); a run names its engine, and another server takes the run over when that file is missing or older than 30 seconds.
- A `run.json` that can't be read is not a run; a step output that can't be read makes that step read as failed ("its output was lost"). Neither stops the server.
- An HTTP piece: an answer that breaks off after the request went out, an answer without a reply to the call, and a 502, 503 or 504 from a gateway are lost calls (unknown fate), not refusals.
- How far an `each` step got is saved as it goes, and the report of an interrupted or cancelled run says so. A retry still runs every item of such a step again: that decision stands.
- The inline inputs of a claude step stand between tags that carry a random word made for that report, so a tool's text can't close its own block.

### The expression language

- The outputs of one evaluation are limited by their full size written out (20,000,000 characters, every string counted each time it occurs) and by their depth (2000 levels). A result that can't be passed to the server's thread settles the step at once instead of leaving it to the time limit, and the worker stays usable.
- A source longer than 100,000 characters is refused before parsing; analysing a long chain is linear.
- Builtins charge the step budget in proportion to the sizes they work on (searching in strings and arrays, comparing, sorting, `keys`, `tojson`, base64, and so on), so the budget stops in a second or two what used to run into the time limit.
- `?//` (destructuring alternatives) and `strptime` are part of the subset. `localtime` and `strflocaltime` stay out: they read the time zone.
- `path()` refuses what jq 1.7 refuses: `|=` and the other update operators are errors there.
- Still different from jq 1.7, and recorded: `?//` doesn't move on to the next pattern for an error raised after the body by whatever takes its outputs, nor for the `break` of `limit` and `first`; inside `foreach`'s update, `$x | .a` is not followed as a path.

Since the review an interactive session was run as well (Claude Code in a terminal): Encela's own approval dialog was answered there and counted as direct. Not done: runs on Windows beyond what CI covers.
