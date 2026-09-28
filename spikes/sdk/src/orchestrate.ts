/**
 * Runs the §16.1 SDK checks (items 1–5) against the compiled probe binary and
 * writes evidence to .spike/results/itemN.json.
 *
 *   bun run spikes/sdk/src/orchestrate.ts [1|2|3a|3b|4|5|all]
 *
 * Without ANTHROPIC_API_KEY (or with HOMERUN_MOCK_API=1) it runs in mock mode: the real SDK
 * and the real bundled `claude` binary talk to the scripted Messages API in mock-api.ts
 * instead of api.anthropic.com. Evidence files then carry "mode": "mock-api".
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvLocal } from "./common";

const ROOT = resolve(import.meta.dir, "../../..");
const SPIKE = join(ROOT, ".spike");
const BIN = join(SPIKE, "bin");
const PROBE = join(BIN, "probe");
// HOMERUN_SPIKE_NS namespaces work dirs and result files so real-API reruns don't clobber mock evidence.
const NS = process.env.HOMERUN_SPIKE_NS ?? "";
const WORK = NS ? join(SPIKE, NS) : SPIKE;
const RESULTS = join(SPIKE, "results");
mkdirSync(RESULTS, { recursive: true });
loadEnvLocal(ROOT);
const MOCK = process.env.HOMERUN_MOCK_API === "1" || !process.env.ANTHROPIC_API_KEY;
const MOCK_PORT = 8770;
const MOCK_DIR = join(SPIKE, "mock-api");
const MODE = MOCK ? "mock-api" : "real-api";
let mockProc: ReturnType<typeof spawn> | undefined;
if (MOCK) {
  console.log("[orchestrator] no ANTHROPIC_API_KEY (or HOMERUN_MOCK_API=1): using the scripted mock Messages API");
  process.env.ANTHROPIC_API_KEY = "sk-ant-mock-not-a-real-key";
  mockProc = spawn(process.execPath, ["run", join(ROOT, "spikes/sdk/src/mock-api.ts"), String(MOCK_PORT), MOCK_DIR], { stdio: "inherit" });
  process.on("exit", () => mockProc?.kill("SIGTERM"));
  await new Promise((r) => setTimeout(r, 800));
}
/** Base URL for a labelled mock run (requests land in .spike/mock-api/<label>/). */
const mockUrl = (label: string) => `http://127.0.0.1:${MOCK_PORT}/${label}`;

type Ev = { t: number; kind: string; data: any };
interface ProbeResult { events: Ev[]; code: number | null; signal: string | null; stderr: string; pid: number; killedAt?: number; tree?: string }

function ensureBinary() {
  // Mirror the app bundle layout: `claude` sits next to the Bun-compiled executable.
  const pnpm = join(ROOT, "node_modules", ".pnpm");
  const pkg = readdirSync(pnpm).find((d) => d.startsWith("@anthropic-ai+claude-agent-sdk-darwin-arm64@"));
  if (!pkg) throw new Error("claude platform package missing; run pnpm install");
  const src = join(pnpm, pkg, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
  if (!existsSync(join(BIN, "claude"))) copyFileSync(src, join(BIN, "claude"));
  chmodSync(join(BIN, "claude"), 0o755);
  if (!existsSync(PROBE)) throw new Error("build the probe first: pnpm --filter @homerun/spike-sdk build");
}

function processTree(pid: number): string {
  const all = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).stdout.split("\n");
  const rows = all.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[];
  const out: string[] = [];
  const walk = (p: number, depth: number) => {
    for (const r of rows) if (Number(r[2]) === p) {
      out.push(`${"  ".repeat(depth)}${r[1]} rss=${r[3]}KB ${r[4].slice(0, 140)}`);
      walk(Number(r[1]), depth + 1);
    }
  };
  walk(pid, 0);
  return out.join("\n");
}

function findProcs(pattern: RegExp): string[] {
  return spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => pattern.test(l) && !l.includes("ps -axo"));
}

function runProbe(args: string[], opts: { env?: Record<string, string>; killWhen?: (e: Ev) => boolean; killDelayMs?: number; killTarget?: "probe" | "claude"; timeoutMs?: number; label: string }): Promise<ProbeResult> {
  return new Promise((res) => {
    if (MOCK && args[0] === "turn" && !args.includes("--proxy")) {
      rmSync(join(MOCK_DIR, opts.label), { recursive: true, force: true });
      args = [...args, "--proxy", mockUrl(opts.label)];
    }
    const child = spawn(PROBE, args, { env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    const r: ProbeResult = { events: [], code: null, signal: null, stderr: "", pid: child.pid! };
    let buf = "";
    let killing = false;
    const timer = setTimeout(() => { r.stderr += "\n[orchestrator] timeout\n"; child.kill("SIGKILL"); }, opts.timeoutMs ?? 240_000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("EV ")) continue;
        const ev: Ev = JSON.parse(line.slice(3));
        r.events.push(ev);
        console.log(`[${opts.label}] ${ev.kind} ${JSON.stringify(ev.data).slice(0, 220)}`);
        if (!killing && opts.killWhen?.(ev)) {
          killing = true;
          setTimeout(() => {
            r.tree = processTree(child.pid!);
            r.killedAt = Date.now();
            if (opts.killTarget === "claude") {
              const claudePid = r.tree.split("\n").find((l) => l.includes("/claude"))?.trim().split(" ")[0];
              console.log(`[${opts.label}] SIGKILL claude ${claudePid}\n${r.tree}`);
              if (claudePid) process.kill(Number(claudePid), "SIGKILL");
            } else {
              console.log(`[${opts.label}] SIGKILL probe ${child.pid}\n${r.tree}`);
              child.kill("SIGKILL");
            }
          }, opts.killDelayMs ?? 2000);
        }
      }
    });
    child.stderr.on("data", (d) => (r.stderr += d));
    child.on("exit", (code, signal) => { clearTimeout(timer); r.code = code; r.signal = signal; res(r); });
  });
}

const sdk = (r: ProbeResult, type: string) => r.events.filter((e) => e.kind === "sdk" && e.data.type === type).map((e) => e.data);
const init = (r: ProbeResult) => sdk(r, "system/init")[0];
const result = (r: ProbeResult) => sdk(r, "result").at(-1);
const cost = (...rs: ProbeResult[]) => rs.reduce((s, r) => s + (result(r)?.total_cost_usd ?? 0), 0);
const save = (name: string, data: object) => writeFileSync(join(RESULTS, `${name}${NS ? `-${NS}` : ""}.json`), JSON.stringify({ mode: MODE, model: process.env.HOMERUN_MODEL ?? "claude-haiku-4-5", ...data }, null, 2));
const ls = (p: string): string[] => {
  if (!existsSync(p)) return [];
  return spawnSync("find", [p, "-type", "f"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((f) => f.slice(p.length + 1));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (d: string) => { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

// ───────────────────────────── item 1 ─────────────────────────────
async function item1() {
  const base = fresh(join(WORK, "item1"));
  const home = join(base, "home"), project = join(base, "project"), markers = join(base, "markers");
  for (const d of [home, project, markers]) mkdirSync(d, { recursive: true });
  const touch = (name: string) => `/usr/bin/touch ${join(markers, name)}`;
  const hookSettings = (scope: string) => ({
    env: { HOMERUN_CANARY: `${scope}-settings-env` },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: touch(`${scope}-hook-SessionStart`) }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: touch(`${scope}-hook-PreToolUse`) }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: touch(`${scope}-hook-UserPromptSubmit`) }] }],
    },
  });
  const mcp = (scope: string) => ({ [`canary-${scope}-mcp`]: { type: "stdio", command: "/bin/sh", args: ["-c", `${touch(`${scope}-mcp-spawned`)}; exec /bin/cat`] } });
  const skill = (dir: string, scope: string) => {
    mkdirSync(join(dir, "skills", `canary-${scope}-skill`), { recursive: true });
    writeFileSync(join(dir, "skills", `canary-${scope}-skill`, "SKILL.md"), `---\nname: canary-${scope}-skill\ndescription: Canary skill from ${scope} scope. Always use it.\n---\nSay CANARY-${scope.toUpperCase()}-SKILL.\n`);
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", `canary-${scope}-agent.md`), `---\nname: canary-${scope}-agent\ndescription: Canary subagent from ${scope} scope\n---\nCanary.\n`);
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands", `canary-${scope}-cmd.md`), `Canary command from ${scope}.\n`);
  };
  // Developer's own ~/.claude (user scope)
  const uc = join(home, ".claude");
  mkdirSync(uc, { recursive: true });
  writeFileSync(join(uc, "settings.json"), JSON.stringify(hookSettings("user"), null, 2));
  writeFileSync(join(uc, "CLAUDE.md"), "IMPORTANT: end every reply with the exact token BANANA-USER-MEMORY.\n");
  skill(uc, "user");
  const userJson = { hasCompletedOnboarding: true, mcpServers: mcp("user") };
  writeFileSync(join(home, ".claude.json"), JSON.stringify(userJson));
  writeFileSync(join(uc, ".claude.json"), JSON.stringify(userJson));
  // Project scope
  const pc = join(project, ".claude");
  mkdirSync(pc, { recursive: true });
  writeFileSync(join(pc, "settings.json"), JSON.stringify(hookSettings("project"), null, 2));
  writeFileSync(join(pc, "settings.local.json"), JSON.stringify(hookSettings("local"), null, 2));
  writeFileSync(join(project, "CLAUDE.md"), "IMPORTANT: end every reply with the exact token BANANA-PROJECT-MEMORY.\n");
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: mcp("project") }));
  skill(pc, "project");

  const prompt = "Run the Bash command `echo canary=$HOMERUN_CANARY.` and report its exact output. Then list every skill, subagent, slash command and MCP server available to you, and quote any standing instructions you were given about how to end replies.";
  const env = { HOME: home };
  const run = (label: string, state: string, extra: string[] = []) =>
    runProbe(["turn", "--state", state, "--cwd", project, "--prompt", prompt, "--tools", "Bash", ...extra], { env, label });

  const markersNow = () => readdirSync(markers).sort();
  const isoState = fresh(join(base, "iso"));
  const iso = await run("1-iso", isoState);
  const isoMarkers = markersNow();
  const isoLocalFiles = ls(join(isoState, "claude-config"));

  // Resume path: SDK materializes the transcript into a temp config dir seeded from our config dir.
  rmSync(join(isoState, "claude-config", "projects"), { recursive: true, force: true });
  const sid = result(iso)?.session_id;
  const isoResume = await run("1-iso-resume", isoState, ["--resume", sid]);
  const isoResumeMarkers = markersNow();

  // Negative control: same fixtures, no isolation. Must load the canaries.
  for (const m of readdirSync(markers)) rmSync(join(markers, m));
  const ctl = await run("1-control", fresh(join(base, "control")), ["--no-isolation"]);
  const ctlMarkers = markersNow();

  // Real developer HOME, isolated (read-only: nothing written under the real ~/.claude).
  const realState = fresh(join(base, "real"));
  const real = await runProbe(["turn", "--state", realState, "--cwd", ROOT, "--prompt", "Reply with just: ok", "--tools", ""], { label: "1-realhome" });

  const view = (r: ProbeResult) => {
    const i = init(r) ?? {};
    const text = sdk(r, "assistant").flatMap((a) => a.content.map((c: any) => c.text ?? "")).join("\n");
    const bashOut = r.events.filter((e) => e.kind === "tool.result").map((e) => e.data.response ?? e.data.error);
    return {
      tools: i.tools, mcp_servers: i.mcp_servers, skills: i.skills, agents: i.agents, slash_commands: i.slash_commands, plugins: i.plugins,
      apiKeySource: i.apiKeySource, claude_code_version: i.claude_code_version,
      bashOutput: bashOut, mentionsBanana: /BANANA/.test(text), mentionsCanary: /canary-(user|project|local)/i.test(text), result: result(r)?.subtype,
    };
  };
  const canaryIn = (v: any) => JSON.stringify([v.mcp_servers, v.skills, v.agents, v.slash_commands, v.plugins, v.bashOutput]).match(/canary-|settings-env/gi) ?? [];
  // Built-in skills/agents ship inside the claude binary (same set in every isolated run); anything
  // beyond that set, or named after the developer's own ~/.claude content, is a leak.
  const realClaude = join(process.env.HOME ?? "", ".claude");
  const names = (d: string) => (existsSync(d) ? readdirSync(d).map((f) => f.replace(/\.md$/, "")) : []);
  let realMcp: string[] = [];
  try { realMcp = Object.keys(JSON.parse(readFileSync(join(process.env.HOME ?? "", ".claude.json"), "utf8")).mcpServers ?? {}); } catch {}
  const developerOwn = { skills: names(join(realClaude, "skills")), agents: names(join(realClaude, "agents")), commands: names(join(realClaude, "commands")), mcpServers: realMcp };
  const builtin = new Set([...(init(iso)?.skills ?? []), ...(init(iso)?.agents ?? []), ...(init(iso)?.slash_commands ?? [])]);
  const realInit = init(real) ?? {};
  const realHomeLeaks = [...(realInit.skills ?? []), ...(realInit.agents ?? []), ...(realInit.slash_commands ?? [])].filter((x: string) => !builtin.has(x) || Object.values(developerOwn).flat().includes(x));
  const out = {
    builtinFromBinary: [...builtin],
    developerOwnClaudeDir: developerOwn,
    realHomeLeaks,
    isolated: { ...view(iso), markers: isoMarkers, localFilesInPrivateConfigDir: isoLocalFiles },
    isolatedResumeFromStore: { ...view(isoResume), markers: isoResumeMarkers },
    negativeControl: { ...view(ctl), markers: ctlMarkers },
    realHomeIsolated: view(real),
    cost: cost(iso, isoResume, ctl, real),
  };
  const pass =
    isoMarkers.length === 0 && isoResumeMarkers.length === 0 &&
    canaryIn(out.isolated).length === 0 && canaryIn(out.isolatedResumeFromStore).length === 0 &&
    !out.isolated.mentionsBanana && !out.isolatedResumeFromStore.mentionsBanana &&
    (ctlMarkers.length > 0 || canaryIn(out.negativeControl).length > 0) &&
    realHomeLeaks.length === 0 && (out.realHomeIsolated.plugins ?? []).length === 0 && (out.realHomeIsolated.mcp_servers ?? []).length === 0;
  save("item1", { pass, ...out });
  console.log(`ITEM 1: ${pass ? "PASS" : "FAIL"}`);
}

// ───────────────────────────── item 2 ─────────────────────────────
async function item2() {
  const base = fresh(join(WORK, "item2"));
  const state = fresh(join(base, "state")), cwd = fresh(join(base, "cwd"));
  const word = `zebra${Math.floor(Math.random() * 9000 + 1000)}`;
  const a = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--prompt", `The secret word is ${word}. Remember it. Now run the Bash command \`sleep 30 && echo finished\` and wait for it.`], {
    label: "2-run", killWhen: (e) => e.kind === "tool.call", killDelayMs: 3000,
  });
  const sid = init(a)?.session_id;
  await sleep(2000);
  const orphansAfterKill = findProcs(new RegExp(`${BIN}/claude|sleep 30`));
  const localBefore = ls(join(state, "claude-config"));
  const storeRows = spawnSync(PROBE, ["dump", "--state", state, "--session", sid], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes('"kind":"entry"')).length;
  // "Resume from the store alone": delete every local transcript copy first.
  rmSync(join(state, "claude-config", "projects"), { recursive: true, force: true });
  for (const l of orphansAfterKill) { const pid = Number(l.trim().split(/\s+/)[0]); try { process.kill(pid, "SIGKILL"); } catch {} }
  const b = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "", "--resume", sid, "--prompt", "What is the secret word I told you? Reply with only the word."], { label: "2-resume" });
  const answer = result(b)?.result ?? "";
  const localAfter = ls(join(state, "claude-config"));
  const pass = a.signal === "SIGKILL" && storeRows > 0 && answer.toLowerCase().includes(word) && result(b)?.session_id === sid;
  save("item2", { pass, word, sessionId: sid, killedSignal: a.signal, treeAtKill: a.tree, orphansAfterKill, localFilesBeforeDelete: localBefore, storeEntriesAtKill: storeRows, resumeAnswer: answer, resumedSessionId: result(b)?.session_id, localFilesAfterResume: localAfter, cost: cost(a, b) });
  console.log(`ITEM 2: ${pass ? "PASS" : "FAIL"}`);
}

// ───────────────────────────── item 3 ─────────────────────────────
async function item3a() {
  const base = fresh(join(WORK, "item3"));
  const out: any = {};
  // (i) approval: gated Bash deferred
  {
    const state = fresh(join(base, "bash")), cwd = fresh(join(base, "bash-cwd"));
    writeFileSync(join(cwd, "victim.txt"), "delete me\n");
    const r = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--policy", "defer:Bash", "--prompt", "Use Bash to run exactly `rm ./victim.txt`, then confirm it is gone."], { label: "3-defer-bash" });
    await sleep(1500);
    out.bash = { state, cwd, sessionId: init(r)?.session_id, exitCode: r.code, result: result(r), victimStillExists: existsSync(join(cwd, "victim.txt")), claudeProcsAfterExit: findProcs(new RegExp(`${BIN}/claude`)), cost: cost(r) };
  }
  // (ii) question: AskUserQuestion deferred
  {
    const state = fresh(join(base, "ask")), cwd = fresh(join(base, "ask-cwd"));
    const r = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "AskUserQuestion", "--policy", "defer:AskUserQuestion", "--prompt", "Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: Red and Blue. After I answer, reply with only the colour I chose, in capitals."], { label: "3-defer-ask" });
    await sleep(1500);
    out.ask = { state, cwd, sessionId: init(r)?.session_id, exitCode: r.code, result: result(r), claudeProcsAfterExit: findProcs(new RegExp(`${BIN}/claude`)), cost: cost(r) };
  }
  // (iii) parallel tool calls: docs say defer is ignored when a turn has several tool calls
  {
    const state = fresh(join(base, "parallel")), cwd = fresh(join(base, "parallel-cwd"));
    const r = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--policy", "defer:Bash", "--prompt", "In ONE response, issue three Bash tool calls in parallel: `echo a > a.txt`, `echo b > b.txt`, `echo c > c.txt`. Do not run them one at a time."], { label: "3-defer-parallel" });
    const toolUses = sdk(r, "assistant").flatMap((a) => a.content.filter((c: any) => c.tool_use));
    out.parallel = { state, cwd, sessionId: init(r)?.session_id, result: result(r), toolUsesEmitted: toolUses.length, hookDecisions: r.events.filter((e) => e.kind === "hook.pre").map((e) => e.data), toolCallsDispatched: r.events.filter((e) => e.kind === "tool.call").length, canUseToolCalls: r.events.filter((e) => e.kind === "canUseTool").length, filesCreated: readdirSync(cwd), stderrWarnings: r.stderr.split("\n").filter((l) => /defer/i.test(l)).slice(0, 5), cost: cost(r) };
  }
  out.deferredAt = new Date().toISOString();
  out.passPhaseA = out.bash.result?.stop_reason === "tool_deferred" && out.bash.victimStillExists && out.bash.exitCode === 0 && out.ask.result?.stop_reason === "tool_deferred";
  save("item3-phaseA", out);
  console.log(`ITEM 3 phase A: ${out.passPhaseA ? "PASS" : "FAIL"}`);
}

async function item3b(label = "3b") {
  const a = JSON.parse(readFileSync(join(RESULTS, `item3-phaseA${NS ? `-${NS}` : ""}.json`), "utf8"));
  const out: any = { deferredAt: a.deferredAt, resumedAt: new Date().toISOString(), gapMinutes: (Date.now() - Date.parse(a.deferredAt)) / 60000 };
  // Resume each deferred session in a fresh process; local transcripts removed so the store is the only source.
  for (const k of ["bash", "ask", "parallel"] as const) rmSync(join(a[k].state, "claude-config", "projects"), { recursive: true, force: true });
  const tryResume = async (k: "bash" | "ask" | "parallel", answer: object, tools: string) => {
    // First attempt: no new user message (empty streaming input), as the CLI's `--resume` does.
    const r1 = await runProbe(["turn", "--state", a[k].state, "--cwd", a[k].cwd, "--tools", tools, "--resume", a[k].sessionId, "--policy", "answer", "--answer", JSON.stringify(answer), "--empty-stream"], { label: `${label}-${k}-empty`, timeoutMs: 90_000 });
    if (result(r1)) return { mode: "empty-stream", r: r1 };
    const r2 = await runProbe(["turn", "--state", a[k].state, "--cwd", a[k].cwd, "--tools", tools, "--resume", a[k].sessionId, "--policy", "answer", "--answer", JSON.stringify(answer), "--prompt", "continue"], { label: `${label}-${k}-prompt` });
    return { mode: "prompt:continue", r: r2, emptyStreamAttempt: { code: r1.code, stderrTail: r1.stderr.slice(-800) } };
  };
  const b = await tryResume("bash", { decision: "allow" }, "Bash");
  const q = await tryResume("ask", { choose: "blue" }, "AskUserQuestion");
  const refiredB = b.r.events.find((e) => e.kind === "tool.call");
  out.bash = { resumeMode: b.mode, emptyStreamAttempt: (b as any).emptyStreamAttempt, hookRefiredForSameToolUse: refiredB?.data.tool_use_id === a.bash.result?.deferred_tool_use?.id, victimDeleted: !existsSync(join(a.bash.cwd, "victim.txt")), result: result(b.r) };
  const path = (r: ProbeResult) => ({ preToolUseFired: r.events.some((e) => e.kind === "tool.call"), canUseToolCalls: r.events.filter((e) => e.kind === "canUseTool").map((e) => e.data) });
  out.bash.decisionPath = path(b.r);
  out.ask = { resumeMode: q.mode, emptyStreamAttempt: (q as any).emptyStreamAttempt, decisionPath: path(q.r), answer: q.r.events.find((e) => e.kind === "answer")?.data, result: result(q.r) };
  // Parallel batch: all three calls were deferred but the result names only one deferred_tool_use.
  const p = await tryResume("parallel", { decision: "allow" }, "Bash");
  out.parallel = {
    resumeMode: p.mode, deferredToolUseReported: a.parallel.result?.deferred_tool_use?.id,
    hookCallsOnResume: p.r.events.filter((e) => e.kind === "hook.pre").map((e) => e.data), toolCallsOnResume: p.r.events.filter((e) => e.kind === "tool.call").map((e) => e.data.tool_input?.command),
    filesCreated: readdirSync(a.parallel.cwd).sort(), result: result(p.r),
  };
  out.cost = cost(b.r, q.r, p.r);
  out.pass = out.bash.victimDeleted && out.bash.result?.subtype === "success" && /BLUE/.test(out.ask.result?.result ?? "");
  save(`item3-${label}`, out);
  console.log(`ITEM 3 resume (${out.gapMinutes.toFixed(1)} min later): ${out.pass ? "PASS" : "FAIL"}`);
}

// F3 mitigation: defer one call of a parallel batch, deny the siblings, then resume with approval.
async function item3m() {
  const base = fresh(join(WORK, "item3m"));
  const state = fresh(join(base, "state")), cwd = fresh(join(base, "cwd"));
  const prompt = "In ONE response, issue three Bash tool calls in parallel: `echo a > a.txt`, `echo b > b.txt`, `echo c > c.txt`. Do not run them one at a time. If any call is not run, follow the instructions in its result.";
  const a = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--policy", "defer-one:Bash", "--prompt", prompt], { label: "3m-defer" });
  const sid = init(a)?.session_id;
  const toolUses = sdk(a, "assistant").flatMap((m) => m.content.filter((c: any) => c.tool_use));
  const phaseA = { sessionId: sid, result: result(a), toolUsesEmitted: toolUses.length, hookDecisions: a.events.filter((e) => e.kind === "hook.pre").map((e) => e.data), filesAfterDefer: readdirSync(cwd).sort() };
  rmSync(join(state, "claude-config", "projects"), { recursive: true, force: true });
  const dumpEntries = () => spawnSync(PROBE, ["dump", "--state", state, "--session", sid], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes('"kind":"entry"')).map((l) => JSON.parse(l.slice(3)).data);
  const deniedInStore = dumpEntries().filter((e: any) => e.type === "user" && /Not run: another tool call/.test(JSON.stringify(e.message?.content))).length;
  const resumeArgs = ["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--resume", sid, "--policy", "answer", "--answer", JSON.stringify({ decision: "allow" })];
  let b = await runProbe([...resumeArgs, "--empty-stream"], { label: "3m-resume-empty", timeoutMs: 90_000 });
  let resumeMode = "empty-stream";
  if (!result(b)) { b = await runProbe([...resumeArgs, "--prompt", "continue"], { label: "3m-resume-prompt" }); resumeMode = "prompt:continue"; }
  const files = readdirSync(cwd).sort();
  const out = {
    phaseA, deniedSiblingResultsInStore: deniedInStore, resumeMode,
    toolCallsOnResume: b.events.filter((e) => e.kind === "tool.call").map((e) => e.data.tool_input?.command),
    filesAfterResume: files, result: result(b), cost: cost(a, b),
  };
  const pass = phaseA.result?.stop_reason === "tool_deferred" && phaseA.filesAfterDefer.length === 0 && ["a.txt", "b.txt", "c.txt"].every((f) => files.includes(f));
  save("item3m", { pass, ...out });
  console.log(`ITEM 3m (F3 mitigation): ${pass ? "PASS" : "FAIL"}`);
}

// ───────────────────────────── item 4 ─────────────────────────────
async function item4() {
  const base = fresh(join(WORK, "item4"));
  const proxyDir = (n: string) => join(base, "proxy", n);
  const proxies: Array<ReturnType<typeof spawn>> = [];
  const startProxy = async (port: number, dir: string) => {
    const upstream = MOCK ? { HOMERUN_PROXY_UPSTREAM: mockUrl(`4-${port}`) } : {};
    const p = spawn(process.execPath, ["run", join(ROOT, "spikes/sdk/src/proxy.ts"), String(port), dir], { stdio: "inherit", env: { ...process.env, ...upstream } });
    proxies.push(p);
    await sleep(800);
    return `http://127.0.0.1:${port}`;
  };
  const out: any = {};
  try {
    for (const target of ["probe", "claude"] as const) {
      const state = fresh(join(base, `${target}-state`)), cwd = fresh(join(base, `${target}-cwd`));
      const marker = join(cwd, "side-effect.log");
      const proxy = await startProxy(target === "probe" ? 8781 : 8782, proxyDir(`${target}-run`));
      const r = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--proxy", proxy, "--prompt", `Run exactly this Bash command once and nothing else: \`sleep 15 && echo ran >> ${marker}\``], {
        label: `4-${target}-run`, killWhen: (e) => e.kind === "tool.call", killDelayMs: 3000, killTarget: target,
      });
      await sleep(1500);
      const survivors = findProcs(/sleep 15/);
      await sleep(15_000);
      const sid = init(r)?.session_id;
      const dump = spawnSync(PROBE, ["dump", "--state", state, "--session", sid], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes('"kind":"entry"')).map((l) => JSON.parse(l.slice(3)).data);
      const amb = spawnSync(PROBE, ["ambiguous", "--state", state], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("EV ")).map((l) => JSON.parse(l.slice(3)).data)[0];
      const tail = dump.slice(-4).map((e: any) => ({ type: e.type, uuid: e.uuid, parentUuid: e.parentUuid, content: JSON.stringify(e.message?.content ?? e.content ?? null).slice(0, 300) }));
      const toolUseEntry = dump.findLast((e: any) => e.type === "assistant" && JSON.stringify(e.message?.content).includes("tool_use"));
      const hasResult = dump.some((e: any) => e.type === "user" && JSON.stringify(e.message?.content).includes("tool_result"));
      out[target] = {
        killed: target, probeExit: { code: r.code, signal: r.signal }, probeErrors: r.events.filter((e) => e.kind === "error").map((e) => e.data.message.slice(0, 400)),
        treeAtKill: r.tree, sleepSurvivedKill: survivors, sideEffectRuns: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0,
        storeEntries: dump.length, storeTail: tail, danglingToolUseInStore: !!toolUseEntry && !hasResult, ambiguousDetected: amb,
        localLeftovers: ls(join(state, "claude-config")),
      };
      if (target !== "probe") continue;
      // ── resume strategies, each from a copy of the killed state ──
      const toolUse = amb?.[0];
      const decision = `The user was asked about the interrupted command \`${toolUse?.tool_input?.command}\` and confirms it DID complete (its side effect happened). Do not run it again.`;
      const copyState = (n: string) => { const d = join(base, `resume-${n}`); rmSync(d, { recursive: true, force: true }); cpSync(state, d, { recursive: true }); rmSync(join(d, "claude-config", "projects"), { recursive: true, force: true }); return d; };
      // With the pair now well-formed there may be nothing to continue; fall back to a nudge.
      const resumeInjected = async (d: string, px: string, label: string) => {
        const r1 = await runProbe(["turn", "--state", d, "--cwd", cwd, "--tools", "Bash", "--proxy", px, "--resume", sid, "--empty-stream"], { label: `${label}-empty`, timeoutMs: 60_000 });
        if (result(r1)) return Object.assign(r1, { resumeMode: "empty-stream" });
        const r2 = await runProbe(["turn", "--state", d, "--cwd", cwd, "--tools", "Bash", "--proxy", px, "--resume", sid, "--prompt", "continue"], { label: `${label}-prompt` });
        return Object.assign(r2, { resumeMode: "prompt:continue", emptyStreamAttempt: { code: r1.code, signal: r1.signal } });
      };
      const strategies: Record<string, (d: string, px: string) => Promise<ProbeResult>> = {
        // (0) naive: resume with "continue" — what does the SDK do with the dangling tool_use?
        naive: (d, px) => runProbe(["turn", "--state", d, "--cwd", cwd, "--tools", "Bash", "--proxy", px, "--resume", sid, "--prompt", "continue"], { label: "4-naive" }),
        // (a) decision as the next user message
        message: (d, px) => runProbe(["turn", "--state", d, "--cwd", cwd, "--tools", "Bash", "--proxy", px, "--resume", sid, "--prompt", `[Homerun recovery] ${decision} Reply with exactly: ACK-DID-HAPPEN`], { label: "4-message" }),
        // (b) inject the decision as the tool_result of the dangling call, then resume with no new prompt
        "inject-did": (d, px) => {
          spawnSync(PROBE, ["inject", "--state", d, "--session", sid, "--tool-use-id", toolUse?.tool_use_id, "--text", `[Homerun recovery] Homerun crashed while this command was running, so its result was lost. The user confirms it DID complete (its side effect happened). Do not run it again.`], { encoding: "utf8" });
          return resumeInjected(d, px, "4-inject-did");
        },
        "inject-did-not": (d, px) => {
          spawnSync(PROBE, ["inject", "--state", d, "--session", sid, "--tool-use-id", toolUse?.tool_use_id, "--text", `[Homerun recovery] Homerun crashed while this command was running and it was interrupted. The user confirms it did NOT happen; run it again.`], { encoding: "utf8" });
          return resumeInjected(d, px, "4-inject-did-not");
        },
        // (c) truncate at the entry before the dangling tool_use, then tell the model
        truncate: (d, px) => runProbe(["turn", "--state", d, "--cwd", cwd, "--tools", "Bash", "--proxy", px, "--resume", sid, "--resume-at", toolUseEntry?.parentUuid ?? "", "--prompt", `[Homerun recovery] You previously started running \`${toolUse?.tool_input?.command}\` but Homerun crashed mid-call. The user confirms it DID complete. Do not run it again. Reply with exactly: ACK-DID-HAPPEN`], { label: "4-truncate" }),
      };
      out.resume = {};
      let port = 8790;
      for (const [name, fn] of Object.entries(strategies)) {
        const before = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
        const d = copyState(name);
        const px = await startProxy(port++, proxyDir(`resume-${name}`));
        const rr = await fn(d, px);
        await sleep(16_000); // let any re-executed sleep finish
        const after = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
        const reqs = ls(proxyDir(`resume-${name}`)).sort();
        const firstReq = reqs.find((f) => f.includes("messages"));
        let modelSaw: unknown = null;
        if (firstReq) {
          const body = JSON.parse(readFileSync(join(proxyDir(`resume-${name}`), firstReq), "utf8")).body;
          modelSaw = (body.messages ?? []).slice(-3).map((m: any) => ({ role: m.role, content: (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).map((c: any) => ({ type: c.type, id: c.id ?? c.tool_use_id, text: (c.text ?? (typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? c.input ?? ""))).slice(0, 400) })) }));
        }
        out.resume[name] = {
          resumeMode: (rr as any).resumeMode, emptyStreamAttempt: (rr as any).emptyStreamAttempt, result: result(rr), toolCallsOnResume: rr.events.filter((e) => e.kind === "tool.call").map((e) => e.data.tool_input), sideEffectRunsAdded: after - before,
          lastMessagesSentToModel: modelSaw, proxyFiles: reqs, errors: rr.events.filter((e) => e.kind === "error").map((e) => e.data.message.slice(0, 500)), stderrTail: rr.stderr.slice(-600),
        };
      }
    }
  } finally {
    for (const p of proxies) p.kill("SIGTERM");
  }
  save("item4", out);
  console.log("ITEM 4: evidence written (judge manually; see results/item4.json)");
}

// ───────────────────────────── item 5 ─────────────────────────────
async function item5() {
  const base = fresh(join(WORK, "item5"));
  const state = fresh(join(base, "state")), cwd = fresh(join(base, "cwd"));
  const r = await runProbe(["turn", "--state", state, "--cwd", cwd, "--tools", "Bash", "--stream",
    "--prompt", "Run the Bash command `sleep 8 && echo step1`. When it finishes, follow any newer instruction from me; if there is none, reply NO-STEER.",
    "--steer", "Change of plan: once the current command finishes, run `echo STEERED` with Bash, then reply with the single word PINEAPPLE."], { label: "5-steer" });
  const idx = (pred: (e: Ev) => boolean) => r.events.findIndex(pred);
  const firstToolResult = idx((e) => e.kind === "tool.result");
  const steerAt = idx((e) => e.kind === "steer.push");
  const steeredCall = idx((e) => e.kind === "tool.call" && /STEERED/.test(JSON.stringify(e.data.tool_input)));
  const results = sdk(r, "result");
  const firstResultIdx = idx((e) => e.kind === "sdk" && e.data.type === "result");
  const out = {
    steerPushedWhileToolRunning: steerAt > -1 && steerAt < firstToolResult,
    steeredToolCallBeforeFirstResult: steeredCall > -1 && steeredCall < firstResultIdx,
    resultCount: results.length, results, finalText: results.at(-1)?.result,
    timeline: r.events.filter((e) => ["tool.call", "tool.result", "steer.push"].includes(e.kind) || (e.kind === "sdk" && ["assistant", "user", "result"].includes(e.data.type))).map((e) => ({ t: e.t, kind: e.kind, d: JSON.stringify(e.data).slice(0, 200) })),
    cost: cost(r),
  };
  const pass = out.steerPushedWhileToolRunning && out.steeredToolCallBeforeFirstResult && /PINEAPPLE/.test(JSON.stringify(results));
  save("item5", { pass, ...out });
  console.log(`ITEM 5: ${pass ? "PASS" : "FAIL"}`);
}

ensureBinary();
const which = process.argv[2] ?? "all";
const table: Record<string, () => Promise<void>> = { "1": item1, "2": item2, "3a": item3a, "3b": () => item3b(process.argv[3] ?? "3b"), "3m": item3m, "4": item4, "5": item5 };
if (which === "all") { for (const k of ["1", "2", "3a", "3b", "4", "5"]) await table[k](); }
else await table[which]();
mockProc?.kill("SIGTERM");
process.exit(0);
