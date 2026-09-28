/**
 * Milestone 0 SDK probe. Compiled with `bun build --compile` so every item is
 * exercised from a Bun single-file executable, exactly like homerund (§16.1 item 1).
 *
 *   probe turn    --state DIR --cwd DIR --prompt TEXT [--resume ID] [--policy P] [--steer TEXT] ...
 *   probe dump    --state DIR [--session ID]
 *   probe inject  --state DIR --session ID --tool-use-id ID --text TEXT
 *   probe ambiguous --state DIR --thread ID
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { startRun, InputQueue, PROJECT_DIR_NAME } from "../../homerund-m0/src/agent/run";
import { emit, openState, recordingHooks, summarize, type Policy } from "./common";

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    cwd: { type: "string" },
    prompt: { type: "string" },
    resume: { type: "string" },
    "resume-at": { type: "string" },
    policy: { type: "string", default: "allow" },
    answer: { type: "string" },
    steer: { type: "string" },
    stream: { type: "boolean", default: false },
    "empty-stream": { type: "boolean", default: false },
    tools: { type: "string" },
    thread: { type: "string", default: "t1" },
    session: { type: "string" },
    "tool-use-id": { type: "string" },
    text: { type: "string" },
    "no-isolation": { type: "boolean", default: false },
    proxy: { type: "string" },
    budget: { type: "string" },
    model: { type: "string" },
  },
});

const cmd = positionals[0];
if (!a.state) throw new Error("--state required");
const { store, log } = openState(a.state);

function policyFrom(spec: string): Policy {
  // allow | deny | defer:<Tool> | answer  (answer: allow the deferred call, with --answer JSON as updatedInput overrides)
  if (spec === "allow") return async () => "allow";
  if (spec === "deny") return async () => ({ deny: "denied by probe" });
  if (spec.startsWith("defer:")) {
    const tools = spec.slice(6).split(",");
    return async (name) => (tools.includes(name) || tools.includes("*") ? "defer" : "allow");
  }
  if (spec.startsWith("defer-one:")) {
    // F3 mitigation: defer the first gated call of a batch; deny its siblings so they get a
    // real tool_result (and stay in the transcript) instead of being silently dropped.
    const tools = spec.slice(10).split(",");
    let deferred: string | undefined;
    return async (name, _input, id) => {
      if (!(tools.includes(name) || tools.includes("*"))) return "allow";
      if (deferred === undefined || deferred === id) { deferred = id; return "defer"; }
      return { deny: "Not run: another tool call in this batch is waiting for the user's approval. Re-issue this exact call, on its own, after that approval." };
    };
  }
  if (spec === "answer") {
    const ans = JSON.parse(a.answer ?? "{}");
    return async (name, input) => {
      if (ans.decision === "deny") return { deny: ans.message ?? "User denied" };
      if (name === "AskUserQuestion") {
        const answers: Record<string, string> = {};
        for (const q of input.questions ?? []) {
          const hit = (q.options ?? []).find((o: any) => new RegExp(ans.choose ?? ".", "i").test(o.label));
          answers[q.question] = hit?.label ?? ans.choose;
        }
        emit("answer", answers);
        return { allow: { ...input, answers } };
      }
      return "allow";
    };
  }
  throw new Error(`unknown policy ${spec}`);
}

async function turn() {
  const runId = randomUUID();
  const useStream = a.stream || !!a.steer || a["empty-stream"];
  const queue = new InputQueue();
  if (useStream && !a["empty-stream"]) queue.push(a.prompt ?? "");
  let steered = false;

  const basePolicy = policyFrom(a.policy!);
  const policy: Policy = async (name, input, id) => {
    const d = await basePolicy(name, input, id);
    if (d === "defer") {
      log.append(a.thread!, runId, "input.requested", { tool_use_id: id, tool_name: name, tool_input: input });
      openState(a.state!).db
        .query("INSERT OR REPLACE INTO input_requests (request_id, run_id, kind, tool_call_id, prompt, state, requested_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, runId, name === "AskUserQuestion" ? "question" : "approval", id, JSON.stringify({ tool: name, input }), Date.now());
    }
    if (a.steer && !steered && d !== "defer") {
      steered = true;
      setTimeout(() => {
        emit("steer.push", { text: a.steer });
        queue.push(a.steer!);
      }, 500);
    }
    return d;
  };

  // Spike-only: extra claude env as JSON, e.g. {"CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY":"1"}.
  const extraEnv: Record<string, string> = JSON.parse(process.env.HOMERUN_PROBE_EXTRA_ENV ?? "{}");
  if (a.proxy) extraEnv.ANTHROPIC_BASE_URL = a.proxy;

  const h = startRun({
    prompt: useStream ? queue : (a.prompt ?? ""),
    cwd: a.cwd ?? process.cwd(),
    sessionStore: store,
    resume: a.resume,
    resumeSessionAt: a["resume-at"],
    tools: a.tools ? a.tools.split(",").filter(Boolean) : undefined,
    hooks: recordingHooks(log, a.thread!, runId, policy),
    // On resume of a deferred call the CLI sometimes asks canUseTool without firing PreToolUse
    // first (observed ~1 in 5 runs), so the pending decision must be applied on both paths.
    canUseTool: async (name, input, opts) => {
      const d = a.policy === "answer" ? await basePolicy(name, input, (opts as any)?.toolUseID ?? "") : "allow";
      emit("canUseTool", { name, toolUseID: (opts as any)?.toolUseID, applied: typeof d === "object" ? Object.keys(d)[0] : d });
      if (d && typeof d === "object" && "deny" in d) return { behavior: "deny", message: d.deny };
      if (d && typeof d === "object" && "allow" in d) return { behavior: "allow", updatedInput: d.allow };
      return { behavior: "allow", updatedInput: input };
    },
    dataRoot: a.state,
    extraEnv,
    unsafeNoIsolation: a["no-isolation"],
    maxBudgetUsd: a.budget ? Number(a.budget) : undefined,
    model: a.model,
    stderr: (s) => process.stderr.write(`[claude] ${s}`),
  });
  emit("run.start", { runId, pid: process.pid, resume: a.resume ?? null });

  let sessionId: string | undefined;
  for await (const m of h.messages) {
    if ((m as any).session_id) sessionId = (m as any).session_id;
    const s = summarize(m);
    if (s) emit("sdk", s);
    if (m.type === "result") {
      log.append(a.thread!, runId, "run.end", { subtype: m.subtype, stop_reason: (m as any).stop_reason, cost: (m as any).total_cost_usd });
      if (useStream) queue.close();
    }
  }
  emit("run.exit", { runId, sessionId, appendCalls: store.appendCalls, storeKeys: store.keys() });
}

async function main() {
  switch (cmd) {
    case "turn":
      return turn();
    case "dump": {
      const keys = store.keys();
      emit("keys", keys);
      const sid = a.session ?? keys[0]?.session_id;
      if (sid) {
        const entries = (await store.load({ projectKey: keys.find((k) => k.session_id === sid)?.project_key ?? PROJECT_DIR_NAME, sessionId: sid })) ?? [];
        for (const e of entries) emit("entry", e);
      }
      return;
    }
    case "inject": {
      // Write the user's decision as the tool_result of the dangling tool_use, shaped like the
      // synthetic "interrupted" entry claude itself writes, so resume sees a well-formed pair.
      const sid = a.session!;
      const key = { projectKey: store.keys().find((k) => k.session_id === sid)?.project_key ?? PROJECT_DIR_NAME, sessionId: sid };
      const entries: any[] = (await store.load(key)) ?? [];
      const toolUse = entries.findLast((e) => e.type === "assistant" && (e.message?.content ?? []).some((c: any) => c.type === "tool_use" && c.id === a["tool-use-id"]));
      if (!toolUse) throw new Error(`tool_use ${a["tool-use-id"]} not found in ${sid}`);
      const answered = entries.some((e) => e.type === "user" && (e.message?.content ?? []).some((c: any) => c.type === "tool_result" && c.tool_use_id === a["tool-use-id"]));
      if (answered) throw new Error("tool_use already has a tool_result");
      const entry = {
        parentUuid: toolUse.uuid, isSidechain: false, type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: a["tool-use-id"], content: a.text, is_error: true }] },
        uuid: randomUUID(), timestamp: new Date().toISOString(), toolUseResult: a.text, sourceToolAssistantUUID: toolUse.uuid,
        userType: "external", entrypoint: "sdk-ts", cwd: toolUse.cwd, sessionId: sid, version: toolUse.version,
      };
      await store.rawAppend(key, entry as any);
      return emit("injected", { uuid: entry.uuid, parentUuid: entry.parentUuid });
    }
    case "ambiguous":
      return emit("ambiguous", log.ambiguousToolCalls(a.thread!));
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    emit("error", { message: String(e?.stack ?? e) });
    process.exit(1);
  },
);
