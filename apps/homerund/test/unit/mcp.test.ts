import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpLauncher, RunSetupError } from "../../src/agent/claude/mcp";
import { FIXTURE_PACKAGE, FIXTURE_VERSION } from "../fixtures/mcp-fixture";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-fixture.ts");

describe("McpLauncher (§5.5)", () => {
  const spec = { id: "fixture", transport: "stdio", runner: "npx", package: FIXTURE_PACKAGE, version: FIXTURE_VERSION, args: ["--x"], env: { A: "1" } } as const;

  test("a development override maps package@version to a local command", () => {
    const l = new McpLauncher({ [`${FIXTURE_PACKAGE}@${FIXTURE_VERSION}`]: { command: process.execPath, args: [FIXTURE], env: { B: "2" } } });
    expect(l.resolve(spec as never)).toEqual({ command: process.execPath, args: [FIXTURE, "--x"], env: { B: "2", A: "1" } });
  });

  test("without the Node/uv components a stdio server fails with component_missing; http is unsupported", () => {
    const l = new McpLauncher({});
    expect(() => l.resolve(spec as never)).toThrow(RunSetupError);
    try {
      l.resolve(spec as never);
    } catch (e) {
      expect((e as RunSetupError).code).toBe("component_missing");
    }
    try {
      l.resolve({ id: "r", transport: "http", url: "https://example.com/mcp" } as never);
    } catch (e) {
      expect((e as RunSetupError).code).toBe("unsupported_mcp_transport");
    }
  });
});

describe("the stdio MCP fixture", () => {
  test("speaks initialize, tools/list and tools/call", async () => {
    const notes = join(mkdtempSync(join(tmpdir(), "hr-mcp-")), "notes.txt");
    const p = Bun.spawn([process.execPath, FIXTURE], { stdin: "pipe", stdout: "pipe", env: { FIXTURE_NOTES_FILE: notes } });
    const send = (m: object) => p.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup_word", arguments: { word: "homerun" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "append_note", arguments: { text: "hello" } } });
    p.stdin.end();
    const lines = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(lines[0].result.protocolVersion).toBe("2025-06-18");
    expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["lookup_word", "append_note"]);
    expect(lines[2].result.content[0].text).toContain("circle all the bases");
    expect(readFileSync(notes, "utf8")).toBe("hello\n");
  });
});
