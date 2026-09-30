/**
 * Milestone 8b probe P7: which shell does the bundled claude's Bash tool run on this machine?
 * A local server stands in for the API: it asks for one Bash call whose output differs between
 * bash, PowerShell and cmd, and records the tool result claude sends back. No request leaves the
 * machine and nothing is spent.
 *
 * On Windows it runs claude with homerund's minimal environment, then with Git Bash pinned
 * (CLAUDE_CODE_GIT_BASH_PATH), then, with `--hide-git`, with Git for Windows renamed away (a
 * stock machine has none), and puts it back. Prints one JSON object.
 *
 *   bun spikes/windows-probe/bash.ts [--hide-git]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const WIN = process.platform === "win32";
const exe = WIN ? "claude.exe" : "claude";
const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
const store = join(root, "node_modules", ".pnpm");
const dir = readdirSync(store).find((d) => d.startsWith(`@anthropic-ai+${pkg}@`));
const claude = dir ? join(store, dir, "node_modules", "@anthropic-ai", pkg, exe) : "";
if (!claude || !existsSync(claude)) {
  console.log(JSON.stringify({ error: `no ${pkg}/${exe} in ${store}` }));
  process.exit(0);
}

const COMMAND = 'echo "PROBE bash=[$BASH_VERSION] ps=[$($PSVersionTable.PSVersion)] comspec=[%COMSPEC%] zero=[$0]"';
const TOOL_ID = "toolu_01probe";

type Block = { type: string; tool_use_id?: string; content?: unknown; text?: string };
type Msg = { role: string; content: string | Block[] };
type Body = { messages?: Msg[]; tools?: Array<{ name?: string; description?: string }>; stream?: boolean; model?: string };

let log: Array<Record<string, unknown>> = [];

function reply(body: Body, content: Array<Record<string, unknown>>, stop: string): Response {
  const message = { id: `msg_${log.length}`, type: "message", role: "assistant", model: body.model ?? "claude-haiku-4-5", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) return Response.json({ ...message, content, stop_reason: stop });
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", { message: { ...message, content: [], stop_reason: null } });
  content.forEach((b, index) => {
    if (b.type === "tool_use") {
      s += ev("content_block_start", { index, content_block: { ...b, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    } else {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    }
    s += ev("content_block_stop", { index });
  });
  s += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  s += ev("message_stop", {});
  return new Response(s, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
    if (url.pathname !== "/v1/messages") return Response.json({});
    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {}
    const tools = (body.tools ?? []).map((t) => t.name ?? "?");
    // The Bash tool, else claude's Windows PowerShell tool: whichever shell tool is on offer.
    const bash = (body.tools ?? []).find((t) => t.name === "Bash") ?? (body.tools ?? []).find((t) => t.name === "PowerShell");
    const last = body.messages?.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((b) => b.type === "tool_result" && b.tool_use_id === TOOL_ID) : undefined;
    const entry: Record<string, unknown> = { tools: tools.length };
    if (tools.some((t) => /shell|powershell|cmd/i.test(t) && t !== "Bash")) entry.otherShellTools = tools.filter((t) => /shell|powershell|cmd/i.test(t));
    log.push(entry);
    if (!bash) return reply(body, [{ type: "text", text: "ok" }], "end_turn");
    if (result) {
      entry.toolResult = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      return reply(body, [{ type: "text", text: "done" }], "end_turn");
    }
    const d = bash.description ?? "";
    entry.shellTool = bash.name;
    entry.bashDescription = {
      length: d.length,
      mentions: ["Git Bash", "PowerShell", "cmd.exe", "Windows", "bash"].filter((w) => d.includes(w)),
      head: d.slice(0, 400),
      windowsLines: d.split("\n").filter((l) => /windows|powershell|git bash|cmd/i.test(l)).slice(0, 10),
    };
    return reply(body, [{ type: "tool_use", id: TOOL_ID, name: bash.name, input: { command: COMMAND, description: "probe" } }], "tool_use");
  },
});

function baseEnv(home: string): Record<string, string> {
  const e: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: "sk-ant-mock-not-a-real-key",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    HOME: home,
  };
  if (WIN) {
    const sr = process.env.SystemRoot ?? "C:\\Windows";
    Object.assign(e, {
      SystemRoot: sr,
      windir: sr,
      ComSpec: join(sr, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: [join(sr, "System32"), sr, join(sr, "System32", "Wbem"), join(sr, "System32", "WindowsPowerShell", "v1.0")].join(";"),
      SystemDrive: process.env.SystemDrive ?? "C:",
      TEMP: home,
      TMP: home,
      USERPROFILE: home,
    });
  } else {
    Object.assign(e, { PATH: "/usr/bin:/bin", TMPDIR: home, SHELL: "/bin/bash" });
  }
  return e;
}

/** `tools`: homerund passes the spec's built-in list as `--tools` (the SDK's `tools` option). */
function run(label: string, env: Record<string, string>, tools?: string): Promise<Record<string, unknown>> {
  log = [];
  const t0 = Date.now();
  const args = ["-p", "run the probe", "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-4-5", "--max-turns", "3", "--allowedTools", "Bash,PowerShell"];
  if (tools) args.push("--tools", tools);
  return new Promise((res) => {
    const c = spawn(claude, args, { env, windowsHide: true, cwd: env.TEMP ?? env.TMPDIR, stdio: ["ignore", "pipe", "pipe"] });
    let so = "";
    let se = "";
    c.stdout.on("data", (d) => (so += d));
    c.stderr.on("data", (d) => (se += d));
    const timer = setTimeout(() => c.kill(), 60_000);
    c.on("exit", (code) => {
      clearTimeout(timer);
      const results: string[] = [];
      let initTools: string[] | undefined;
      for (const line of so.split(/\r?\n/)) {
        try {
          const m = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[]; message?: { content?: Block[] }; result?: string };
          if (m.type === "system" && m.subtype === "init") initTools = m.tools;
          if (m.type === "user") for (const b of m.message?.content ?? []) if (b.type === "tool_result") results.push(JSON.stringify(b.content).slice(0, 600));
          if (m.type === "result") results.push(`result: ${String(m.result ?? m.subtype).slice(0, 300)}`);
        } catch {}
      }
      res({
        label,
        code,
        ms: Date.now() - t0,
        shellTools: initTools?.filter((t) => /bash|shell|powershell|cmd/i.test(t)),
        requests: log,
        results,
        stderr: se.slice(0, 1500),
        stdoutHead: initTools ? undefined : so.slice(0, 1500),
      });
    });
  });
}

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `hr-p7-${n}-`));
const out: Record<string, unknown>[] = [];
out.push(await run("homerund-env", baseEnv(tmp("min"))));
if (WIN) {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const git = join(pf, "Git");
  const facts = {
    gitBash: existsSync(join(git, "bin", "bash.exe")),
    wslBash: existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe")),
    msys2: existsSync("C:\\msys64\\usr\\bin\\bash.exe"),
    pwsh7: existsSync(join(pf, "PowerShell", "7", "pwsh.exe")),
  };
  out.push({ label: "facts", ...facts });
  const pinned = baseEnv(tmp("pin"));
  pinned.CLAUDE_CODE_GIT_BASH_PATH = join(git, "bin", "bash.exe");
  out.push(await run("pinned-git-bash", pinned));
  const missing = baseEnv(tmp("miss"));
  missing.CLAUDE_CODE_GIT_BASH_PATH = join(tmp("nobash"), "bash.exe");
  out.push(await run("pinned-to-missing", missing));
  // What homerund will pass: Git Bash pinned, the PowerShell tool off, an explicit tool list.
  const hr = { ...pinned, CLAUDE_CODE_USE_POWERSHELL_TOOL: "0" };
  out.push(await run("pinned+ps-off+tools", hr, "Bash,Read"));
  if (process.argv.includes("--hide-git") && facts.gitBash) {
    const hidden = `${git}.hidden-by-probe`;
    let renamed = false;
    for (let i = 0; i < 20 && !renamed; i++) {
      try {
        renameSync(git, hidden);
        renamed = true;
      } catch (e) {
        if (i === 19) out.push({ label: "hide-git", error: String(e) });
        else await Bun.sleep(250);
      }
    }
    if (renamed) {
      try {
        out.push(await run("no-git", baseEnv(tmp("nogit"))));
        out.push(await run("no-git+tools-Bash", baseEnv(tmp("nogit-t")), "Bash,Read"));
        out.push(await run("no-git+tools-Read", baseEnv(tmp("nogit-r")), "Read"));
        out.push(await run("no-git+ps-off", { ...baseEnv(tmp("nogit-off")), CLAUDE_CODE_USE_POWERSHELL_TOOL: "0" }, "Read"));
        const psOnPath = baseEnv(tmp("nogit-pwsh"));
        psOnPath.PATH = `${psOnPath.PATH};${join(pf, "PowerShell", "7")}`;
        out.push(await run("no-git+pwsh7-on-path", psOnPath));
      } finally {
        for (let i = 0; i < 40; i++) {
          try {
            renameSync(hidden, git);
            break;
          } catch (e) {
            if (i === 39) out.push({ label: "restore-git", error: String(e) });
            await Bun.sleep(250);
          }
        }
      }
    }
  }
}
server.stop(true);
console.log(JSON.stringify({ claude: claude.slice(root.length), command: COMMAND, results: out }, null, 2));
process.exit(0);
