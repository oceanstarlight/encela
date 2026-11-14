// A tiny stdio MCP server for the tests: two tools, `echo` and `add`.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Says back what it got",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "Adds two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (t) => ({ content: [{ type: "text", text: t }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") {
    ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo" },
    });
  } else if (m.method === "tools/list") ok({ tools });
  else if (m.method === "tools/call") {
    const a = m.params.arguments ?? {};
    if (m.params.name === "echo") ok(text(`${process.env.ECHO_PREFIX ?? ""}${a.text}`));
    else ok(text(String((a.a ?? 0) + (a.b ?? 0))));
  } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
