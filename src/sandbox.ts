// Evaluating jq expressions away from the server's thread. A program runs
// under budgets (src/jq.ts), but a single regular expression on unlucky
// text can still spin for hours, and JavaScript cannot interrupt it. So
// expressions run in a worker thread, one at a time, and a worker that
// takes too long is stopped and replaced. The server's own thread, which
// answers every tool call, never evaluates one.
//
// The outputs come back as one JSON text, not as values: copying values
// between threads writes a string out again each time it occurs, so a few
// shared strings could fill the server's memory, and a value nested deep
// enough can't be read back at all. The text is only written once the
// outputs passed jq's own size and depth checks, so the server's thread
// never gets more than it can hold.
//
// The worker is this same bundled file started again: when it finds itself
// in a worker with the mark below, it serves evaluations instead of
// running the command line.
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { compile, MAX_OUTPUT_DEPTH, type Program } from "./jq";

const MARK = "encela:jq";
/** How long one evaluation may take. */
export const EVAL_TIMEOUT = 10_000;
/** The longest text of outputs the worker sends (jq's own limit is lower; this is a backstop). */
const MAX_TEXT = 200_000_000;

interface Request {
  id: number;
  source: string;
  input: unknown;
  vars: Record<string, unknown>;
}

interface Reply {
  id: number;
  /** The outputs as JSON (see `encode`), and whether they hold encoded numbers or strings. */
  text?: string;
  marked?: boolean;
  error?: string;
}

/** An expression that failed, or ran out of time. */
export class ExpressionError extends Error {}

// JSON has no nan, infinite or -0, which jq values can be. In the text they
// are strings starting with U+0000, and a real string starting with U+0000
// gets one more in front.
const MARK_CHAR = "\u0000";
const SPECIAL: Record<string, number> = {
  "\u0000nan": Number.NaN,
  "\u0000inf": Number.POSITIVE_INFINITY,
  "\u0000-inf": Number.NEGATIVE_INFINITY,
  "\u0000-0": -0,
};

/** The outputs as one JSON text. Throws past MAX_TEXT characters or MAX_OUTPUT_DEPTH levels. */
function encode(values: unknown[]): { text: string; marked: boolean } {
  const parts: string[] = [];
  let size = 0;
  let marked = false;
  const push = (s: string): void => {
    size += s.length;
    if (size > MAX_TEXT) throw new ExpressionError("the output is too large to pass on");
    parts.push(s);
  };
  const write = (v: unknown, depth: number): void => {
    switch (typeof v) {
      case "number":
        if (Number.isFinite(v) && !Object.is(v, -0)) push(String(v));
        else {
          marked = true;
          push(
            JSON.stringify(
              Number.isNaN(v)
                ? "\u0000nan"
                : v === 0
                  ? "\u0000-0"
                  : v > 0
                    ? "\u0000inf"
                    : "\u0000-inf",
            ),
          );
        }
        return;
      case "string":
        if (v.startsWith(MARK_CHAR)) {
          marked = true;
          push(JSON.stringify(MARK_CHAR + v));
        } else push(JSON.stringify(v));
        return;
      case "boolean":
        push(v ? "true" : "false");
        return;
      case "object":
        break;
      default:
        push("null");
        return;
    }
    if (v === null) {
      push("null");
      return;
    }
    if (depth >= MAX_OUTPUT_DEPTH) {
      throw new ExpressionError(
        `the output is too large: it is nested more than ${MAX_OUTPUT_DEPTH} levels deep`,
      );
    }
    if (Array.isArray(v)) {
      push("[");
      for (let i = 0; i < v.length; i++) {
        if (i) push(",");
        write(v[i], depth + 1);
      }
      push("]");
      return;
    }
    push("{");
    let first = true;
    for (const k of Object.keys(v)) {
      push(`${first ? "" : ","}${JSON.stringify(k)}:`);
      first = false;
      write((v as Record<string, unknown>)[k], depth + 1);
    }
    push("}");
  };
  write(values, -1);
  return { text: parts.join(""), marked };
}

/** The outputs from `encode`'s text. */
function decode(text: string, marked: boolean): unknown[] {
  if (!marked) return JSON.parse(text) as unknown[];
  return JSON.parse(text, (_k, v: unknown) => {
    if (typeof v !== "string" || !v.startsWith(MARK_CHAR)) return v;
    if (v.startsWith(MARK_CHAR, 1)) return v.slice(1);
    return Object.hasOwn(SPECIAL, v) ? SPECIAL[v] : v;
  }) as unknown[];
}

interface Job {
  request: Request;
  timeout: number;
  resolve: (outputs: unknown[]) => void;
  reject: (e: Error) => void;
}

export class Sandbox {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;

  /** Every output of the program `source` for `input`, with `$name` variables from `vars`. */
  run(
    source: string,
    input: unknown,
    vars: Record<string, unknown>,
    timeout = EVAL_TIMEOUT,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        request: { id: this.nextId++, source, input, vars },
        timeout,
        resolve,
        reject,
      });
      this.next();
    });
  }

  private next() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift() as Job;
    this.current = job;
    let worker: Worker;
    try {
      worker = this.start();
      worker.postMessage(job.request);
    } catch (e) {
      // A value that can't be copied to the worker, or a worker that won't start.
      this.settle(new ExpressionError(e instanceof Error ? e.message : String(e)));
      return;
    }
    this.timer = setTimeout(() => {
      // The only way to stop a running expression is to stop its thread.
      void worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.settle(
        new ExpressionError(
          `took longer than ${job.timeout / 1000} s and was stopped (a regular expression that backtracks without end, or work on very large values, is the usual cause)`,
        ),
      );
    }, job.timeout);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: MARK,
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    // The worker must not keep the process alive on its own.
    worker.unref();
    worker.on("message", (reply: Reply) => {
      // -1: the worker couldn't read the request, so it doesn't know its id.
      if (reply.id !== this.current?.request.id && reply.id !== -1) return;
      if (!this.current) return;
      if (reply.error !== undefined) {
        this.settle(new ExpressionError(reply.error));
        return;
      }
      let outputs: unknown[];
      try {
        outputs = decode(reply.text ?? "[]", reply.marked === true);
      } catch (e) {
        this.settle(
          new ExpressionError(
            `the result couldn't be read back: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        return;
      }
      this.settle(null, outputs);
    });
    // A reply that can't be read here (it should always be plain text).
    worker.on("messageerror", (e) => {
      if (this.worker !== worker || !this.current) return;
      this.settle(new ExpressionError(`the result couldn't be passed on: ${e.message}`));
    });
    const gone = (why: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.current) this.settle(new ExpressionError(why));
    };
    worker.on("error", (e) => gone(`the expression couldn't be evaluated: ${e.message}`));
    worker.on("exit", () => gone("the expression used too much memory and was stopped"));
    this.worker = worker;
    return worker;
  }

  private settle(error: Error | null, outputs: unknown[] = []) {
    const job = this.current;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    if (job) {
      if (error) job.reject(error);
      else job.resolve(outputs);
    }
    this.next();
  }

  close() {
    for (const job of this.queue) job.reject(new ExpressionError("stopped"));
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.current?.reject(new ExpressionError("stopped"));
    this.current = null;
    void this.worker?.terminate();
    this.worker = null;
  }
}

/** The worker's side: compile (once per program) and run what it is sent. */
function serve() {
  const programs = new Map<string, Program>();
  parentPort?.on("message", (m: Request) => {
    let reply: Reply;
    try {
      let program = programs.get(m.source);
      if (!program) {
        program = compile(m.source);
        if (programs.size > 2000) programs.clear();
        programs.set(m.source, program);
      }
      const { text, marked } = encode(program.run(m.input, { vars: m.vars }));
      reply = { id: m.id, text, marked };
    } catch (e) {
      reply = { id: m.id, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      parentPort?.postMessage(reply);
    } catch (e) {
      parentPort?.postMessage({ id: m.id, error: `the result can't be passed on: ${e}` });
    }
  });
  // An input or variables this thread couldn't read (nested too deeply, say).
  parentPort?.on("messageerror", (e) => {
    parentPort?.postMessage({ id: -1, error: `the input couldn't be passed to jq: ${e.message}` });
  });
}

if (!isMainThread && workerData === MARK) serve();
