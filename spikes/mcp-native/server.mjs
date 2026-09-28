#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";

const server = new McpServer({ name: "homerun-spike-mcp-native", version: "0.0.1" });
server.tool("sqlite_version", "Open an in-memory SQLite DB via the better-sqlite3 native add-on and return its version", async () => {
  const db = new Database(":memory:");
  const v = db.prepare("select sqlite_version() as v").get().v;
  db.close();
  return { content: [{ type: "text", text: JSON.stringify({ sqlite: v, node: process.version, execPath: process.execPath }) }] };
});
await server.connect(new StdioServerTransport());
