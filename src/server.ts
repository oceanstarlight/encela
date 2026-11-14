// `encela mcp`: the MCP server the plugin gives Claude Code (stdio).
//
// - Pieces: find_pieces, get_piece, piece_add look through and add to the
//   registry.
// - Blueprints: blueprint_save, blueprint_get, blueprint_approve,
//   blueprint_assemble, blueprint_step. Nothing is assembled before the user
//   has approved the blueprint.
// - The hub: an MCP server piece starts only when it is opened; its tools
//   then appear as <piece>__<tool>. A CLI or library piece hands over its
//   guide, a document piece its text.
// - The `go` prompt: the whole flow for one request.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { briefs, type Copy, writeCopies } from "./assemble";
import {
  Blueprints,
  MAIN,
  normalizeBlueprint,
  progress,
  ready,
  render,
  type StepStatus,
} from "./blueprint";
import { Client, forThisOs, supported } from "./client";
import { lang, projectDir, VERSION } from "./paths";
import { cautions, isDocument, KINDS, type McpConfig, type Piece, type PieceKind } from "./piece";
import { Registry } from "./registry";
import { line, search } from "./search";

type Json = Record<string, unknown>;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Claude Code names a plugin's tool `mcp__plugin_encela_encela__<name>`; the API allows 64. */
const MAX_TOOL_NAME = 64 - "mcp__plugin_encela_encela__".length;
/** How long the user has to answer the approval question. */
const ASK_TIMEOUT = 30 * 60_000;

/** How a request goes through Encela; the server's instructions, the `go` prompt and the command use it. */
export const FLOW = `How to take a request through Encela (the encela:orchestrate skill has the details):
1. Analyse the request: the goal, the requirements, what is unknown.
2. Find pieces with find_pieces, several queries of English keywords at once (what the task needs, not the user's words: "an app like Paint" needs frontend design and canvas drawing). Read the promising ones with get_piece. Something needed that Encela lacks can be found outside and kept with piece_add.
3. Write the blueprint with blueprint_save: goal, requirements, the pieces with each one's role and why, workers for parts that can run side by side, ordered steps, and choices the user should make. Keep only pieces that clearly help; a blueprint with no pieces is fine.
4. Show the blueprint to the user and call blueprint_approve. Never assemble or build before it is approved; when the user wants changes, save the blueprint again and ask again.
5. Call blueprint_assemble: MCP pieces start (their tools appear as <piece>__<tool>), documents get working copies, and you get a brief for each worker.
6. Build: adapt the working copies as the blueprint says (encela:assembler subagent), run workers whose steps don't depend on each other as parallel subagents with their briefs, and record each step with blueprint_step.
7. When every step is done, tell the user what was built and with which pieces.`;

const INSTRUCTIONS = `Encela holds pieces for Claude Code: MCP servers, command line tools, libraries, skills, rules, instructions and subagents. For a request that builds, changes or produces something beyond a quick answer, Encela turns it into a blueprint the user approves, then assembles the pieces. Nothing runs until then.\n${FLOW}`;

export function exposed(piece: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${clean(piece)}__${clean(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash("sha256").update(`${piece}\0${tool}`).digest("hex").slice(0, 6);
  return `${full.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

function tool(
  name: string,
  description: string,
  properties: Json,
  required: string[],
  readOnly: boolean,
) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly },
  };
}

function ownTools() {
  const piece = { type: "string", description: "A piece id, e.g. mcp:repomix" };
  const blueprint = { type: "string", description: "The blueprint's id" };
  const strings = { type: "array", items: { type: "string" } };
  return [
    tool(
      "find_pieces",
      "Searches Encela's pieces (MCP servers, CLIs, libraries, skills, rules, instructions, subagents) by keywords. Give several queries at once, in English, for what the task needs. Returns ids with one line each; you decide which ones fit.",
      {
        queries: { ...strings, description: 'e.g. ["frontend design", "canvas drawing", "e2e"]' },
        kinds: { type: "array", items: { type: "string", enum: [...KINDS] } },
        limit: { type: "number", description: "How many to return (15)" },
      },
      ["queries"],
      true,
    ),
    tool(
      "get_piece",
      "A piece in full: what it does, takes and gives, where it comes from, what the user should know before it is used, and a document's text.",
      { id: piece },
      ["id"],
      true,
    ),
    tool(
      "piece_add",
      "Keeps a piece found outside Encela (an MCP server, CLI or library from GitHub, or a skill, rule, instruction or subagent). It can be used once the user approves a blueprint that includes it.",
      {
        piece: {
          type: "object",
          description:
            "kind, name, summary, tags, capabilities, inputs, outputs, source {repo, commit, path}, license, warnings; for mcp: config {transport stdio|http, command, args, env, url, headers}; for cli/library: guide, install; for documents: body",
        },
      },
      ["piece"],
      false,
    ),
    tool(
      "blueprint_save",
      "Saves a blueprint (a new one, or a changed one with its id) and returns it as text to show the user. Changing the pieces of an approved blueprint needs approval again.",
      {
        blueprint: {
          type: "object",
          description:
            "id (only when changing one), request, goal, requirements[], pieces[{piece, role, why, adapt, tools[], env{}}], workers[{name, role}], steps[{id, title, detail, worker, pieces[], after[]}], choices[{question, options[], answer}]",
        },
      },
      ["blueprint"],
      false,
    ),
    tool(
      "blueprint_get",
      "A blueprint as text and as data; without an id, the one being built (or the latest) and the list of the project's blueprints.",
      { id: blueprint },
      [],
      true,
    ),
    tool(
      "blueprint_approve",
      "Asks the user to approve a blueprint. Where the user can't be asked directly, ask them yourself (AskUserQuestion) after showing the blueprint, then pass their answer in user_answer.",
      {
        id: blueprint,
        user_answer: {
          type: "string",
          enum: ["approve", "revise", "cancel"],
          description: "What the user answered when you asked them",
        },
        note: { type: "string", description: "What the user said, e.g. the changes they want" },
      },
      ["id"],
      false,
    ),
    tool(
      "blueprint_assemble",
      "Assembles an approved blueprint: starts its MCP pieces, writes working copies of its documents into .encela/build/, and returns a brief for each worker.",
      { id: blueprint },
      ["id"],
      false,
    ),
    tool(
      "blueprint_step",
      "Records where a step stands (doing, done, failed) with a short note, and returns the steps that can start next.",
      {
        id: blueprint,
        step: { type: "string", description: "The step's id" },
        status: { type: "string", enum: ["todo", "doing", "done", "failed"] },
        note: { type: "string" },
      },
      ["id", "step", "status"],
      false,
    ),
    tool(
      "piece_open",
      "Opens a piece outside a blueprint: an MCP server starts and its tools are added as <piece>__<tool>; a CLI or library returns its guide; a document returns its text.",
      { id: piece },
      ["id"],
      false,
    ),
    tool(
      "piece_tools",
      "The tools of a running MCP piece with their input schemas.",
      { id: piece, tools: strings },
      ["id"],
      true,
    ),
    tool(
      "piece_call",
      "Calls a tool of a running MCP piece by its own name, when the <piece>__<tool> tools didn't appear (e.g. inside a subagent).",
      { id: piece, tool: { type: "string" }, arguments: { type: "object" } },
      ["id", "tool"],
      false,
    ),
    tool(
      "piece_close",
      "Stops a running MCP piece and removes its tools.",
      { id: piece },
      ["id"],
      false,
    ),
  ];
}

interface Running {
  client: Client;
  /** The only tools to show, or null for all. */
  allow: Set<string> | null;
}

export interface ServerOptions {
  project?: string;
  registry?: Registry;
}

export class Server {
  private open = new Map<string, Running>();
  private starting = new Map<string, Promise<Client>>();
  private changed = false;
  private canAsk = false;
  private nextId = 1;
  private asked = new Map<number, (m: Json) => void>();
  private project: string;
  private registry: Registry;
  private blueprints: Blueprints;

  constructor(
    private send: (m: Json) => void,
    opts: ServerOptions = {},
  ) {
    this.project = opts.project ?? projectDir();
    this.registry = opts.registry ?? new Registry();
    this.blueprints = new Blueprints(this.project);
  }

  /** The reply to a message; notifications and replies get none. */
  async handle(m: Json): Promise<Json | null> {
    if (m.id !== undefined && typeof m.method !== "string") {
      // The client's answer to something this server asked.
      this.asked.get(m.id as number)?.(m);
      this.asked.delete(m.id as number);
      return null;
    }
    if (m.id === undefined || typeof m.method !== "string") return null;
    const params = (m.params as Json) ?? {};
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        this.canAsk = !!(params.capabilities as Json | undefined)?.elicitation;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: false } },
          serverInfo: { name: "encela", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: await this.toolList() });
      case "tools/call": {
        const result = await this.call(String(params.name ?? ""), (params.arguments as Json) ?? {});
        if (this.changed) {
          this.changed = false;
          queueMicrotask(() =>
            this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
          );
        }
        return ok(result);
      }
      case "prompts/list":
        return ok({
          prompts: [
            {
              name: "go",
              description: "Blueprint, approve, assemble, build: one request through Encela",
              arguments: [{ name: "request", description: "What you want made", required: true }],
            },
          ],
        });
      case "prompts/get": {
        const request = String((params.arguments as Json | undefined)?.request ?? "");
        return ok({
          description: "Take a request through Encela",
          messages: [
            { role: "user", content: { type: "text", text: `${request}\n\n[Encela]\n${FLOW}` } },
          ],
        });
      }
      default:
        return {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: `Method not found: ${m.method}` },
        };
    }
  }

  /** Asks the client something (the user, through an elicitation) and waits for the answer. */
  private ask(method: string, params: Json, timeout: number): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asked.delete(id);
        reject(new Error("No answer in time"));
      }, timeout);
      this.asked.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(String((m.error as Json).message ?? "error")));
        else resolve((m.result as Json) ?? {});
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async toolList(): Promise<Json[]> {
    const tools: Json[] = ownTools();
    for (const [name, running] of this.open) {
      for (const t of await running.client.freshTools()) {
        if (running.allow && !running.allow.has(String(t.name))) continue;
        tools.push({
          ...t,
          name: exposed(name, String(t.name)),
          description: `[${name}] ${String(t.description ?? "")}`,
        });
      }
    }
    return tools;
  }

  async call(name: string, args: Json): Promise<Json> {
    try {
      switch (name) {
        case "find_pieces":
          return text(this.findPieces(args));
        case "get_piece":
          return text(pieceText(this.registry.get(String(args.id ?? ""))));
        case "piece_add":
          return text(this.addPiece(args.piece));
        case "blueprint_save":
          return text(this.saveBlueprint(args.blueprint));
        case "blueprint_get":
          return text(this.getBlueprint(args.id as string | undefined));
        case "blueprint_approve":
          return text(await this.approve(args));
        case "blueprint_assemble":
          return text(await this.assemble(String(args.id ?? "")));
        case "blueprint_step":
          return text(this.step(args));
        case "piece_open":
          return text(await this.openPiece(this.registry.get(String(args.id ?? ""))));
        case "piece_tools":
          return text(await this.pieceTools(String(args.id ?? ""), args.tools as string[]));
        case "piece_call": {
          const piece = this.registry.get(String(args.id ?? ""));
          const running = this.running(piece.name);
          const wanted = String(args.tool ?? "");
          if (running.allow && !running.allow.has(wanted)) {
            throw new Error(`The blueprint doesn't allow ${piece.name}'s tool ${wanted}`);
          }
          return await running.client.call(wanted, args.arguments);
        }
        case "piece_close":
          return text(this.closePiece(this.registry.get(String(args.id ?? "")).name));
        default: {
          for (const [piece, running] of this.open) {
            const t = running.client.tools().find((x) => exposed(piece, String(x.name)) === name);
            if (t && (!running.allow || running.allow.has(String(t.name)))) {
              return await running.client.call(String(t.name), args);
            }
          }
          return text(`Unknown tool ${name}. Its piece isn't running: assemble or open it.`, true);
        }
      }
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  }

  private findPieces(args: Json): string {
    const queries = Array.isArray(args.queries)
      ? args.queries.map(String)
      : [String(args.queries ?? args.query ?? "")];
    const kinds = Array.isArray(args.kinds) ? (args.kinds as PieceKind[]) : undefined;
    const found = search(this.registry.all(), queries, {
      kinds,
      limit: Number(args.limit) > 0 ? Number(args.limit) : 15,
    });
    if (!found.length) {
      return "No piece matches. Try other English keywords for what the task needs; if Encela has nothing, look outside (GitHub) and keep what you find with piece_add, or go without.";
    }
    return `${found.map((m) => line(m.piece)).join("\n")}\n\nThese are keyword matches. Read the ones that look right with get_piece and keep only what clearly helps.`;
  }

  private addPiece(raw: unknown): string {
    const piece = this.registry.add(raw, "claude");
    const notes = cautions(piece);
    return `Kept ${piece.id}.${piece.trusted ? "" : " It can run once the user approves a blueprint that includes it."}${notes.length ? `\nThe user will be shown:\n${notes.map((c) => `- ${c}`).join("\n")}` : ""}`;
  }

  private saveBlueprint(raw: unknown): string {
    const id = String((raw as Json | null)?.id ?? "").trim();
    const previous = id ? this.blueprints.load(id) : null;
    const b = normalizeBlueprint(raw, this.registry, previous);
    if (!previous) b.id = this.blueprints.freeId(b.id);
    this.blueprints.save(b);
    const next =
      b.status === "draft"
        ? "Show this blueprint to the user in their language (every piece, its warnings marked with !, and the choices), then call blueprint_approve."
        : `Saved; still ${b.status} (the pieces didn't change).`;
    return `${render(b, this.registry)}\n\n${next}`;
  }

  private getBlueprint(id?: string): string {
    const all = this.blueprints.list();
    const b = id ? this.blueprints.get(id) : (this.blueprints.active() ?? all[0]);
    if (!b) return "This project has no blueprint yet.";
    const others = all
      .filter((x) => x.id !== b.id)
      .map((x) => `- ${x.id} (${x.status}, ${progress(x)}): ${x.goal}`);
    const next = ready(b).map((s) => `- ${s.id}: ${s.title}`);
    return [
      render(b, this.registry),
      next.length && b.status === "assembled" ? `\nCan start now:\n${next.join("\n")}` : "",
      `\nData:\n${JSON.stringify(b)}`,
      others.length && !id ? `\nOther blueprints:\n${others.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** The user's decision on a blueprint: asked here when the client allows, else passed in. */
  private async approve(args: Json): Promise<string> {
    const b = this.blueprints.get(String(args.id ?? ""));
    if (b.status === "approved" || b.status === "assembled") {
      return `${b.id} is already approved. Call blueprint_assemble.`;
    }
    let answer = "";
    let note = String(args.note ?? "").trim();
    let direct = false;
    if (this.canAsk) {
      try {
        const reply = await this.ask(
          "elicitation/create",
          {
            message: `${render(b, this.registry, true)}\n\nApprove this blueprint?`,
            requestedSchema: {
              type: "object",
              properties: {
                decision: {
                  type: "string",
                  title: "Decision",
                  enum: ["approve", "revise", "cancel"],
                  enumNames: ["Approve and build", "I want changes", "Cancel"],
                },
                note: { type: "string", title: "Changes or notes (optional)" },
              },
              required: ["decision"],
            },
          },
          ASK_TIMEOUT,
        );
        direct = true;
        const content = (reply.content as Json) ?? {};
        if (reply.action !== "accept") {
          return `The user closed the approval question without deciding, so ${b.id} is still a draft and nothing may be assembled. Ask them what they would like to do.`;
        }
        answer = String(content.decision ?? "");
        note = String(content.note ?? "").trim() || note;
      } catch {
        // The client said it could ask but didn't: fall back to Claude asking.
      }
    }
    if (!direct) {
      answer = String(args.user_answer ?? "");
      if (!["approve", "revise", "cancel"].includes(answer)) {
        return `The user hasn't decided yet. Show them the blueprint, ask with AskUserQuestion (approve / change something / cancel; let them drop or swap pieces), then call blueprint_approve again with user_answer and what they said in note.\n\n${render(b, this.registry)}`;
      }
    }
    b.approvalNote = note;
    b.updatedAt = new Date().toISOString();
    if (answer === "approve") {
      b.status = "approved";
      b.approvedAt = b.updatedAt;
      this.blueprints.save(b);
      // The user has now seen what each outside piece is and runs.
      this.registry.trust(b.pieces.map((p) => p.piece));
      return `Approved${note ? ` with a note: ${note}` : ""}. Call blueprint_assemble with id ${b.id}.`;
    }
    if (answer === "cancel") {
      b.status = "cancelled";
      this.blueprints.save(b);
      return `The user cancelled this blueprint${note ? `: ${note}` : ""}. Don't build it; ask what they want instead.`;
    }
    this.blueprints.save(b);
    return `The user wants changes${note ? `: ${note}` : " (ask them which)"}. Change the blueprint, save it with blueprint_save (id ${b.id}) and ask for approval again.`;
  }

  private async assemble(id: string): Promise<string> {
    const b = this.blueprints.get(id);
    if (b.status !== "approved" && b.status !== "assembled") {
      throw new Error(
        `${b.id} is ${b.status}: the user has to approve it first (blueprint_approve). Nothing was assembled.`,
      );
    }
    const usage = new Map<string, string>();
    const out: string[] = [`Assembled ${b.id}: ${b.goal}`, "", "## Pieces"];
    let failed = 0;
    const copies = writeCopies(
      b,
      (pid) => this.registry.find(pid),
      this.blueprints.buildDir(b.id),
      this.project,
    );
    for (const entry of b.pieces) {
      const piece = this.registry.find(entry.piece);
      if (!piece) {
        failed++;
        out.push(`- ${entry.piece}: no longer in the registry`);
        continue;
      }
      if (isDocument(piece.kind)) {
        const copy = copies.find((c) => c.piece.id === piece.id) as Copy;
        usage.set(piece.id, documentUsage(copy));
        out.push(
          `- ${piece.id}: working copy at ${copy.path}${copy.written ? "" : " (kept the one already there)"}${entry.adapt ? `. To adapt: ${entry.adapt}` : ""}`,
        );
        continue;
      }
      if (piece.kind !== "mcp") {
        usage.set(piece.id, `${piece.id} (${entry.role}): ${guideText(piece)}`);
        out.push(`- ${piece.id}: ${guideText(piece)}`);
        continue;
      }
      try {
        const opened = await this.openPiece(piece, entry.tools, entry.env);
        usage.set(
          piece.id,
          `${piece.id} (${entry.role}): MCP tools named ${exposed(piece.name, "<tool>")}; if they aren't in your tool list, call them with the encela tool piece_call {id: "${piece.id}", tool, arguments} (schemas: piece_tools).`,
        );
        out.push(`- ${opened}`);
      } catch (e) {
        failed++;
        usage.set(piece.id, `${piece.id}: could not be started`);
        out.push(`- ${piece.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    b.status = "assembled";
    b.updatedAt = new Date().toISOString();
    this.blueprints.save(b);

    const toAdapt = copies.filter((c) => c.entry.adapt);
    if (toAdapt.length) {
      out.push(
        "",
        "## Adapt first",
        "Hand these working copies to the encela:assembler subagent (or edit them yourself) before the steps that use them. Only the copies change, never the pieces:",
        ...toAdapt.map((c) => `- ${c.path}: ${c.entry.adapt}`),
      );
    }
    out.push("", "## Briefs");
    for (const brief of briefs(b, (pid) => usage.get(pid) ?? pid)) {
      out.push(
        brief.worker === MAIN
          ? brief.text
          : `Start a subagent for this worker with the brief below, in parallel with other workers whose steps don't wait on each other:\n${brief.text}`,
        "",
      );
    }
    const first = ready(b).map((s) => `${s.id} (${s.worker})`);
    out.push(
      `Can start now: ${first.join(", ") || "nothing (every step is done or waiting)"}`,
      "Record each step with blueprint_step as it starts and ends.",
    );
    if (failed) {
      out.push(
        `${failed} piece(s) could not be set up: tell the user, and go on without them or fix the blueprint.`,
      );
    }
    return out.join("\n");
  }

  private step(args: Json): string {
    const b = this.blueprints.get(String(args.id ?? ""));
    if (b.status !== "assembled" && b.status !== "done") {
      throw new Error(`${b.id} is ${b.status}: approve and assemble it before working on steps.`);
    }
    const s = b.steps.find((x) => x.id === String(args.step ?? ""));
    if (!s)
      throw new Error(`No step "${args.step}" in ${b.id}: ${b.steps.map((x) => x.id).join(", ")}`);
    const status = String(args.status ?? "") as StepStatus;
    if (!["todo", "doing", "done", "failed"].includes(status)) {
      throw new Error("status is todo, doing, done or failed");
    }
    s.status = status;
    if (typeof args.note === "string") s.note = args.note.trim();
    b.updatedAt = new Date().toISOString();
    const allDone = b.steps.every((x) => x.status === "done");
    b.status = allDone ? "done" : "assembled";
    this.blueprints.save(b);
    if (allDone) {
      // The build is over: its MCP pieces aren't needed any more.
      for (const entry of b.pieces) {
        const piece = this.registry.find(entry.piece);
        if (piece && this.open.has(piece.name)) this.closePiece(piece.name);
      }
      return `Every step of ${b.id} is done and its MCP pieces are stopped. Tell the user what was built, with which pieces, and anything left open.`;
    }
    const next = ready(b).map((x) => `- ${x.id} (${x.worker}): ${x.title}`);
    return `${s.id} is ${status}. ${progress(b)}.${next.length ? `\nCan start now:\n${next.join("\n")}` : ""}`;
  }

  /** Starts an MCP piece (or hands over a guide or a document's text). */
  async openPiece(piece: Piece, tools: string[] = [], env: Record<string, string> = {}) {
    if (!piece.trusted) {
      throw new Error(
        `${piece.id} was found outside Encela and the user hasn't approved it. Put it in a blueprint; it can run once that is approved.`,
      );
    }
    if (isDocument(piece.kind)) return pieceText(piece);
    if (piece.kind !== "mcp") return guideText(piece);
    const config = piece.config as McpConfig;
    if (!supported(config)) {
      throw new Error(
        `Encela can't start ${piece.name} (${config.transport}). Add it to the project's MCP servers instead.`,
      );
    }
    let running = this.open.get(piece.name);
    if (!running) {
      let start = this.starting.get(piece.name);
      if (!start) {
        const withEnv = { ...config, env: { ...config.env, ...env } };
        start = Client.start(forThisOs(withEnv), this.project, () =>
          this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
        );
        this.starting.set(piece.name, start);
      }
      let client: Client;
      try {
        client = await start;
      } catch (e) {
        throw new Error(`Couldn't start ${piece.name}: ${e instanceof Error ? e.message : e}`);
      } finally {
        this.starting.delete(piece.name);
      }
      running = this.open.get(piece.name) ?? { client, allow: null };
      this.open.set(piece.name, running);
      this.changed = true;
    }
    const allow = tools.length ? new Set(tools) : null;
    if (JSON.stringify([...(running.allow ?? [])]) !== JSON.stringify([...(allow ?? [])])) {
      running.allow = allow;
      this.changed = true;
    }
    const lines = running.client
      .tools()
      .filter((t) => !allow || allow.has(String(t.name)))
      .map((t) => {
        const about = String(t.description ?? "").split("\n")[0];
        return `  - ${exposed(piece.name, String(t.name))} (tool ${t.name}): ${about}`;
      });
    let out = `${piece.id} is running with ${lines.length} tools, now in your tool list under these names (or through piece_call):\n${lines.join("\n")}`;
    if (piece.guide.trim()) out += `\n  How to use it: ${piece.guide.trim()}`;
    return out;
  }

  private async pieceTools(id: string, only?: string[]): Promise<string> {
    const running = this.running(this.registry.get(id).name);
    const tools = (await running.client.freshTools()).filter(
      (t) => !running.allow || running.allow.has(String(t.name)),
    );
    const list = only?.length ? tools.filter((t) => only.includes(String(t.name))) : tools;
    return JSON.stringify(list, null, 2);
  }

  private closePiece(name: string): string {
    const running = this.open.get(name);
    if (!running) return `${name} wasn't running.`;
    running.client.close();
    this.open.delete(name);
    this.changed = true;
    return `Stopped ${name}.`;
  }

  private running(name: string): Running {
    const r = this.open.get(name);
    if (!r)
      throw new Error(`${name} isn't running. Assemble its blueprint or open it with piece_open.`);
    return r;
  }

  closeAll() {
    for (const r of this.open.values()) r.client.close();
    this.open.clear();
  }
}

/** How a worker uses a document's working copy. */
function documentUsage(c: Copy): string {
  const how =
    c.piece.kind === "subagent"
      ? "the brief for a subagent: read it and give its text to the subagent you start for this"
      : c.piece.kind === "rule" && c.piece.paths.length
        ? `rules for ${c.piece.paths.join(", ")}: read and follow them when touching those files`
        : "read it before starting and follow it";
  return `${c.piece.id} (${c.entry.role}): ${c.path}, ${how}`;
}

/** A CLI or library piece: how to use it. */
function guideText(p: Piece): string {
  const what = p.kind === "cli" ? "a command line tool" : "a library";
  const setup = p.install.length ? ` Set up with: ${p.install.join(" && ")}.` : "";
  return `${what}, used with Bash or code (no MCP tools).${setup} ${p.guide.trim() || p.summary.en}`;
}

/** A piece in full, for Claude to judge and use. */
export function pieceText(p: Piece): string {
  const l = lang();
  const out = [`${p.id} (${p.kind}) ${p.title[l]}`, p.summary[l] || p.summary.en];
  if (p.detail) out.push(p.detail);
  const row = (label: string, v: string[]) => v.length && out.push(`${label}: ${v.join(", ")}`);
  row("Tags", p.tags);
  row("Can", p.capabilities);
  row("Takes", p.inputs);
  row("Gives", p.outputs);
  row("Applies to files", p.paths);
  if (p.needs) out.push(`Needs: ${p.needs}`);
  if (p.source) {
    const at = p.source.commit ? `/blob/${p.source.commit}/${p.source.path}` : "";
    out.push(`Source: https://github.com/${p.source.repo}${at}`);
  }
  if (p.license)
    out.push(`License: ${p.license}${p.source?.copyright ? `, ${p.source.copyright}` : ""}`);
  out.push(`Origin: ${p.origin}${p.trusted ? "" : " (not yet approved by the user)"}`);
  const notes = cautions(p);
  if (notes.length) out.push("The user should know:", ...notes.map((c) => `- ${c}`));
  if (p.config) {
    out.push(
      p.config.transport === "stdio"
        ? `Starts with: ${[p.config.command, ...p.config.args].join(" ")}`
        : `Reached at: ${p.config.url}`,
    );
  }
  if (p.install.length) out.push(`Set-up commands: ${p.install.join(" && ")}`);
  if (p.guide.trim()) out.push("", "How to use it:", p.guide.trim());
  const files = Object.keys(p.files);
  if (files.length)
    out.push(`Reference files (written with the working copy): ${files.join(", ")}`);
  if (p.body.trim()) out.push("", "Text:", p.body.trim());
  return out.join("\n");
}

/** Runs the server on stdin/stdout until stdin closes. */
export function run(): Promise<void> {
  const send = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const server = new Server(send);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (l) => {
    if (!l.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(l);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    for (const m of (Array.isArray(message) ? message : [message]) as Json[]) {
      void server.handle(m).then((reply) => reply && send(reply));
    }
  });
  return new Promise((resolve) =>
    lines.on("close", () => {
      server.closeAll();
      resolve();
    }),
  );
}
