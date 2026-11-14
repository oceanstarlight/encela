// Evaluating jq expressions away from the server's thread. A program runs
// under budgets (src/jq.ts), but a single regular expression on unlucky
// text can still spin for hours, and JavaScript cannot interrupt it. So
// expressions run in a worker thread, one at a time, and a worker that
// takes too long is stopped and replaced. The server's own thread, which
// answers every tool call, never evaluates one.
//
// The worker is this same bundled file started again: when it finds itself
// in a worker with the mark below, it serves evaluations instead of
// running the command line.
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { compile, type Program } from "./jq";

const MARK = "encela:jq";
/** How long one evaluation may take. */
export const EVAL_TIMEOUT = 10_000;

interface Request {
  id: number;
  source: string;
  input: unknown;
  vars: Record<string, unknown>;
}

interface Reply {
  id: number;
  outputs?: unknown[];
  error?: string;
}

/** An expression that failed, or ran out of time. */
export class ExpressionError extends Error {}

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
          `took longer than ${job.timeout / 1000} s and was stopped (a regular expression that backtracks without end is the usual cause)`,
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
      if (reply.id !== this.current?.request.id) return;
      if (reply.error !== undefined) this.settle(new ExpressionError(reply.error));
      else this.settle(null, reply.outputs ?? []);
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
      reply = { id: m.id, outputs: program.run(m.input, { vars: m.vars }) };
    } catch (e) {
      reply = { id: m.id, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      parentPort?.postMessage(reply);
    } catch (e) {
      parentPort?.postMessage({ id: m.id, error: `the result can't be passed on: ${e}` });
    }
  });
}

if (!isMainThread && workerData === MARK) serve();
