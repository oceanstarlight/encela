// A tiny stdio MCP server for the tests. Its tools cover what the pipeline
// engine has to cope with: text results, structured results that wrap
// text, JSON as text, failures reported in the result, slow calls, and
// tools that say (or don't say) that they only read.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const text = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const local = { readOnlyHint: true, openWorldHint: false };
const tools = [
  // No annotations: it may change things and may reach outside, as far as anyone can tell.
  { name: "echo", description: "Says back what it got", inputSchema: text },
  {
    name: "add",
    description: "Adds two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    annotations: local,
  },
  { name: "upper", description: "Upper case, wrapped in one field", inputSchema: text, annotations: local },
  {
    name: "list",
    description: "A JSON list of files, as text",
    inputSchema: { type: "object", properties: { n: { type: "integer" } } },
    annotations: local,
  },
  {
    name: "read",
    description: "Reads a made-up file; fails for names that start with bad",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: local,
  },
  {
    name: "sleep",
    description: "Answers after ms milliseconds",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
    annotations: local,
  },
  {
    name: "write",
    description: "Appends a line to the file named by ECHO_LOG",
    inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
  },
  { name: "fetch", description: "Pretends to fetch a URL", inputSchema: text, annotations: { readOnlyHint: true } },
  { name: "image", description: "A one-pixel image", inputSchema: { type: "object" }, annotations: local },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const say = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") {
    ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo" } });
  } else if (m.method === "tools/list") ok({ tools });
  else if (m.method === "tools/call") {
    const a = m.params.arguments ?? {};
    switch (m.params.name) {
      case "echo":
        return ok(say(`${process.env.ECHO_PREFIX ?? ""}${a.text}`));
      case "add":
        return ok(say(String((a.a ?? 0) + (a.b ?? 0))));
      case "upper": {
        const out = String(a.text).toUpperCase();
        return ok(say(out, { structuredContent: { content: out } }));
      }
      case "list": {
        const files = Array.from({ length: a.n ?? 3 }, (_, i) => ({ path: `f${i}.ts`, size: 10 * (i + 1) }));
        return ok(say(JSON.stringify({ files, id: "h-1" })));
      }
      case "read":
        if (String(a.path).startsWith("bad")) {
          return ok(say(JSON.stringify({ errorMessage: `no file ${a.path}` }), { isError: true }));
        }
        return ok(say(`contents of ${a.path}`));
      case "sleep":
        return void setTimeout(() => ok(say(`slept ${a.ms}`)), a.ms);
      case "write":
        if (process.env.ECHO_LOG) appendFileSync(process.env.ECHO_LOG, `${a.line}\n`);
        return ok(say("written"));
      case "fetch":
        return ok(say(`<html>${a.text}</html>`));
      case "image":
        return ok({ content: [{ type: "image", data: PIXEL, mimeType: "image/png" }] });
      default:
        return ok(say(`MCP error -32602: Tool ${m.params.name} not found`, { isError: true }));
    }
  } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
