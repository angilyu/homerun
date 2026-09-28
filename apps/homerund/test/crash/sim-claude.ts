import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import type { AgentEngine, EngineExit, EngineRun, EngineStart, UserInput } from "../../src/agent/engine";
import { appendTranscript, PROJECT_KEY } from "../../src/store/session-store";
import type { Store } from "../../src/store/store";
import { chainEntries, chainTo, chainTools, type Entry, type TEntry } from "../../src/store/transcript";

/**
 * A stand-in for `claude` that is faithful where crash resume depends on it, and adversarial where
 * real `claude` is (design §16.2, milestone 4):
 *
 * - It keeps its conversation only in the stored transcript, chained by `parentUuid` exactly as
 *   `claude` does, and rebuilds it from there on every start (`resume`, `resumeSessionAt`).
 * - On resume, a `tool_use` without a `tool_result` gets a synthetic "interrupted" error, as
 *   `claude` writes (F7). The model below then runs the call again: if Homerun did not settle it
 *   first, a side effect is repeated and the ledger shows it.
 * - The model is naive and has no memory: it runs each step of its plan unless the transcript
 *   shows it finished (a non-error result, or a note saying it ran).
 * - The transcript mirror can lag: with `lagUse`, the `tool_use` entry is written only after the
 *   call finished, so a crash can leave a finished call the transcript never showed.
 *
 * Side effects go to a ledger file (the outside world), one line per effect, fsynced: the truth
 * the "Did this happen?" oracle answers from.
 */

export const INTERRUPTED = "[Request interrupted by user for tool use]";

export interface Step {
  name: string;
  tool: "Read" | "Bash" | "Write";
  input: Record<string, unknown>;
  /** Issued in the same assistant message as the previous step (parallel tool use). */
  withPrev?: boolean;
  /** The mirror writes this step's `tool_use` only after the call finished. */
  lagUse?: boolean;
}

export interface SimHooks {
  /** A boundary inside the fake tool (before and after its side effect). */
  point(): void;
  /** True once `claude` should die (the agent_exited path). */
  dead(): boolean;
}

class Died extends Error {}

export class SimEngine implements AgentEngine {
  private starts = 0;

  constructor(
    private store: Store,
    private plan: readonly Step[],
    private ledger: string,
    private hooks: SimHooks,
  ) {}

  start(o: EngineStart): EngineRun {
    const store = this.store;
    const hooks = this.hooks;
    const plan = this.plan;
    const ledger = this.ledger;
    const sessionId = o.resume ?? crypto.randomUUID();
    const key = { projectKey: PROJECT_KEY, sessionId };
    const pid = 91_000_000 + ++this.starts;
    const buf: UserInput[] = [...o.initialInputs];
    let closed = false;
    let killed = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      wake?.();
      wake = null;
    };

    const alive = () => {
      if (killed || hooks.dead()) throw new Died();
    };
    const tick = async () => {
      await Promise.resolve();
      alive();
    };

    let chain: TEntry[] = [];
    const write = (partial: Entry): string => {
      alive();
      const uuid = (partial.uuid as string | undefined) ?? crypto.randomUUID();
      const e: Entry = {
        parentUuid: chain.at(-1)?.uuid ?? null,
        isSidechain: false,
        userType: "external",
        entrypoint: "sdk-ts",
        cwd: o.cwd,
        sessionId,
        version: "sim",
        timestamp: new Date().toISOString(),
        ...partial,
        uuid,
      };
      appendTranscript(store, key, [e as never]);
      chain.push({ seq: 0, uuid, entry: e });
      alive();
      return uuid;
    };

    const nextInputs = async (): Promise<UserInput[] | null> => {
      for (;;) {
        alive();
        if (buf.length) return buf.splice(0);
        if (closed) return null;
        await new Promise<void>((r) => (wake = r));
      }
    };

    const runMessage = async (steps: readonly Step[]) => {
      const msgId = `msg_${crypto.randomUUID()}`;
      const calls = steps.map((s) => ({ s, id: `toolu_${crypto.randomUUID().replaceAll("-", "")}` }));
      const useEntry = (c: (typeof calls)[number]): Entry => ({
        type: "assistant",
        message: { id: msgId, role: "assistant", content: [{ type: "tool_use", id: c.id, name: c.s.tool, input: c.s.input }] },
      });
      for (const c of calls) if (!c.s.lagUse) write(useEntry(c));
      for (const c of calls) {
        const d = await o.gate.preTool({ toolCallId: c.id, tool: c.s.tool, input: c.s.input });
        alive();
        if (!d.allow) {
          if (c.s.lagUse) write(useEntry(c));
          write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: c.id, content: d.reason, is_error: true }] } });
          continue;
        }
        hooks.point();
        alive();
        if (c.s.tool !== "Read") {
          const fd = openSync(ledger, "a");
          appendFileSync(fd, `${c.s.name} ${c.id}\n`);
          fsyncSync(fd);
          closeSync(fd);
        }
        hooks.point();
        alive();
        const output = `did ${c.s.name}`;
        o.gate.postTool({ toolCallId: c.id, ok: true, output });
        await tick();
        if (c.s.lagUse) write(useEntry(c));
        write({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: c.id, content: output, is_error: false }] },
          toolUseResult: output,
        });
        o.sink({ type: "tool_result_seen", toolCallId: c.id, isError: false, content: output });
      }
    };

    const main = async (): Promise<EngineExit> => {
      await Promise.resolve();
      o.sink({ type: "session", sessionId, tools: [...o.builtinTools], mcpServers: [], skills: [], plugins: [], model: o.model });
      if (o.resume) {
        chain = chainTo(chainEntries(store, sessionId), o.resumeAt ?? undefined);
        if (o.resumeAt && chain.at(-1)?.uuid !== o.resumeAt) throw new Error(`resumeSessionAt ${o.resumeAt} is not in the transcript`);
        for (const u of chainTools(chain).dangling) {
          write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: u.id, content: INTERRUPTED, is_error: true }] } });
        }
      }
      for (let inputs = await nextInputs(); inputs; inputs = await nextInputs()) {
        const consumed: string[] = [];
        const take = (list: UserInput[]) => {
          for (const i of list) {
            write({ type: "user", uuid: i.uuid, message: { role: "user", content: i.text } });
            consumed.push(i.uuid);
          }
        };
        take(inputs);
        for (;;) {
          await tick();
          take(buf.splice(0));
          const i = plan.findIndex((s) => !isDone(s, chain));
          if (i < 0) break;
          let j = i + 1;
          while (j < plan.length && plan[j]!.withPrev && !isDone(plan[j]!, chain)) j++;
          await runMessage(plan.slice(i, j));
        }
        const msgId = `msg_${crypto.randomUUID()}`;
        write({ type: "assistant", message: { id: msgId, role: "assistant", content: [{ type: "text", text: "done" }] } });
        o.sink({ type: "message", messageId: msgId, text: "done" });
        o.sink({ type: "result", ok: true, subtype: "success", totalCostUsd: 0.001, consumed, queuedTurnCount: 0, errors: [] });
      }
      return { code: 0, signal: null };
    };

    const exited = main().catch((e): EngineExit => {
      if (e instanceof Died) return { code: null, signal: "SIGKILL" };
      return { code: 1, signal: null, error: e instanceof Error ? e.message : String(e) };
    });
    queueMicrotask(() => o.onSpawn(pid));

    return {
      push: (i) => {
        if (closed) return;
        buf.push(i);
        poke();
      },
      interrupt: async () => {},
      closeInput: () => {
        closed = true;
        poke();
      },
      kill: () => {
        killed = true;
        poke();
      },
      reap: async () => {
        killed = true;
        poke();
        await exited;
      },
      pid,
      exited,
    };
  }
}

function blocks(e: Entry): Array<Record<string, unknown>> {
  const c = (e.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

function userText(e: Entry): string {
  if (e.type !== "user") return "";
  const c = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof c === "string") return c;
  return blocks(e)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** Whether the transcript shows the step finished: a non-error result, or a note saying it ran. */
export function isDone(step: Step, chain: readonly TEntry[]): boolean {
  const tools = chainTools(chain);
  const input = JSON.stringify(step.input);
  for (const u of tools.uses.values()) {
    const use = blocks(u.at.entry).find((b) => b.type === "tool_use" && b.id === u.id);
    if (JSON.stringify(use?.input) !== input) continue;
    const r = tools.results.get(u.id);
    if (r && !r.isError) return true;
  }
  const mention = `input ${input}`;
  return chain.some((t) => {
    const text = userText(t.entry);
    let at = text.indexOf(mention);
    while (at >= 0) {
      const sentence = text.slice(at).split("\n\n")[0]!;
      if (/do not run it again|and it completed/i.test(sentence)) return true;
      at = text.indexOf(mention, at + 1);
    }
    return false;
  });
}
