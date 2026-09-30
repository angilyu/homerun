import { describe, expect, test } from "bun:test";
import {
  EVENT_TYPES,
  LIVE_ONLY_EVENT_TYPES,
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  PERSISTED_EVENT_TYPES,
  ThreadEvent,
  assertNever,
  isLiveOnly,
  isPersisted,
  methodSchemaIds,
  notificationSchemaId,
  parseThreadEventLenient,
  type MethodName,
  type NotificationName,
  type ThreadEvent as ThreadEventT,
} from "../src/index";
import { loadVectors } from "./helpers";
import * as F from "../scripts/vectors/fixtures";

/**
 * Compile-time exhaustiveness: adding an event type, method or notification without handling it
 * here fails `tsc` (the `never` check), which is the pattern clients should copy.
 */
function render(e: ThreadEventT): string {
  switch (e.type) {
    case "user.message":
      return e.payload.text;
    case "message.final":
      return e.payload.text;
    case "message.delta":
      return e.payload.text;
    case "tool.call":
      return e.payload.tool;
    case "tool.result":
      return e.payload.status;
    case "input.requested":
      return e.payload.prompt.type;
    case "input.resolved":
      return e.payload.state;
    case "run.started":
      return e.payload.trigger;
    case "run.resumed":
      return e.payload.reason;
    case "run.cancelled":
      return e.payload.reason;
    case "run.end":
      return e.payload.state;
    case "schedule.missed":
      return e.payload.reason;
    case "schedule.paused":
      return e.payload.reason;
    case "run.status":
      return e.payload.detail;
    default:
      return assertNever(e, "event");
  }
}

function methodArea(m: MethodName): string {
  switch (m) {
    case "hello":
    case "cli.request_access":
    case "ping":
      return "connection";
    case "tasks.list":
    case "tasks.get":
    case "tasks.get_version":
    case "tasks.create":
    case "tasks.update":
    case "tasks.archive":
    case "tasks.run_now":
      return "tasks";
    case "schedules.list":
    case "schedules.set_enabled":
    case "schedules.coverage":
      return "schedules";
    case "health.digest":
    case "health.settings.get":
    case "health.settings.set":
      return "health";
    case "grants.list":
    case "grants.create":
    case "grants.revoke":
      return "grants";
    case "threads.list":
    case "threads.create":
    case "threads.history":
    case "threads.subscribe":
    case "threads.unsubscribe":
    case "threads.mark_read":
    case "messages.send":
      return "threads";
    case "runs.list":
    case "runs.get":
    case "runs.stop":
    case "runs.retry":
      return "runs";
    case "input.list_pending":
    case "input.answer":
      return "input";
    case "monitors.state.get":
    case "monitors.state.set":
    case "monitors.state.reset":
      return "monitors";
    case "blobs.get":
      return "blobs";
    case "cli.tokens.list":
    case "cli.tokens.revoke":
    case "cli.sign_out":
    case "cli.approve":
    case "cli.deny":
    case "secrets.set":
    case "secrets.clear":
    case "secrets.verify":
    case "secrets.persist":
      return "local";
    default:
      return assertNever(m, "method");
  }
}

function notificationArea(n: NotificationName): string {
  switch (n) {
    case "thread.event":
    case "threads.changed":
      return "threads";
    case "cli.access_decision":
    case "cli.access_requested":
    case "cli.access_withdrawn":
      return "cli";
    case "health.digest_ready":
      return "health";
    case "notification.requested":
    case "notification.withdrawn":
      return "notify";
    case "power.will_sleep":
    case "power.did_wake":
      return "power";
    default:
      return assertNever(n, "notification");
  }
}

const vectors = Object.values(loadVectors()).flat();
const has = (schema: string, valid: boolean, pred: (v: any) => boolean = () => true) =>
  vectors.some((c) => c.schema === schema && c.valid === valid && pred(c.value));

describe("thread events", () => {
  test("persisted and live-only partition the event types", () => {
    const p = new Set<string>(PERSISTED_EVENT_TYPES);
    const l = new Set<string>(LIVE_ONLY_EVENT_TYPES);
    expect([...p].filter((t) => l.has(t))).toEqual([]);
    expect([...p, ...l].sort()).toEqual([...EVENT_TYPES].sort());
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(LIVE_ONLY_EVENT_TYPES.sort()).toEqual(["message.delta", "run.status"]);
  });

  test.each([...EVENT_TYPES])("%s has valid and invalid vectors and renders", (type) => {
    expect(has("ThreadEvent", true, (v) => v.type === type)).toBe(true);
    expect(has("ThreadEvent", false, (v) => v.type === type)).toBe(true);
    const sample = vectors.find((c) => c.schema === "ThreadEvent" && c.valid && (c.value as any).type === type)!;
    const e = ThreadEvent.parse(sample.value);
    expect(typeof render(e)).toBe("string");
    expect(isLiveOnly(e.type)).toBe(!isPersisted(e));
    // Live-only events carry after_seq, persisted ones seq.
    expect("seq" in e).toBe(isPersisted(e));
    expect("after_seq" in e).toBe(!isPersisted(e));
  });

  test("lenient parse keeps unknown types with their seq", () => {
    const r = parseThreadEventLenient(F.persisted("run.paused", { why: "new in v2" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toMatchObject({ type: "unknown", original_type: "run.paused", seq: 7 });
    const k = parseThreadEventLenient(F.persisted("run.resumed", { reason: "runtime_restart" }));
    expect(k.ok && k.event.type).toBe("run.resumed");
    expect(parseThreadEventLenient(F.persisted("run.resumed", { reason: "nope" })).ok).toBe(false);
    expect(parseThreadEventLenient({ type: "x" }).ok).toBe(false);
  });
});

describe("protocol coverage", () => {
  test.each([...METHOD_NAMES])("%s has params and result vectors", (m) => {
    expect(typeof methodArea(m)).toBe("string");
    const ids = methodSchemaIds(m);
    expect(has(ids.params, true)).toBe(true);
    expect(has(ids.params, false)).toBe(true);
    expect(has(ids.result, true)).toBe(true);
  });

  test.each([...NOTIFICATION_NAMES])("%s has valid and invalid vectors", (n) => {
    expect(typeof notificationArea(n)).toBe("string");
    const id = notificationSchemaId(n);
    expect(has(id, true)).toBe(true);
    expect(has(id, false)).toBe(true);
  });

  test.each(["instruction", "push", "answer"])("sealed %s has vectors", (t) => {
    expect(has("SealedInner", true, (v) => v.body?.type === t)).toBe(true);
  });
});
