// The view's contract: the shapes it works with, and the values it keeps in
// Claude Code's session state. `Live` is what Encela's server writes to
// `.encela/live.json` (src/live.ts takes its types from here, so the two
// can't drift apart); `Agent` is what the view itself sees a model loop do.
// No imports here: Claude Code reads this file on its own.

export type Phase = "idle" | "pieces" | "blueprint" | "approval" | "assemble" | "build" | "done";

export interface LiveStep {
  id: string;
  title: string;
  status: "todo" | "doing" | "done" | "failed";
  /** A worker's name, or `main` for the orchestrator. */
  worker: string;
  pipeline: string;
}

export interface LivePiece {
  id: string;
  name: string;
  kind: string;
  /** An MCP piece whose server is up. */
  running: boolean;
  /** Calls of its tools in flight, made, and the last tool called. */
  busy: number;
  calls: number;
  last: string;
  lastAt: number;
}

export interface LiveRun {
  id: string;
  pipeline: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled" | "interrupted";
  steps: {
    id: string;
    kind: "tool" | "transform" | "claude";
    /** A tool step: the id of the piece it calls; "" otherwise. */
    piece: string;
    state: "todo" | "running" | "waiting" | "done" | "failed" | "skipped";
    items: number;
    itemsDone: number;
  }[];
}

/** Something that happened, for the view to say in the user's language. */
export interface LiveEvent {
  at: number;
  kind:
    | "found"
    | "saved"
    | "asked"
    | "approved"
    | "changes"
    | "cancelled"
    | "assembled"
    | "opened"
    | "closed"
    | "step"
    | "run";
  /** What it is about: a piece, a step, a pipeline, a search. */
  what: string;
  /** How it went: a count, a status. */
  how: string;
}

export interface Live {
  v: 1;
  at: number;
  lang: "ko" | "en";
  phase: Phase;
  blueprint: {
    id: string;
    goal: string;
    status: "draft" | "approved" | "assembled" | "done" | "cancelled";
    approval: string;
    steps: LiveStep[];
    workers: string[];
  } | null;
  pieces: LivePiece[];
  runs: LiveRun[];
  events: LiveEvent[];
}

/** One model loop the view watches: the main one (`main`) or a subagent. */
export interface Agent {
  id: string;
  /** The blueprint worker it was started as, or "" when it isn't one. */
  worker: string;
  /** What it was started for, in a few words. */
  about: string;
  /** The last thing it did or is doing, e.g. `Edit canvas.ts`; "" when it has done nothing yet. */
  doing: string;
  /** True once its turn is over. */
  done: boolean;
}

/**
 * Something a model loop reached for that the canvas draws a line to: a
 * piece of the build, the web, another MCP server, a skill.
 */
export interface Act {
  /** Who and what, as one key. */
  id: string;
  /** The loop that called: `main` or a subagent's id. */
  from: string;
  kind: "piece" | "web" | "mcp" | "skill";
  name: string;
  /** Calls in flight, and calls made. */
  busy: number;
  calls: number;
}

/** The pane's two pictures of one build. */
export type Tab = "graph" | "canvas";

declare module "claude-code" {
  interface PluginState {
    encela: {
      /** The last state read from the server's file; null before any. */
      live: Shaped<Live | null>;
      /** The model loops seen at work since Encela was first used. */
      agents: Shaped<Agent[]>;
      /** What the loops reached for, for the canvas. */
      acts: Shaped<Act[]>;
      /** The tab the pane shows. */
      tab: Shaped<Tab>;
      /** When this session first called an Encela tool; 0 before that. */
      since: Shaped<number>;
      /** The project folder at that moment: the only one whose file is read. */
      root: Shaped<string>;
    };
  }
}
