import type { Env } from "../src/env";
import { NotConnectedError, RpcCallError } from "../src/errors";
import type { RuntimeStatus, Transport, TransportEvent } from "../src/transport";

export const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f01";
export const OTHER_THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f02";
export const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a01";
export const RUN2 = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a02";
export const DEVICE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a02";
export const OTHER_DEVICE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a03";
export const T0 = 1_767_225_600_000;

let n = 0;
export const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;

type Any = Record<string, unknown>;

/** A persisted event, as the runtime would send it. */
export function ev(seq: number, type: string, payload: Any, run_id: string | null = RUN, thread_id = THREAD): any {
  return { thread_id, seq, run_id, ts: T0 + seq * 1000, type, payload };
}

export function live(after_seq: number, type: string, payload: Any, run_id: string | null = RUN, thread_id = THREAD): any {
  return { thread_id, after_seq, run_id, ts: T0 + after_seq * 1000 + 500, type, payload };
}

export const origin = { device_id: DEVICE, surface: "desktop" };

export const userMsg = (seq: number, text: string, disposition = "started_run", run_id: string | null = RUN, id = uuid()) =>
  ev(seq, "user.message", { client_msg_id: id, text, origin, disposition }, run_id);
export const started = (seq: number, run_id = RUN, trigger = "message") =>
  ev(seq, "run.started", { trigger, authority: "full", origin: trigger === "schedule" ? null : origin, task_id: null, task_version: null, scheduled_for: null, attempt: 0 }, run_id);
export const final = (seq: number, message_id: string, text: string, run_id = RUN) => ev(seq, "message.final", { message_id, role: "assistant", text }, run_id);
export const delta = (after: number, message_id: string, index: number, text: string, run_id = RUN) =>
  live(after, "message.delta", { message_id, index, text }, run_id);
export const ended = (seq: number, run_id = RUN, state = "succeeded") =>
  ev(seq, "run.end", { state, outcome: null, error: state === "failed" ? { code: "x", message: "boom" } : null, authority: "full", cost_usd: 0.01 }, run_id);
export const resumed = (seq: number, run_id = RUN, reason = "input_answered") => ev(seq, "run.resumed", { reason }, run_id);
export const toolCall = (seq: number, id: string, tool = "Bash", input: unknown = { command: "git status" }, policy = "allowed", run_id = RUN) =>
  ev(seq, "tool.call", { tool_call_id: id, tool, class: tool === "Bash" ? "destructive" : "read", input: { kind: "inline", value: input }, policy }, run_id);
export const toolResult = (seq: number, id: string, status = "ok", run_id = RUN) =>
  ev(seq, "tool.result", { tool_call_id: id, status, output: { kind: "inline", value: "ok" } }, run_id);

export const approvalPrompt = (tool_call_id: string, over: Any = {}) => ({
  type: "approval",
  tool: "Bash",
  tool_call_id,
  class: "destructive",
  input: { kind: "inline", value: { command: "npm test -- --watch=false" } },
  reason: "not_allowlisted",
  offer_always: true,
  suggested_grant: { tool: "Bash", pattern: "npm test *", class: "read" },
  ...over,
});

export const questionPrompt = (tool_call_id?: string, over: Any = {}) => ({
  type: "question",
  ...(tool_call_id ? { tool_call_id } : {}),
  questions: [
    { question: "Which branch?", header: "Branch", options: [{ label: "main" }, { label: "dev" }], multi_select: false, allow_freeform: true },
    { question: "Which checks?", options: [{ label: "lint" }, { label: "test" }, { label: "build" }], multi_select: true, allow_freeform: false },
  ],
  ...over,
});

export const requested = (seq: number, request_id: string, prompt: Any, run_id = RUN) =>
  ev(seq, "input.requested", { request_id, prompt, required_authority: "full", expires_at: null }, run_id);
export const resolved = (seq: number, request_id: string, response: Any | null, run_id = RUN, by = DEVICE) =>
  ev(
    seq,
    "input.resolved",
    response
      ? { request_id, state: "answered", response, answered_by: by, surface: "desktop", via: "app" }
      : { request_id, state: "expired", response: null, answered_by: null, surface: null, via: null },
    run_id,
  );

// ---------------------------------------------------------------- a fake transport

type Handler = (params: any) => unknown;

export class FakeTransport implements Transport {
  calls: { method: string; params: any }[] = [];
  handlers: Record<string, Handler> = {};
  private listeners = new Set<(e: TransportEvent) => void>();
  private current: RuntimeStatus = { state: "starting" };
  private conn = 0;

  call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.current.state !== "ready") return Promise.reject(new NotConnectedError());
    const h = this.handlers[method];
    if (!h) return Promise.reject(new RpcCallError(-32601, `no handler for ${method}`));
    try {
      return Promise.resolve(h(params));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  listen(l: (e: TransportEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  status(): RuntimeStatus {
    return this.current;
  }

  setStatus(s: RuntimeStatus): void {
    this.current = s;
    for (const l of this.listeners) l({ type: "status", status: s });
  }

  ready(): void {
    this.setStatus({ state: "ready", connection: ++this.conn, device_id: DEVICE, runtime_version: "0.1.0", protocol: 1 });
  }

  notify(method: string, params: unknown): void {
    for (const l of this.listeners) l({ type: "notification", method, params });
  }

  called(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

/** A clock and timers the test advances by hand. */
export class FakeEnv implements Env {
  t = T0;
  private timers: { at: number; cb: () => void; id: number }[] = [];
  private nextId = 0;
  ids: string[] = [];
  now = () => this.t;
  setTimeout = (cb: () => void, ms: number) => {
    const id = ++this.nextId;
    this.timers.push({ at: this.t + ms, cb, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  newId = () => {
    const id = uuid();
    this.ids.push(id);
    return id;
  };
  advance(ms: number): void {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.timers = this.timers.filter((x) => x !== due);
      due.cb();
    }
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
