import type { AgentEngine, EngineEvent, EngineExit, EngineRun, EngineStart, GateDecision, ToolCallRequest, ToolOutcome, UserInput } from "./engine";

/**
 * A scripted engine for unit tests: no `claude`, no network. A script drives one run the way
 * the SDK would, through the same gate and sink as the real engine.
 */
export interface FakeSession {
  readonly opts: EngineStart;
  readonly index: number;
  /** The next user input, or null once input is closed. */
  nextInput(): Promise<UserInput | null>;
  emit(e: EngineEvent): void;
  /** Ask the gate, then (if allowed) report the outcome, like PreToolUse → tool → PostToolUse. */
  tool(call: ToolCallRequest, run?: () => Promise<Omit<ToolOutcome, "toolCallId">>): Promise<GateDecision>;
  /** The standard end of a turn: a result consuming these inputs. */
  result(consumed: string[] | null, opts?: { ok?: boolean; subtype?: string; cost?: number; queued?: number }): void;
  readonly interrupted: boolean;
  readonly killed: Promise<void>;
}

export type FakeScript = (s: FakeSession) => Promise<void | EngineExit>;

/** Echo each input back as one message and end the turn. */
export const echoScript: FakeScript = async (s) => {
  for (let i = await s.nextInput(); i; i = await s.nextInput()) {
    s.emit({ type: "message", messageId: `msg-${i.uuid}`, text: `echo: ${i.text}` });
    s.result([i.uuid]);
  }
};

let fakePid = 90_000_000;

export class FakeEngine implements AgentEngine {
  readonly sessions: FakeSession[] = [];

  constructor(private script: FakeScript = echoScript) {}

  setScript(script: FakeScript): void {
    this.script = script;
  }

  start(o: EngineStart): EngineRun {
    const buf: UserInput[] = [...o.initialInputs];
    const waiters: Array<(i: UserInput | null) => void> = [];
    let closed = false;
    let interrupted = false;
    let cost = 0;
    let resolveKilled!: () => void;
    const killed = new Promise<void>((r) => (resolveKilled = r));
    // Out of any real pid range, so a stray kill(-pid) can never hit a real process.
    const pid = ++fakePid;

    const session: FakeSession = {
      opts: o,
      index: this.sessions.length,
      nextInput: () => {
        const v = buf.shift();
        if (v) return Promise.resolve(v);
        if (closed) return Promise.resolve(null);
        return new Promise((r) => waiters.push(r));
      },
      emit: (e) => o.sink(e),
      tool: async (call, run) => {
        const d = await o.gate.preTool(call);
        if (d.allow) {
          const out = run ? await run() : { ok: true, output: "done" };
          o.gate.postTool({ toolCallId: call.toolCallId, ...out });
        }
        return d;
      },
      result: (consumed, r = {}) => {
        cost += r.cost ?? 0.001;
        o.sink({
          type: "result",
          ok: r.ok ?? true,
          subtype: r.subtype ?? "success",
          totalCostUsd: cost,
          consumed,
          queuedTurnCount: r.queued ?? 0,
          errors: [],
        });
      },
      get interrupted() {
        return interrupted;
      },
      killed,
    };
    this.sessions.push(session);

    queueMicrotask(() => o.onSpawn(pid));
    const exited = (async (): Promise<EngineExit> => {
      await Promise.resolve();
      o.sink({ type: "session", sessionId: o.resume ?? `fake-session-${o.runId}`, tools: [...o.builtinTools], mcpServers: [], skills: [], plugins: [], model: o.model });
      const done = this.script(session).then((x) => x ?? { code: 0, signal: null });
      return Promise.race([done, killed.then((): EngineExit => ({ code: null, signal: "SIGKILL" }))]);
    })();

    const close = () => {
      closed = true;
      for (const w of waiters.splice(0)) w(null);
    };
    return {
      push: (i) => {
        if (closed) return;
        const w = waiters.shift();
        if (w) w(i);
        else buf.push(i);
      },
      interrupt: async () => {
        interrupted = true;
      },
      closeInput: close,
      kill: () => {
        close();
        resolveKilled();
      },
      reap: async () => {
        close();
        resolveKilled();
      },
      pid,
      exited,
    };
  }
}
