#!/usr/bin/env bun
/**
 * A tiny stdio MCP server for tests and replay scenarios (plan Q3): newline-delimited JSON-RPC,
 * the subset of MCP `claude` uses (initialize, tools/list, tools/call, ping). Hand-rolled so the
 * tests need no MCP SDK dependency.
 *
 *   lookup_word { word }   → a fixed definition (deterministic)
 *   append_note { text }   → appends a line to $FIXTURE_NOTES_FILE; a real side effect
 *
 * Launched through a development override, `fixture-mcp@1.0.0` → `bun test/fixtures/mcp-fixture.ts`.
 */
import { appendFileSync } from "node:fs";

export const FIXTURE_PACKAGE = "fixture-mcp";
export const FIXTURE_VERSION = "1.0.0";

const DEFINITIONS: Record<string, string> = {
  homerun: "A hit that lets the batter circle all the bases and score.",
  harness: "A set of straps and fittings, or a test rig that drives a system under test.",
};

const TOOLS = [
  {
    name: "lookup_word",
    description: "Look up the definition of an English word in the fixture dictionary.",
    inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false },
  },
  {
    name: "append_note",
    description: "Append a line of text to the notes file.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];

type Req = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

function reply(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id: number | string, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function call(name: string, args: Record<string, unknown>) {
  if (name === "lookup_word") {
    const w = String(args.word ?? "").toLowerCase();
    const d = DEFINITIONS[w];
    return d ? { content: [{ type: "text", text: `${w}: ${d}` }] } : { content: [{ type: "text", text: `No entry for "${w}".` }], isError: true };
  }
  if (name === "append_note") {
    const file = process.env.FIXTURE_NOTES_FILE;
    if (!file) return { content: [{ type: "text", text: "FIXTURE_NOTES_FILE is not set" }], isError: true };
    appendFileSync(file, String(args.text ?? "") + "\n");
    return { content: [{ type: "text", text: "noted" }] };
  }
  return null;
}

function handle(m: Req) {
  if (m.id === undefined) return; // notifications (initialized, cancelled)
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: (m.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: FIXTURE_PACKAGE, version: FIXTURE_VERSION },
      });
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS });
    case "tools/call": {
      const r = call(String(m.params?.name), (m.params?.arguments as Record<string, unknown>) ?? {});
      return r ? reply(m.id, r) : fail(m.id, -32602, `unknown tool ${String(m.params?.name)}`);
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}

if (import.meta.main) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as Req);
      } catch {
        // Not JSON: ignore, as MCP servers do for stray input.
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
