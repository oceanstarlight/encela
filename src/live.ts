// What Encela is doing right now, kept as one small file in the project
// (`.encela/live.json`) for the view inside Claude Code to draw: where the
// request stands, the blueprint's steps and who does them, the pieces in
// use, and the pipeline runs. Written by the server whenever something
// changes; nothing reads it back as truth, so it is never trusted.
import { existsSync } from "node:fs";
import type { Live, LiveEvent } from "../plugin/types";
import { inEncela, projectHome } from "./paths";
import { writeJson } from "./registry";

export type { Live, LiveEvent, LivePiece, LiveRun, LiveStep, Phase } from "../plugin/types";

const EVENTS = 12;

/** Keeps what only the server sees happen, and writes the view's file a moment after each change. */
export class LiveWriter {
  private events: LiveEvent[] = [];
  private use = new Map<string, { busy: number; calls: number; last: string; lastAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** True while the user is being asked to approve. */
  asking = false;
  /** True once pieces were searched for: the request is being worked on. */
  searched = false;

  constructor(
    private project: string,
    private snapshot: () => Live,
  ) {}

  note(kind: LiveEvent["kind"], what: string, how = "") {
    this.events.push({ at: Date.now(), kind, what, how });
    if (this.events.length > EVENTS) this.events.splice(0, this.events.length - EVENTS);
    this.touch();
  }

  recent(): LiveEvent[] {
    return [...this.events];
  }

  usage(piece: string) {
    return this.use.get(piece) ?? { busy: 0, calls: 0, last: "", lastAt: 0 };
  }

  /** Counts a call of a piece's tool while `work` makes it. */
  async calling<T>(piece: string, tool: string, work: () => Promise<T>): Promise<T> {
    const u = this.usage(piece);
    this.use.set(piece, u);
    u.busy++;
    u.calls++;
    u.last = tool;
    u.lastAt = Date.now();
    this.touch();
    try {
      return await work();
    } finally {
      u.busy--;
      u.lastAt = Date.now();
      this.touch();
    }
  }

  /** Writes the file soon; many changes at once make one write. */
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 40);
    this.timer.unref();
  }

  /** Writes the file now. Only into a `.encela` that is already there: looking for pieces makes no folder. */
  write() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (!existsSync(projectHome(this.project))) return;
      writeJson(inEncela(this.project, "live.json"), this.snapshot());
    } catch {
      // The view is a convenience; nothing else depends on it.
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
