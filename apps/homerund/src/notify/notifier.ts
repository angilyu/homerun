import {
  type HealthDigest,
  type InputPrompt,
  type NotificationParams,
  type PersistedThreadEvent,
  type RunError,
  type ThreadEvent,
} from "@homerun/core";
import { log } from "../log";
import { runEvents } from "../store/events";
import { getRunRow, getTask, getThread, pendingInputRequests } from "../store/rows";
import { getFire, getSchedule } from "../store/schedule-rows";
import type { Store } from "../store/store";
import { body, firstLine, title } from "./text";

/** Missed fires reported by one wake are coalesced into one notification (§8.2). */
export const MISSED_COALESCE_MS = 2_000;

/** The params as the runtime builds them (plain ids; the schema brands them on parse). */
type LocalNotification = NotificationParams<"notification.requested">;

export type NotifySend = (method: "notification.requested" | "notification.withdrawn", params: LocalNotification | { key: string }) => void;

type Of<T extends PersistedThreadEvent["type"]> = Extract<PersistedThreadEvent, { type: T }>;

/**
 * Local notifications (§8.2, §9.7), composed here and shown by the shell (`notification.requested`
 * on the shell connection only). The rules live in one place so M9's push reuses them:
 *
 * - Only persisted events, after their commit (the bus publishes after commit), so a rolled-back
 *   change never notifies.
 * - Fixed templates. An approval names the tool and its class, never its input; a question shows
 *   its short header, never the question text; a monitor's report shows its first line as plain
 *   text, without links, redacted (`text.ts`).
 * - Nothing here answers anything: the shell's notification only opens the thread. Destructive
 *   approvals are answered in the app (§9.7).
 * - Each key is sent at most once per runtime life. After a restart the shell's next `hello`
 *   replays pending requests, and the shell drops keys it has already shown.
 */
export class Notifier {
  private off: (() => void) | null = null;
  private sent = new Set<string>();
  private missed: { at: number; schedules: Set<string>; asleep: boolean } | null = null;
  private missedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: Store,
    private send: NotifySend,
    private coalesceMs = MISSED_COALESCE_MS,
  ) {}

  start(): void {
    this.off ??= this.store.bus.subscribeAll((e) => this.onEvent(e));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.missedTimer) clearTimeout(this.missedTimer);
    this.missedTimer = null;
    this.missed = null;
  }

  /** The shell connected (a new shell, or a new runtime life): announce what still waits. */
  replayPending(send: NotifySend = this.send): void {
    for (const r of pendingInputRequests(this.store)) {
      const threadId = getRunRow(this.store, r.run_id)?.thread_id;
      if (!threadId) continue;
      const n = this.inputNotification(threadId, r.request_id, r.prompt, r.requested_at);
      this.sent.add(n.key);
      send("notification.requested", n);
    }
  }

  /** The daily digest (§8.3), when it is on. */
  digestReady(d: HealthDigest): void {
    const attention = d.monitors.filter((m) => m.needs_attention).length;
    const changes = d.monitors.reduce((a, m) => a + m.changes, 0);
    const missed = d.monitors.reduce((a, m) => a + m.missed_asleep + m.missed_not_running, 0);
    const parts = [plural(d.monitors.length, "monitor"), plural(changes, "change")];
    if (missed) parts.push(`${plural(missed, "missed check")}`);
    if (attention) parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
    this.emit({ key: `digest:${d.generated_at}`, kind: "digest", target: { screen: "health" }, thread_id: null, title: "Daily monitor summary", body: body(parts.join(" · ")), created_at: d.generated_at });
  }

  /**
   * An iPhone replaced its Face ID approval key (§18 row 116). The user should know: if they
   * didn't just change Face ID on that phone, they unpair it in Settings.
   */
  approvalKeyRenewed(device: { device_id: string; name: string }, at: number): void {
    this.emit({
      key: `device:${device.device_id.toLowerCase()}:${at}`,
      kind: "device",
      target: { screen: "settings" },
      thread_id: null,
      title: "Face ID approvals changed",
      body: body(`${title(device.name, "An iPhone")} has a new Face ID key for approvals. If you didn't change Face ID on it, unpair it in Settings.`),
      created_at: at,
    });
  }

  private onEvent(e: ThreadEvent): void {
    if (!("seq" in e)) return;
    try {
      switch (e.type) {
        case "input.requested":
          return this.emit(this.inputNotification(e.thread_id, e.payload.request_id, e.payload.prompt, e.ts));
        case "input.resolved":
          return this.withdraw(`input:${e.payload.request_id}`);
        case "run.end":
          return this.runEnded(e);
        case "schedule.paused":
          return this.emit({
            key: `paused:${e.payload.schedule_id}:${e.seq}`,
            kind: "monitor_paused",
            target: { screen: "thread", thread_id: e.thread_id },
            thread_id: e.thread_id,
            title: title(this.monitorName(e.thread_id)),
            body: body(e.payload.detail),
            created_at: e.ts,
          });
        case "schedule.missed":
          return this.scheduleMissed(e);
      }
    } catch (err) {
      // A notification is best effort; the thread and the menu bar still show everything.
      log.warn("notification not sent", { type: e.type, err: err instanceof Error ? err.message : String(err) });
    }
  }

  private inputNotification(threadId: string, requestId: string, prompt: InputPrompt, at: number): LocalNotification {
    const base = { key: `input:${requestId}`, target: { screen: "thread" as const, thread_id: threadId }, thread_id: threadId, title: title(this.threadTitle(threadId)), created_at: at };
    switch (prompt.type) {
      case "approval":
        // The tool and its class only: the input can hold anything, including secrets (§9.7).
        return { ...base, kind: "approval", body: body(`Approval needed: ${prompt.tool} (${prompt.class})`) };
      case "question": {
        const header = prompt.questions[0]?.header;
        return { ...base, kind: "question", body: body(header ? `Claude has a question: ${header}` : "Claude has a question", 80) };
      }
      case "ambiguous_tool_call":
        return { ...base, kind: "ambiguous_call", body: body(`An interrupted ${prompt.tool} call needs your answer`) };
    }
  }

  private runEnded(e: Of<"run.end">): void {
    if (!e.run_id) return;
    const row = getRunRow(this.store, e.run_id);
    if (!row?.monitor_phase || !row.task_id) return;
    const name = title(this.monitorName(e.thread_id));
    const target = { screen: "thread" as const, thread_id: e.thread_id };
    if (e.payload.state === "succeeded" && e.payload.outcome === "changed") {
      const report = runEvents(this.store, e.run_id, "message.final").at(-1)?.payload.text ?? "";
      this.emit({ key: `report:${e.run_id}`, kind: "monitor_report", target, thread_id: e.thread_id, title: name, body: firstLine(report) || "Something changed", created_at: e.ts });
      return;
    }
    if (e.payload.state !== "failed" && e.payload.state !== "abandoned") return;
    // A failed attempt that will be retried is not news yet (§5.3): only the fire's last attempt.
    if (row.scheduled_for !== null) {
      const schedule = this.store.db.query<{ schedule_id: string }, [string]>("SELECT schedule_id FROM schedules WHERE task_id = ?").get(row.task_id);
      const fire = schedule ? getFire(this.store, schedule.schedule_id, row.scheduled_for) : null;
      if (fire && fire.state !== "failed") return;
    }
    this.emit({ key: `failed:${e.run_id}`, kind: "monitor_failed", target, thread_id: e.thread_id, title: name, body: body(`Check failed: ${errorCode(e.payload.error)}`), created_at: e.ts });
  }

  /** Fires the computer couldn't run and catch-up won't either (§8.2): one notification per wake. */
  private scheduleMissed(e: Of<"schedule.missed">): void {
    const p = e.payload;
    if (p.reason === "skipped_by_policy") return;
    if ((p.caught_up ?? 0) >= p.count) return;
    const m = (this.missed ??= { at: e.ts, schedules: new Set(), asleep: false });
    m.schedules.add(p.schedule_id);
    if (p.reason === "asleep") m.asleep = true;
    this.missedTimer ??= setTimeout(() => this.flushMissed(), this.coalesceMs);
  }

  flushMissed(): void {
    if (this.missedTimer) clearTimeout(this.missedTimer);
    this.missedTimer = null;
    const m = this.missed;
    this.missed = null;
    if (!m) return;
    const n = m.schedules.size;
    const why = m.asleep ? "while your Mac was asleep" : "while Homerun wasn't running";
    const one = n === 1 ? this.scheduleName([...m.schedules][0]!) : null;
    this.emit({
      key: `missed:${m.at}`,
      kind: "missed_checks",
      target: { screen: "health" },
      thread_id: null,
      title: "Monitors missed checks",
      body: body(one ? `${one} missed checks ${why}` : `${n} monitors missed checks ${why}`),
      created_at: m.at,
    });
  }

  private emit(n: LocalNotification): void {
    if (this.sent.has(n.key)) return;
    this.sent.add(n.key);
    this.send("notification.requested", n);
  }

  private withdraw(key: string): void {
    if (!this.sent.delete(key)) return;
    this.send("notification.withdrawn", { key });
  }

  private threadTitle(threadId: string): string | null {
    const t = getThread(this.store, threadId);
    if (!t) return null;
    return t.title ?? (t.task_id ? (getTask(this.store, t.task_id)?.name ?? null) : null);
  }

  private monitorName(threadId: string): string | null {
    const t = getThread(this.store, threadId);
    return (t?.task_id ? getTask(this.store, t.task_id)?.name : null) ?? t?.title ?? "A monitor";
  }

  private scheduleName(scheduleId: string): string {
    const s = getSchedule(this.store, scheduleId);
    return (s ? getTask(this.store, s.task_id)?.name : null) ?? "A monitor";
  }

  /** Test helper: the keys sent in this life. */
  get sentKeys(): ReadonlySet<string> {
    return this.sent;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** An error code is a short identifier; anything else is summarised, never echoed. */
function errorCode(e: RunError | null): string {
  const code = e?.code ?? "";
  return /^[a-z0-9_.-]{1,40}$/i.test(code) ? code : "unknown error";
}
