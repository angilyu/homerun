import {
  type ClientMsgId,
  type InputPrompt,
  type NotificationParams,
  type Origin,
  type PushCategory as PushCategorySchema,
  SEALED_EXPIRY_DEFAULT_MS,
  type SealedAnswer as SealedAnswerSchema,
  type SealedInner,
  type SealedInstruction as SealedInstructionSchema,
  type SealedPush as SealedPushSchema,
  answerableFromNotification,
} from "@homerun/core";
import { type DeviceIdentity, fromB64url, newMsgId, openSealed, seal, seenUntil, type SealedEnvelope } from "@homerun/protocol";
import type { z } from "zod";
import { log } from "../log";
import type { Answer } from "../runs/ambiguity";
import { getInputRequest } from "../store/rows";
import type { Store } from "../store/store";
import type { DeviceRow, PairedDevices } from "./devices";

/**
 * Sealed messages at the desktop (§9.4, §9.7). In: instructions sent while this computer was
 * offline or asleep, and answers from a phone's lock screen. Out: pushes to paired iPhones,
 * mirroring the local notifications.
 *
 * An incoming message is opened against the sender's pinned key, applied at most once (its
 * `msg_id` goes into the seen-set in the same transaction as its effect), and acknowledged so the
 * relay drops it. One that can't be opened, or whose effect is refused, is acknowledged too:
 * redelivering it would change nothing.
 */

type LocalNotification = NotificationParams<"notification.requested">;

/** What a sealed message may do here: the same calls a live session makes, as that device. */
export interface SealedEffects {
  sendMessage(p: { thread_id: string; client_msg_id: string; text: string; sent_at: number }, origin: Origin): unknown;
  createThread(title: string | undefined, taskId: string | undefined): { thread_id: string };
  /** `input.answer`, routed like the RPC handler. Throws when refused. */
  answer(requestId: string, a: Answer): unknown;
  /** A thread was created: tell the thread lists. */
  touch(threadId: string): void;
}

export interface SealedDeps {
  store: Store;
  devices: PairedDevices;
  me(): DeviceIdentity;
  now(): number;
  effects?: SealedEffects;
  /** Acknowledge a queued message so the relay drops it. */
  ack(id: string): void;
  /** POST a sealed envelope to the relay. */
  post(env: SealedEnvelope): Promise<unknown>;
}

type PushCategory = z.infer<typeof PushCategorySchema>;
type SealedInstruction = z.infer<typeof SealedInstructionSchema>;
type SealedAnswer = z.infer<typeof SealedAnswerSchema>;
type SealedPush = z.infer<typeof SealedPushSchema>;
type Actions = { actions?: SealedPush["actions"] };

const PUSH_CATEGORY: Partial<Record<LocalNotification["kind"], PushCategory>> = {
  approval: "input_request",
  question: "input_request",
  ambiguous_call: "input_request",
  monitor_report: "monitor_changed",
  monitor_failed: "run_failed",
  monitor_paused: "run_failed",
  missed_checks: "schedule_missed",
  // The daily digest stays on the desktop: it's a summary, not news.
};

export class SealedMessages {
  constructor(private d: SealedDeps) {}

  // ---------------------------------------------------------------- in

  /** A `sealed` frame from the relay. */
  receive(id: string, envelope: unknown): void {
    try {
      this.open(envelope);
    } finally {
      this.d.ack(id);
    }
  }

  private open(envelope: unknown): void {
    const now = this.d.now();
    const store = this.d.store;
    this.prune(now);
    const r = openSealed(envelope, {
      me: this.d.me(),
      senderStatic: (id) => this.d.devices.staticKey(id),
      now,
      seen: (msgId) => store.db.query("SELECT 1 FROM sealed_seen WHERE msg_id = ?").get(msgId) !== null,
    });
    if (!r.ok) {
      log.info("sealed message dropped", { reason: r.reason });
      return;
    }
    const inner = r.inner;
    const from = this.d.devices.get(inner.sender_device_id)!;
    const record = () => store.db.query("INSERT OR IGNORE INTO sealed_seen (msg_id, until) VALUES (?, ?)").run(inner.msg_id, seenUntil(inner));
    try {
      store.tx(() => {
        record();
        this.apply(inner, from);
      });
    } catch (e) {
      // Refused (a deleted thread, an answered request, a destructive approval): never retried.
      store.tx(record);
      log.info("sealed message refused", { kind: inner.body.type, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private apply(inner: SealedInner, from: DeviceRow): void {
    const fx = this.d.effects;
    if (!fx) throw new Error("nothing here applies sealed messages");
    const origin = { device_id: from.device_id, surface: from.platform } as Origin;
    const b = inner.body;
    switch (b.type) {
      case "instruction":
        return this.instruction(fx, b, origin, inner.created_at);
      case "answer":
        return this.answer(fx, b, from);
      case "push":
        throw new Error("a desktop doesn't take pushes");
    }
  }

  /** Like `messages.send` from the phone, dated when it was sent (§9.4: "sent 3 hours ago from iPhone"). */
  private instruction(fx: SealedEffects, b: SealedInstruction, origin: Origin, sentAt: number): void {
    let threadId: string | null = b.thread_id;
    if (!threadId) {
      // A new chat is idempotent on client_msg_id too, whichever thread it made.
      threadId = this.threadOfMessage(b.client_msg_id) ?? fx.createThread(undefined, b.task_id).thread_id;
      fx.touch(threadId);
    }
    fx.sendMessage({ thread_id: threadId, client_msg_id: b.client_msg_id, text: b.text, sent_at: sentAt }, origin);
  }

  /** From a lock-screen action: the phone's authority, and `via: notification`, which refuses what must be answered in the app. */
  private answer(fx: SealedEffects, b: SealedAnswer, from: DeviceRow): void {
    if (from.platform !== "ios") throw new Error("only a phone answers from a notification");
    fx.answer(b.request_id, {
      response: b.response,
      role: "ios",
      via: "notification",
      origin: { device_id: from.device_id, surface: "ios" } as Origin,
    });
  }

  private threadOfMessage(clientMsgId: ClientMsgId): string | null {
    const r = this.d.store.db
      .query<{ thread_id: string }, [string]>("SELECT thread_id FROM thread_events WHERE type = 'user.message' AND json_extract(payload, '$.client_msg_id') = ? LIMIT 1")
      .get(clientMsgId);
    return r?.thread_id ?? null;
  }

  private prune(now: number): void {
    this.d.store.db.query("DELETE FROM sealed_seen WHERE until < ?").run(now);
  }

  // ---------------------------------------------------------------- out

  /**
   * A local notification, sealed to each paired iPhone (§9.7). The text is the notifier's fixed
   * template, never tool input. Lock-screen actions only for requests `answerableFromNotification`.
   */
  push(n: LocalNotification): void {
    const category = PUSH_CATEGORY[n.kind];
    if (!category) return;
    const phones = this.d.devices.rows().filter((r) => r.platform === "ios");
    if (!phones.length) return;
    const requestId = n.key.startsWith("input:") ? n.key.slice("input:".length) : null;
    const prompt = requestId ? getInputRequest(this.d.store, requestId)?.prompt : undefined;
    const body: SealedPush = {
      type: "push",
      category,
      title: n.title,
      body: n.body,
      ...(n.thread_id ? { thread_id: n.thread_id } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(prompt ? actionsFor(prompt) : {}),
    } as SealedPush;
    const me = this.d.me();
    const now = this.d.now();
    for (const phone of phones) {
      const inner: SealedInner = {
        v: 1,
        msg_id: newMsgId(),
        sender_device_id: me.deviceId,
        created_at: now,
        expires_at: now + SEALED_EXPIRY_DEFAULT_MS.push,
        body,
      } as SealedInner;
      const env = seal({ inner, to: phone.device_id, sender: me.noise, recipientStatic: fromB64url(phone.static_public_key) });
      // Best effort: a phone with no push token, or an unreachable relay, just misses it.
      this.d.post(env).catch((e: Error) => log.info("push not sent", { device_id: phone.device_id, error: e.message }));
    }
  }
}

/** Lock-screen buttons for a request a notification may answer (§9.7). */
export function actionsFor(p: InputPrompt): Actions {
  if (!answerableFromNotification(p)) return {};
  if (p.type === "approval") return { actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] };
  if (p.type === "question") return { actions: p.questions[0]!.options.map((o, i) => ({ id: `option:${i}`, label: o.label.slice(0, 64) })) };
  return {};
}
