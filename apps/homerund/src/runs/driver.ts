import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ToolName, type Origin, type RunError, type SessionSpec, type Surface, type TerminalRunState } from "@homerun/core";
import type { EngineEvent, EngineExit, EngineRun, GateDecision, ToolCallRequest, ToolOutcome, UserInput } from "../agent/engine";
import { claudeEnv } from "../agent/claude/env";
import { RunSetupError } from "../agent/claude/mcp";
import { decide, type PolicySpec } from "../agent/policy";
import { RUNTIME_VERSION } from "../config";
import { log } from "../log";
import { toContent } from "../store/content";
import { appendEvent, findToolEvent, publishLive } from "../store/events";
import { getRunRow, lastInputRequestAt, lastSessionRun, markInputsConsumed, pendingInputs, setRunState, updateRun, type RunRow } from "../store/rows";
import { PROJECT_KEY, transcriptHasInput } from "../store/session-store";
import { hasConversation } from "../store/transcript";
import { now, type RunContext } from "./context";
import { finishRun } from "./finish";
import { recoverRun } from "./recovery";
import { prepareResume } from "./resume";
import { specForRun } from "./specs";

/** Deltas are coalesced into one live event per message every ~75 ms (§9.8). */
export const DELTA_COALESCE_MS = 75;
/** After interrupt, how long `claude` gets to exit before its group is killed (§5.7). */
export const STOP_GRACE_MS = 2000;
const MAX_DELTA_CHARS = 100_000;

export const STOPPED_REASON = "The run was stopped, so this call was not run.";
export const NO_RESULT = "no result reported";

type Phase = "idle" | "running" | "stopping" | "ending" | "shutdown" | "done";

interface DeltaBuf {
  text: string;
  index: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Drives one run from `pending` to a terminal state (or back to `pending`/`waiting_input` after
 * the agent dies), writing every event (plan §3.3). One driver per active run; the scheduler
 * holds a slot for it until `done` resolves, which is after the process group is reaped, so a
 * follow-up on the same thread never shares a session with a still-exiting `claude`.
 */
export class RunDriver {
  readonly runId: string;
  readonly threadId: string;
  readonly pool: RunRow["pool"];
  readonly done: Promise<void>;

  private phase: Phase = "idle";
  private engine: EngineRun | null = null;
  private spec!: SessionSpec;
  private policySpec!: PolicySpec;
  private pushed = new Set<string>();
  private noteUuid: string | null = null;
  private decisions = new Map<string, Promise<GateDecision>>();
  private inFlight = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private deltas = new Map<string, DeltaBuf>();
  private sawSession = false;
  private costBefore = 0;
  private costBaseline = 0;
  private resolveDone!: () => void;
  private warnedAutoApprove = false;

  constructor(
    private ctx: RunContext,
    row: RunRow,
  ) {
    this.runId = row.run_id;
    this.threadId = row.thread_id;
    this.pool = row.pool;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get state(): Phase {
    return this.phase;
  }

  get pid(): number | null {
    return this.engine?.pid ?? null;
  }

  private get store() {
    return this.ctx.store;
  }

  private row(): RunRow {
    return getRunRow(this.store, this.runId)!;
  }

  // ------------------------------------------------------------------ start

  /** Synchronous up to `engine.start`, so no message or stop can slip in half-way. */
  start(): void {
    if (this.phase !== "idle") return;
    const row = this.row();
    if (row.state !== "pending") {
      this.phase = "done";
      this.resolveDone();
      return;
    }
    const t = now(this.ctx);
    const first = row.started_at === null;
    this.store.tx(() => {
      setRunState(this.store, this.runId, "running", first ? { started_at: t } : {});
      if (first) {
        appendEvent(this.store, this.threadId, this.runId, "run.started", {
          trigger: row.trigger as "message",
          authority: row.authority as "full",
          origin: row.origin_device ? { device_id: row.origin_device, surface: (row.origin_surface ?? "desktop") as Surface } : null,
          task_id: row.task_id,
          task_version: row.task_version,
          scheduled_for: row.scheduled_for,
          attempt: row.attempt,
        }, t);
      }
    });
    this.phase = "running";
    publishLive(this.store, this.threadId, this.runId, "run.status", { state: "running", detail: "running" });

    try {
      this.launch(row);
    } catch (e) {
      const err: RunError =
        e instanceof RunSetupError ? { code: e.code, message: e.message } : { code: "internal_error", message: e instanceof Error ? e.message : String(e) };
      if (!(e instanceof RunSetupError)) log.error("run failed to start", { run_id: this.runId, error: err.message });
      this.end("failed", err);
    }
  }

  private launch(row: RunRow): void {
    const cfg = this.ctx.config;
    this.spec = specForRun(this.store, cfg, row);
    if (row.monitor_phase && this.spec.budget.max_run_usd <= (row.cost_usd ?? 0)) {
      throw new RunSetupError("error_max_budget_usd", "The check used this run's whole budget, so the act step could not start.");
    }
    const spec = this.spec;
    this.policySpec = {
      builtin: spec.tools.builtin,
      mcpServers: spec.tools.mcp_servers.map((s) => s.id),
      bashPatterns: spec.policy.bash_patterns,
    };
    if (spec.tools.homerun.length) throw new RunSetupError("unsupported_tool", "Homerun's own tools arrive in a later version of Homerun.");
    const mcpServers = this.ctx.mcp.resolveAll(spec.tools.mcp_servers);
    const apiKey = this.ctx.secrets.get("anthropic_api_key");
    if (!apiKey) throw new RunSetupError("no_api_key", "No Anthropic API key has been set.");

    const cwd = spec.policy.roots[0] ? expandHome(spec.policy.roots[0], cfg.userHome) : join(cfg.workspacesDir, this.threadId);
    if (!spec.policy.roots[0]) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    else if (!existsSync(cwd)) throw new RunSetupError("root_missing", `The folder ${spec.policy.roots[0]} does not exist.`);
    // Only once the run can start: a resume that fails here never delivered its held messages,
    // and clients tell that from the missing `run.resumed` (`HeldMessages`).
    if (row.started_at !== null) {
      appendEvent(this.store, this.threadId, this.runId, "run.resumed", { reason: (row.resume_reason ?? "runtime_restart") as "runtime_restart" }, now(this.ctx));
    }

    // Resume this run's own session after a restart, or the thread's last session for a follow-up.
    // Only a session with a stored conversation: after a crash early in a session's first turn
    // nothing may be stored yet, and `claude` cannot resume that. The run then continues from the
    // thread's previous session, or a new one, and gets its messages again. A monitor's act step
    // never continues the thread's previous session (§8.3).
    const usable = (sid: string) => hasConversation(this.store, sid);
    const own = row.sdk_session_id !== null && usable(row.sdk_session_id);
    const prev = own || row.monitor_phase ? null : lastSessionRun(this.store, this.threadId, usable);
    const resume = own ? row.sdk_session_id : (prev?.sdk_session_id ?? null);
    this.costBefore = row.cost_usd ?? 0;
    this.costBaseline = own ? (row.sdk_cost_total ?? 0) : (prev?.sdk_cost_total ?? 0);
    updateRun(this.store, this.runId, { sdk_cost_baseline: this.costBaseline, ...(resume !== row.sdk_session_id ? { sdk_session_id: resume } : {}) });

    // Give every call the transcript left open the result Homerun recorded, or truncate before
    // it (§5.4), so the model does not see "interrupted" and run it again.
    const resumeAt = resume ? prepareResume(this.store, row, resume, now(this.ctx)).resumeAt : null;

    const inputs: UserInput[] = [];
    const delivered: string[] = [];
    const parkedAt = row.resume_reason === "ambiguity_resolved" ? lastInputRequestAt(this.store, this.runId) : null;
    let beforePark = 0;
    for (const i of pendingInputs(this.store, this.runId)) {
      if (own && transcriptHasInput(this.store.db, row.sdk_session_id!, i.uuid, i.text)) delivered.push(i.uuid);
      else {
        inputs.push({ uuid: i.uuid, text: i.text });
        if (parkedAt !== null && i.created_at < parkedAt) beforePark++;
      }
    }
    if (delivered.length) markInputsConsumed(this.store, delivered, now(this.ctx));
    if (row.resume_note) {
      this.noteUuid = randomUUID();
      // After a "Did this happen?" answer the note explains the injected results, so it comes
      // before messages that were held while the run waited, and after what the run was given
      // before it parked (sent again when its conversation was never stored).
      if (row.resume_reason === "ambiguity_resolved") inputs.splice(beforePark, 0, { uuid: this.noteUuid, text: row.resume_note });
      else inputs.push({ uuid: this.noteUuid, text: row.resume_note });
    }
    if (inputs.length === 0) {
      this.end("succeeded", null);
      return;
    }
    for (const i of inputs) this.pushed.add(i.uuid);

    const model = cfg.build === "development" && process.env.HOMERUN_FORCE_MODEL ? process.env.HOMERUN_FORCE_MODEL : spec.model.model;
    const fallback = cfg.build === "development" && process.env.HOMERUN_FORCE_MODEL ? null : (spec.model.fallback_model ?? null);

    this.engine = this.ctx.engine.start({
      runId: this.runId,
      cwd,
      appendSystemPrompt: spec.prompt,
      model,
      fallbackModel: fallback,
      // A monitor's check and act step share one run budget (§7.4).
      maxBudgetUsd: row.monitor_phase ? round6(spec.budget.max_run_usd - (row.cost_usd ?? 0)) : spec.budget.max_run_usd,
      builtinTools: spec.tools.builtin,
      mcpServers,
      resume,
      resumeAt,
      env: claudeEnv({
        apiKey,
        claudeConfigDir: cfg.claudeConfigDir,
        shellHome: cfg.shellHome,
        tmpDir: cfg.tmpDir,
        userHome: cfg.userHome,
        runtimeVersion: RUNTIME_VERSION,
        anthropicBaseUrl: cfg.anthropicBaseUrl,
        useShellEnvironment: spec.policy.use_shell_environment,
        userShell: process.env.SHELL,
      }),
      initialInputs: inputs,
      gate: { preTool: (c) => this.preTool(c), postTool: (o) => this.postTool(o) },
      sink: (e) => this.onEvent(e),
      onSpawn: (pid) => this.onSpawn(pid),
      stderr: (line) => log.debug("claude stderr", { run_id: this.runId, line: line.slice(0, 2000) }),
    });
    void this.engine.exited.then((ex) => this.onExit(ex));
  }

  private onSpawn(pid: number): void {
    // Recorded before any tool can run, so a crash leaves a group the next start can kill (§5.4).
    if (this.row().state !== "running") return;
    updateRun(this.store, this.runId, { claude_pid: pid, claude_boot: this.ctx.bootTime, claude_started_at: now(this.ctx) });
  }

  // ------------------------------------------------------------------ steering and stop

  /** A message for this run (§5.7): pushed into the running agent. The caller already stored it. */
  steer(input: UserInput): void {
    if (this.phase !== "running" || !this.engine) return;
    this.pushed.add(input.uuid);
    this.engine.push(input);
  }

  /** Stop at the next safe point: never mid-call (§5.7). */
  requestStop(by: Origin | null): void {
    if (this.phase !== "running") return;
    this.phase = "stopping";
    const t = now(this.ctx);
    this.store.tx(() => {
      updateRun(this.store, this.runId, { stop_requested_at: t, stop_by: by ? JSON.stringify(by) : null });
      appendEvent(this.store, this.threadId, this.runId, "run.cancelled", { by, reason: "user" }, t);
    });
    publishLive(this.store, this.threadId, this.runId, "run.status", { state: "running", detail: "stopping" });
    void this.stopSequence();
  }

  private async stopSequence(): Promise<void> {
    await this.whenNoCallInFlight();
    const eng = this.engine;
    if (eng) {
      await eng.interrupt();
      eng.closeInput();
      await Promise.race([eng.exited, Bun.sleep(STOP_GRACE_MS)]);
      eng.kill();
    }
    this.end("cancelled", null);
  }

  /**
   * Graceful runtime shutdown: no new tool calls, wait up to `graceMs` for calls in flight, then
   * kill the group and leave the run `running`, so the next start resumes it (§5.4).
   */
  async shutdown(graceMs: number): Promise<void> {
    if (this.phase === "running" || this.phase === "stopping") {
      this.phase = "shutdown";
      await Promise.race([this.whenNoCallInFlight(), Bun.sleep(graceMs)]);
      this.flushAllDeltas();
      if (this.engine) await this.engine.reap();
      this.finishDone();
      return;
    }
    await Promise.race([this.done, Bun.sleep(graceMs + 5000)]);
  }

  private whenNoCallInFlight(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  // ------------------------------------------------------------------ tool gate (§5.4)

  private preTool(call: ToolCallRequest): Promise<GateDecision> {
    let d = this.decisions.get(call.toolCallId);
    if (!d) {
      d = this.decideTool(call);
      this.decisions.set(call.toolCallId, d);
    }
    return d;
  }

  private async decideTool(call: ToolCallRequest): Promise<GateDecision> {
    // During shutdown nothing new starts. Holding the call (rather than denying it) means the
    // model never sees a denial for something the user didn't deny; the process is killed.
    if (this.phase === "shutdown") return new Promise<GateDecision>(() => {});
    if (!ToolName.safeParse(call.tool).success) {
      log.warn("tool with an invalid name denied", { run_id: this.runId, tool: call.tool.slice(0, 200) });
      return { allow: false, reason: `${call.tool} is not one of this task's tools.` };
    }
    const d = decide(this.policySpec, call.tool, call.input, { devAutoApprove: this.ctx.config.devAutoApprove });
    const stopping = this.phase !== "running";
    const allow = d.allow && !stopping;
    const reason = stopping ? STOPPED_REASON : (d.reason ?? "Not allowed.");
    if (d.allow && d.policy === "needs_approval" && !this.warnedAutoApprove) {
      this.warnedAutoApprove = true;
      log.warn("--dev-auto-approve: allowing a call that needs approval", { run_id: this.runId, tool: call.tool });
    }
    const t = now(this.ctx);
    const mcpServer = call.mcpServer ?? d.mcpServer;
    this.store.tx(() => {
      if (!findToolEvent(this.store, this.threadId, "tool.call", call.toolCallId)) {
        appendEvent(this.store, this.threadId, this.runId, "tool.call", {
          tool_call_id: call.toolCallId,
          tool: call.tool,
          class: d.toolClass,
          ...(mcpServer ? { mcp_server: mcpServer } : {}),
          input: toContent(this.store, call.input, t),
          policy: d.policy,
          ...(call.parentToolCallId ? { parent_tool_call_id: call.parentToolCallId } : {}),
        }, t);
      }
      if (!allow && !findToolEvent(this.store, this.threadId, "tool.result", call.toolCallId)) {
        appendEvent(this.store, this.threadId, this.runId, "tool.result", { tool_call_id: call.toolCallId, status: "denied", output: null, error: reason }, t);
      }
    });
    if (!allow) return { allow: false, reason };
    this.inFlight.add(call.toolCallId);
    return { allow: true };
  }

  private postTool(o: ToolOutcome): void {
    try {
      this.writeResult(o.toolCallId, o.ok ? "ok" : "error", o.ok ? o.output : null, o.ok ? undefined : o.interrupted ? `Interrupted. ${o.error ?? ""}`.trim() : (o.error ?? "error"), o.durationMs);
    } finally {
      this.callFinished(o.toolCallId);
    }
  }

  private callFinished(id: string): void {
    if (!this.inFlight.delete(id) || this.inFlight.size > 0) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private writeResult(id: string, status: "ok" | "error", output: unknown, error: string | undefined, durationMs?: number): void {
    const t = now(this.ctx);
    this.store.tx(() => {
      if (!findToolEvent(this.store, this.threadId, "tool.call", id)) return;
      if (findToolEvent(this.store, this.threadId, "tool.result", id)) return;
      appendEvent(this.store, this.threadId, this.runId, "tool.result", {
        tool_call_id: id,
        status,
        output: status === "ok" ? toContent(this.store, output, t) : null,
        ...(error !== undefined ? { error: error.slice(0, 10_000) } : {}),
        ...(durationMs !== undefined && Number.isFinite(durationMs) ? { duration_ms: Math.max(0, Math.round(durationMs)) } : {}),
      }, t);
    });
  }

  // ------------------------------------------------------------------ engine events

  private onEvent(e: EngineEvent): void {
    if (this.phase === "done") return;
    try {
      this.handle(e);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("run event handling failed", { run_id: this.runId, event: e.type, error: message });
      if (this.phase === "running") {
        this.engine?.kill();
        this.end("failed", { code: "internal_error", message: message.slice(0, 2000) });
      }
    }
  }

  private handle(e: EngineEvent): void {
    switch (e.type) {
      case "session": {
        this.sawSession = true;
        const violation = isolationViolation(this.spec, e);
        if (violation) {
          log.error("isolation violation", { run_id: this.runId, violation });
          this.engine?.kill();
          this.end("failed", { code: "isolation_violation", message: violation });
          return;
        }
        const unknown = e.tools.filter((t) => !this.expectedTool(t));
        if (unknown.length) log.warn("agent lists tools outside the spec; policy denies them", { run_id: this.runId, tools: unknown });
        for (const s of e.mcpServers) if (s.status !== "connected") log.warn("MCP server not connected", { run_id: this.runId, server: s.name, status: s.status });
        updateRun(this.store, this.runId, { sdk_session_id: e.sessionId });
        return;
      }
      case "delta":
        this.onDelta(e.messageId, e.text);
        return;
      case "message":
        this.flushDelta(e.messageId, true);
        appendEvent(this.store, this.threadId, this.runId, "message.final", {
          message_id: e.messageId,
          role: "assistant",
          text: e.text,
          ...(e.model ? { model: e.model } : {}),
          ...(e.parentToolCallId ? { parent_tool_call_id: e.parentToolCallId } : {}),
        }, now(this.ctx));
        return;
      case "tool_result_seen":
        // Safety net: every call gets a result even if a Post hook was missed.
        this.writeResult(e.toolCallId, e.isError ? "error" : "ok", e.isError ? null : e.content, e.isError ? contentText(e.content) : undefined);
        this.callFinished(e.toolCallId);
        return;
      case "status":
        publishLive(this.store, this.threadId, this.runId, "run.status", {
          state: "running",
          detail: e.detail,
          ...(e.retryAt !== undefined ? { retry_at: Math.max(0, Math.round(e.retryAt)) } : {}),
        });
        return;
      case "result":
        this.onResult(e);
        return;
    }
  }

  private expectedTool(t: string): boolean {
    if ((this.spec.tools.builtin as readonly string[]).includes(t)) return true;
    return this.spec.tools.mcp_servers.some((s) => t.startsWith(`mcp__${s.id}__`));
  }

  private onResult(r: Extract<EngineEvent, { type: "result" }>): void {
    const fields: Parameters<typeof updateRun>[2] = {};
    if (r.totalCostUsd !== null) {
      const seg = r.totalCostUsd >= this.costBaseline ? r.totalCostUsd - this.costBaseline : r.totalCostUsd;
      fields.sdk_cost_total = r.totalCostUsd;
      fields.cost_usd = round6(this.costBefore + seg);
    }
    // A pushed message is done only when a result names it; without names, a result with no
    // queued turns consumed everything pushed so far.
    const consumed = r.consumed ?? (r.queuedTurnCount ? [] : [...this.pushed]);
    const mine = consumed.filter((u) => this.pushed.has(u));
    for (const u of mine) this.pushed.delete(u);
    if (r.consumed && r.consumed.length > 0 && mine.length === 0 && !r.queuedTurnCount) {
      // The SDK named inputs we never sent (its own uuids): treat everything as consumed.
      this.pushed.clear();
    }
    if (this.noteUuid && !this.pushed.has(this.noteUuid)) {
      fields.resume_note = null;
      fields.resume_reason = null;
      fields.resume_at = null;
      this.noteUuid = null;
    }
    if (r.ok) fields.resume_count = 0;
    this.store.tx(() => {
      updateRun(this.store, this.runId, fields);
      markInputsConsumed(this.store, consumed, now(this.ctx));
    });
    if (this.phase !== "running") return;
    if (!r.ok) {
      this.end("failed", { code: r.subtype.slice(0, 100), message: (r.errors.join("; ") || r.subtype).slice(0, 10_000) });
    } else if (this.pushed.size === 0) {
      this.end("succeeded", null);
    }
  }

  private onExit(ex: EngineExit): void {
    if (this.phase !== "running") return;
    // The agent died on its own (§5.1, §5.4).
    this.phase = "ending";
    this.flushAllDeltas();
    log.warn("agent exited unexpectedly", { run_id: this.runId, code: ex.code, signal: ex.signal, error: ex.error });
    void (async () => {
      await this.engine?.reap();
      if (!this.sawSession) {
        this.phase = "running";
        this.end("failed", { code: "agent_start_failed", message: (ex.error ?? `The agent exited (${ex.signal ?? ex.code}) before it started.`).slice(0, 10_000) });
        return;
      }
      try {
        const out = recoverRun(this.store, this.runId, "agent_exited", now(this.ctx));
        if (out.kind === "waiting_input") publishLive(this.store, this.threadId, this.runId, "run.status", { state: "waiting_input", detail: "waiting_input" });
      } catch (err) {
        log.error("recovery after agent exit failed", { run_id: this.runId, error: err instanceof Error ? err.message : String(err) });
      }
      this.cleanupCache();
      this.finishDone();
    })();
  }

  // ------------------------------------------------------------------ ending

  private end(state: TerminalRunState, error: RunError | null): void {
    if (this.phase === "ending" || this.phase === "done") return;
    const wasShutdown = this.phase === "shutdown";
    this.phase = "ending";
    this.flushAllDeltas();
    const t = now(this.ctx);
    const pid = this.engine?.pid ?? null;
    if (!wasShutdown) {
      finishRun(this.store, this.runId, state, error, { now: t, reapPgid: pid, unresolved: NO_RESULT });
    }
    void this.reap();
  }

  private async reap(): Promise<void> {
    const eng = this.engine;
    if (eng) {
      eng.closeInput();
      await Promise.race([eng.exited, Bun.sleep(STOP_GRACE_MS)]);
      await eng.reap();
    }
    updateRun(this.store, this.runId, { reap_pgid: null });
    this.cleanupCache();
    this.finishDone();
  }

  /** The local JSONL is a disposable cache; SQLite has the transcript (F1). */
  private cleanupCache(): void {
    const sid = getRunRow(this.store, this.runId)?.sdk_session_id;
    if (!sid) return;
    const dir = join(this.ctx.config.claudeConfigDir, "projects", PROJECT_KEY);
    for (const p of [join(dir, `${sid}.jsonl`), join(dir, sid)]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private finishDone(): void {
    for (const b of this.deltas.values()) if (b.timer) clearTimeout(b.timer);
    this.deltas.clear();
    this.phase = "done";
    this.resolveDone();
  }

  // ------------------------------------------------------------------ deltas

  private onDelta(id: string, text: string): void {
    let b = this.deltas.get(id);
    if (!b) this.deltas.set(id, (b = { text: "", index: 0, timer: null }));
    b.text += text;
    if (b.text.length >= MAX_DELTA_CHARS) this.flushDelta(id, false);
    else if (!b.timer) b.timer = setTimeout(() => this.flushDelta(id, false), DELTA_COALESCE_MS);
  }

  private flushDelta(id: string, final: boolean): void {
    const b = this.deltas.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.timer = null;
    while (b.text.length > 0) {
      const chunk = b.text.slice(0, MAX_DELTA_CHARS);
      b.text = b.text.slice(chunk.length);
      publishLive(this.store, this.threadId, this.runId, "message.delta", { message_id: id, index: b.index++, text: chunk });
    }
    if (final) this.deltas.delete(id);
  }

  private flushAllDeltas(): void {
    for (const id of [...this.deltas.keys()]) this.flushDelta(id, true);
  }
}

/** The §5.3 defensive check on `system/init`: nothing beyond the spec may be loaded. */
export function isolationViolation(spec: SessionSpec, e: Extract<EngineEvent, { type: "session" }>): string | null {
  const servers = new Set(spec.tools.mcp_servers.map((s) => s.id));
  if (e.tools.includes("Skill")) return "the agent loaded the Skill tool";
  for (const t of e.tools) {
    const m = /^mcp__(.+?)__/.exec(t);
    if (m && ![...servers].some((s) => t.startsWith(`mcp__${s}__`))) return `the agent loaded MCP tool ${t} outside the spec`;
  }
  for (const s of e.mcpServers) if (!servers.has(s.name)) return `the agent connected MCP server ${s.name} outside the spec`;
  if (e.plugins.length) return `the agent loaded plugins: ${e.plugins.join(", ")}`;
  return null;
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home || homedir();
  if (p.startsWith("~/")) return join(home || homedir(), p.slice(2));
  return p;
}

function contentText(c: unknown): string {
  const s = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : JSON.stringify(c);
  return (s || "error").slice(0, 10_000);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
