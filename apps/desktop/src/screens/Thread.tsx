import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  chatTitle,
  contentText,
  duration,
  errorMessage,
  sentFromText,
  threadView,
  toolName,
  toolSummary,
  usd,
  type ActiveRun,
  type AssistantItem,
  type RunItem,
  type ScheduleItem,
  type ThreadSync,
  type TimelineItem,
  type ToolItem,
  type UserItem,
  relayedText,
} from "@homerun/app-state";
import type { Content } from "@homerun/core";
import { useApp, useNow, useStore } from "../hooks";
import { Markdown } from "../ui/Markdown";
import { Badge, ErrorText, Fold, Time } from "../ui/bits";
import { InputCard, ResolvedLine } from "./InputCards";
import { threadTitle } from "./Layout";

/**
 * A new chat: nothing exists until the first message, then the thread is created and the
 * message sent through its outbox (§5.7), and the view moves to the thread.
 */
export function NewChat({ task_id }: { task_id?: string }) {
  const app = useApp();
  const tasks = useStore(app.client.tasks.store);
  const task = task_id ? tasks.rows.find((r) => r.task.task_id === task_id)?.task : undefined;
  const [error, setError] = useState<string | null>(null);
  const send = async (text: string) => {
    setError(null);
    try {
      const thread_id = await app.client.createThread(task_id, chatTitle(text));
      const { sync, release } = app.client.retainThread(thread_id);
      void sync.send(text).finally(release);
      app.go({ name: "thread", thread_id });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return (
    <section className="thread">
      <header className="thread-head">
        <h1>{task ? `New chat in ${task.name}` : "New chat"}</h1>
      </header>
      <div className="timeline empty-thread">
        <p className="empty">{task ? "This chat uses the task's instructions, tools and grants." : "Ask Claude anything. It works on this Mac with the tools you allow."}</p>
      </div>
      <ErrorText error={error} />
      <Composer onSend={send} active={null} placeholder="Message Claude" />
    </section>
  );
}

export function Thread({ thread_id }: { thread_id: string }) {
  const app = useApp();
  const [sync, setSync] = useState<ThreadSync | null>(null);
  useEffect(() => {
    const h = app.client.retainThread(thread_id);
    setSync(h.sync);
    return h.release;
  }, [app, thread_id]);
  if (!sync) return null;
  return <ThreadBody sync={sync} />;
}

function ThreadBody({ sync }: { sync: ThreadSync }) {
  const app = useApp();
  const state = useStore(sync.store);
  const list = useStore(app.client.threads.store);
  const tasks = useStore(app.client.tasks.store);
  const summary = list.threads.find((t) => t.thread_id === sync.thread_id);
  const view = threadView(state, summary?.active_run ?? null);
  const taskRow = summary?.task_id ? tasks.rows.find((r) => r.task.task_id === summary.task_id) : undefined;
  const taskName = new Map(tasks.rows.map((r) => [r.task.task_id as string, r.task.name]));
  const [error, setError] = useState<string | null>(null);

  // Read while on screen and the window is visible (§9.8).
  useEffect(() => {
    if (!view.loaded || document.visibilityState !== "visible") return;
    void sync.markRead();
  }, [sync, view.loaded, state.last_seq]);
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && void sync.markRead();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [sync]);

  const scroller = useStickToBottom(view.items);
  const inlineRequests = new Set(view.items.flatMap((i) => (i.kind === "input" ? [i.request_id] : [])));
  const outOfWindow = view.pending.filter((p) => !inlineRequests.has(p.request_id));

  const send = async (text: string) => {
    setError(null);
    await sync.send(text);
    return true;
  };

  return (
    <section className="thread">
      <header className="thread-head">
        <div>
          <h1>{threadTitle(summary, taskName)}</h1>
          {taskRow && (
            <button type="button" className="link" onClick={() => app.go({ name: "task", task_id: taskRow.task.task_id })}>
              {taskRow.task.kind === "monitor" ? "Monitor" : "Task"}: {taskRow.task.name}
            </button>
          )}
        </div>
        <div className="actions">
          {!summary?.task_id && view.items.length > 0 && app.client.may("tasks.create") && (
            <button type="button" onClick={() => app.go({ name: "task_edit", kind: "session", from_thread_id: sync.thread_id })}>
              Save as task…
            </button>
          )}
        </div>
      </header>
      <div className="timeline" ref={scroller} role="log" aria-live="polite" aria-busy={!view.loaded}>
        {view.has_earlier && (
          <button type="button" className="link earlier" onClick={() => void sync.loadEarlier().catch((e) => setError(errorMessage(e)))}>
            Show earlier messages
          </button>
        )}
        {view.items.map((it) => (
          <Item key={it.key} item={it} sync={sync} pending={view.pending.some((p) => it.kind === "input" && p.request_id === it.request_id)} />
        ))}
        {outOfWindow.map((p) => (
          <InputCard key={p.request_id} sync={sync} request_id={p.request_id} prompt={p.prompt} expires_at={p.expires_at} />
        ))}
        {view.active && <ActivityLine active={view.active} />}
      </div>
      <ErrorText error={error} />
      <Composer
        onSend={send}
        active={view.active}
        onStop={view.active && !view.active.stopping ? () => sync.stop(view.active!.run_id).catch((e) => setError(errorMessage(e))) : undefined}
        placeholder={taskRow?.task.kind === "monitor" ? "Reply to this monitor" : "Message Claude"}
      />
    </section>
  );
}

/** Keep the newest message in view while the user is at the bottom. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

function Item({ item, sync, pending }: { item: TimelineItem; sync: ThreadSync; pending: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} sync={sync} />;
    case "assistant":
      return <AssistantBubble item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "input":
      if (item.resolution) return <ResolvedLine prompt={item.prompt} resolution={item.resolution} />;
      if (!pending) return null;
      return <InputCard sync={sync} request_id={item.request_id} prompt={item.prompt} expires_at={item.expires_at} />;
    case "run":
      return <RunLine item={item} />;
    case "schedule":
      return <ScheduleLine item={item} />;
    case "unknown":
      return <p className="event muted">This needs a newer version of Homerun to show.</p>;
  }
}

function UserBubble({ item, sync }: { item: UserItem; sync: ThreadSync }) {
  const devices = useStore(useApp().client.remote.devices);
  const now = useNow();
  const note = (item.delivery === "delivered" && item.disposition !== "steered" && sentFromText(item, devices, now)) || deliveryNote(item);
  const retry = item.delivery === "failed" || item.delivery === "not_delivered";
  return (
    <div className={`msg user delivery-${item.delivery}`} data-delivery={item.delivery}>
      <div className="bubble">
        <p className="text">{item.text}</p>
      </div>
      <div className="msg-meta">
        {note && <span className={item.delivery === "not_delivered" || item.delivery === "failed" ? "warn-text" : "muted"}>{note}</span>}
        {retry && (
          <button type="button" className="link" onClick={() => void sync.resend(item.text, item.delivery === "failed" ? item.client_msg_id : undefined)}>
            {item.delivery === "failed" ? "Retry" : "Send again"}
          </button>
        )}
        {item.delivery === "failed" && (
          <button type="button" className="link" onClick={() => sync.discard(item.client_msg_id)}>
            Discard
          </button>
        )}
        {item.seq !== null && <Time ts={item.ts} />}
      </div>
    </div>
  );
}

/** §5.7: steered, held, and held-but-never-delivered messages each say so. */
export function deliveryNote(item: UserItem): string | null {
  switch (item.delivery) {
    case "sending":
      return "Sending…";
    case "queued":
      return "Waiting for Homerun to send";
    case "relayed":
      return relayedText(item.expires_at, Date.now());
    case "failed":
      return `Not sent: ${item.error ?? "error"}`;
    case "held":
      return "Held until you answer the question above";
    case "not_delivered":
      return "Not delivered: the run ended before Claude read this";
    case "delivered":
      return item.disposition === "steered" ? "Sent to the running task" : item.surface && item.surface !== "desktop" ? `From ${surfaceLabel(item.surface)}` : null;
  }
}

const surfaceLabel = (s: string) => (s === "cli" ? "the command line" : s === "ios" ? "iPhone" : s === "web" ? "the web" : s);

function AssistantBubble({ item }: { item: AssistantItem }) {
  return (
    <div className={`msg assistant${item.subagent ? " subagent" : ""}`} aria-busy={item.streaming || undefined}>
      {item.subagent && <span className="badge">Subagent</span>}
      <Markdown text={item.text} />
      {item.streaming && <span className="cursor" aria-hidden="true" />}
      {item.gap && <p className="muted small">Part of this reply is still loading.</p>}
    </div>
  );
}

const TOOL_STATE: Record<ToolItem["state"], { label: string; tone: "plain" | "warn" | "danger" | "ok" | "info" }> = {
  running: { label: "Running", tone: "info" },
  waiting: { label: "Waiting for you", tone: "warn" },
  no_result: { label: "Stopped", tone: "plain" },
  ok: { label: "Done", tone: "ok" },
  error: { label: "Error", tone: "danger" },
  denied: { label: "Denied", tone: "plain" },
  resolved_completed: { label: "Marked done", tone: "ok" },
  resolved_not_run: { label: "Marked not run", tone: "plain" },
  interrupted_retryable: { label: "Interrupted", tone: "warn" },
};

function ToolRow({ item }: { item: ToolItem }) {
  const s = TOOL_STATE[item.state] ?? { label: item.state, tone: "plain" as const };
  return (
    <details className={`tool${item.subagent ? " subagent" : ""}`}>
      <summary>
        <span className="tool-name">{toolName(item.call.tool)}</span> <span className="tool-summary">{toolSummary(item.call.tool, item.call.input)}</span>{" "}
        <Badge tone={s.tone}>{s.label}</Badge>
        {item.result?.duration_ms !== undefined && <span className="muted small"> {duration(item.result.duration_ms)}</span>}
      </summary>
      <div className="tool-body">
        <h4>Input</h4>
        <ContentView c={item.call.input} />
        {item.result?.output && (
          <>
            <h4>Output</h4>
            <ContentView c={item.result.output} />
          </>
        )}
        {item.result?.error && <p className="error">{item.result.error}</p>}
      </div>
    </details>
  );
}

const BLOB_PAGE = 256 * 1024;
const BLOB_MAX = 4 * 1024 * 1024;

/** Inline content, or a blob's preview with "Load all" (`blobs.get` pages, §6). */
function ContentView({ c }: { c: Content }) {
  const app = useApp();
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (c.kind === "inline" || full !== null) return <Fold text={full ?? contentText(c)} lines={12} />;
  const load = async () => {
    try {
      const parts: Uint8Array[] = [];
      let offset = 0;
      for (;;) {
        const r = await app.client.rpc.call("blobs.get", { sha256: c.sha256, offset, length: BLOB_PAGE });
        const bin = Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0));
        parts.push(bin);
        offset += bin.length;
        if (r.eof || bin.length === 0 || offset >= BLOB_MAX) break;
      }
      const all = new Uint8Array(offset);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      setFull(new TextDecoder().decode(all) + (offset < c.size ? "\n…" : ""));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div>
      <Fold text={contentText(c)} lines={12} />
      <button type="button" className="link" onClick={() => void load()}>
        Load all ({Math.ceil(c.size / 1024)} KB)
      </button>
      <ErrorText error={error} />
    </div>
  );
}

function RunLine({ item }: { item: RunItem }) {
  const app = useApp();
  const [error, setError] = useState<string | null>(null);
  const e = item.event;
  switch (e.type) {
    case "run.started":
      if (e.payload.trigger === "message") return null;
      return (
        <p className="event">
          {e.payload.trigger === "schedule" ? "Scheduled run" : e.payload.trigger === "catchup" ? "Catch-up run" : "Run started by hand"}
          {e.payload.attempt > 0 ? ` (retry ${e.payload.attempt})` : ""} <Time ts={item.ts} />
        </p>
      );
    case "run.resumed": {
      const why = {
        runtime_restart: "Resumed after Homerun restarted",
        agent_exited: "Resumed after Claude's process stopped",
        input_answered: null,
        ambiguity_resolved: null,
      }[e.payload.reason];
      return why ? <p className="event">{why}</p> : null;
    }
    case "run.cancelled":
      // A stop by hand shows as "Stopping…" while it runs (ActivityLine) and "Stopped" at run.end.
      if (e.payload.reason === "user") return null;
      return <p className="event">{e.payload.reason === "input_timeout" ? "Stopped: nobody answered in time" : "Stopped: the monthly budget was reached"}</p>;
    case "run.end": {
      const p = e.payload;
      const cost = p.cost_usd !== null ? ` · ${usd(p.cost_usd)}` : "";
      if (p.state === "succeeded")
        return (
          <p className="event muted">
            {p.outcome === "changed" ? "Something changed" : p.outcome === "no_change" ? "No change" : "Done"}
            {cost}
          </p>
        );
      if (p.state === "cancelled") return <p className="event muted">Stopped{cost}</p>;
      return (
        <div className="event failed" role="status">
          <span>
            {p.state === "abandoned" ? "Abandoned" : "Failed"}
            {p.error ? `: ${p.error.message}` : ""}
            {cost}
          </span>
          {item.run_id && (
            <button type="button" className="link" onClick={() => void app.client.rpc.call("runs.retry", { run_id: item.run_id! }).catch((err) => setError(errorMessage(err)))}>
              Retry
            </button>
          )}
          <ErrorText error={error} />
        </div>
      );
    }
  }
}

function ScheduleLine({ item }: { item: ScheduleItem }) {
  const e = item.event;
  if (e.type === "schedule.paused") return <p className="event warn-text">{e.payload.detail}</p>;
  const p = e.payload;
  const why = p.reason === "asleep" ? "the Mac was asleep" : p.reason === "not_running" ? "Homerun wasn't running" : "the catch-up policy skipped them";
  const n = p.count === 1 ? "A scheduled check was" : `${p.count} scheduled checks were`;
  const caught = p.caught_up ? ` ${p.caught_up === 1 ? "One ran" : `${p.caught_up} ran`} late.` : "";
  return (
    <p className="event muted">
      {n} missed because {why}.{caught} <Time ts={p.scheduled_for} />
    </p>
  );
}

function ActivityLine({ active }: { active: ActiveRun }) {
  const text = active.stopping
    ? "Stopping…"
    : active.state === "waiting_input"
      ? "Waiting for your answer"
      : active.detail === "queued" || active.state === "pending"
        ? active.queue_position
          ? `Queued: ${active.queue_position} ahead`
          : "Queued"
        : active.detail === "retrying_model"
          ? "Claude is busy, retrying…"
          : active.detail === "rate_limited"
            ? "Rate limited, retrying…"
            : "Working…";
  return (
    <p className="activity" role="status">
      <span className="spinner" aria-hidden="true" /> {text}
    </p>
  );
}

/**
 * The composer. While a run is working, a message steers it; while it waits for an answer, the
 * message is held (§5.7). Enter sends, Shift-Enter adds a line.
 */
export function Composer({ onSend, active, onStop, placeholder }: { onSend: (text: string) => Promise<boolean>; active: ActiveRun | null; onStop?: () => void; placeholder: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const app = useApp();
  const runtime = useStore(app.client.runtime);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      if (await onSend(t)) setText("");
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const hint = !active
    ? runtime.state !== "ready"
      ? "Homerun isn't running; messages are sent when it's back."
      : null
    : active.state === "waiting_input"
      ? "Claude is waiting for your answer. A message now is held and delivered with it."
      : "Claude is working. A message now is sent to the running task.";
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea aria-label="Message" rows={Math.min(8, Math.max(2, text.split("\n").length))} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <div className="composer-bar">
        <span className="help">{hint}</span>
        {onStop && (
          <button type="button" className="danger" onClick={onStop}>
            Stop
          </button>
        )}
        <button type="submit" className="primary" disabled={!text.trim() || busy}>
          {active && active.state !== "waiting_input" ? "Steer" : "Send"}
        </button>
      </div>
    </form>
  );
}
