import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AppState, FlatList, KeyboardAvoidingView, Pressable, TextInput, View } from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  chatTitle,
  contentText,
  duration,
  errorMessage,
  offlineText,
  relayedText,
  sentFromText,
  threadView,
  toolName,
  toolSummary,
  usd,
  type ActiveRun,
  type AssistantItem,
  type PendingInput,
  type RunItem,
  type ScheduleItem,
  type ThreadSync,
  type TimelineItem,
  type ToolItem,
  type UserItem,
} from "@homerun/app-state";
import { useCoalescedStore, useDesktop, useNow, useStore } from "./hooks";
import { InputCard, ResolvedLine } from "./InputCards";
import { Markdown } from "./Markdown";
import type { Routes } from "./Main";
import { Badge, Button, ErrorText, Notice, Screen, T, s, usePalette } from "./theme";

type Nav = NativeStackNavigationProp<Routes>;

/** The desktop's status as a banner: offline, the relay out of reach, or reconnecting (§9.4, §9.8). */
export function StatusBanner() {
  const { client } = useDesktop();
  const runtime = useStore(client.runtime);
  const now = useNow();
  if (runtime.state === "ready") return null;
  const text =
    runtime.state === "offline"
      ? offlineText(runtime, now)
      : runtime.state === "blocked"
        ? runtime.message
        : runtime.state === "starting"
          ? "Connecting to your Mac…"
          : "Homerun on your Mac is restarting. Messages will send when it's back.";
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
      <Notice text={text} />
    </View>
  );
}

/** A new chat on the shown desktop: created with the first message, then the view moves to it. */
export function NewChat() {
  const { client } = useDesktop();
  const nav = useNavigation<Nav>();
  const runtime = useStore(client.runtime);
  const [error, setError] = useState<string | null>(null);
  const ready = runtime.state === "ready";
  const send = async (text: string) => {
    setError(null);
    try {
      const thread_id = await client.createThread(undefined, chatTitle(text));
      const { sync, release } = client.retainThread(thread_id);
      void sync.send(text).finally(release);
      nav.replace("Chat", { threadId: thread_id });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return (
    <Screen>
      <KeyboardAvoidingView style={s.fill} behavior="padding" keyboardVerticalOffset={100}>
        <StatusBanner />
        <View style={s.center}>
          <T muted style={{ textAlign: "center" }}>
            {ready ? "Ask Claude anything. It works on your Mac with the tools you allow." : "New chats start when your Mac is back. You can still message an existing chat."}
          </T>
          <ErrorText error={error} />
        </View>
        <Composer onSend={send} active={null} placeholder="Message Claude" disabled={!ready} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function Chat({ threadId }: { threadId: string }) {
  const { client } = useDesktop();
  const [sync, setSync] = useState<ThreadSync | null>(null);
  useEffect(() => {
    const h = client.retainThread(threadId);
    setSync(h.sync);
    return h.release;
  }, [client, threadId]);
  if (!sync) return null;
  return <ChatBody sync={sync} />;
}

type Row = { key: string; k: "item"; item: TimelineItem; pending: boolean } | { key: string; k: "pending"; p: PendingInput } | { key: string; k: "activity"; active: ActiveRun };

function ChatBody({ sync }: { sync: ThreadSync }) {
  const { client } = useDesktop();
  const nav = useNavigation<Nav>();
  const focused = useIsFocused();
  // A streaming reply changes the thread many times a second; the timeline redraws at most ~8 times.
  const state = useCoalescedStore(sync.store);
  const list = useStore(client.threads.store);
  const summary = list.threads.find((t) => t.thread_id === sync.thread_id);
  const view = threadView(state, summary?.active_run ?? null);
  const [error, setError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({ title: summary?.title ?? summary?.last_message?.preview.slice(0, 40) ?? "Chat" });
  }, [nav, summary?.title, summary?.last_message?.preview]);

  // Read while on screen with the app in front (§9.8).
  useEffect(() => {
    if (focused && view.loaded && AppState.currentState === "active") void sync.markRead();
  }, [sync, focused, view.loaded, state.last_seq]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (a) => a === "active" && focused && void sync.markRead());
    return () => sub.remove();
  }, [sync, focused]);

  const rows = useMemo(() => {
    const inline = new Set(view.items.flatMap((i) => (i.kind === "input" ? [i.request_id] : [])));
    const pendingIds = new Set(view.pending.map((p) => p.request_id));
    const out: Row[] = [];
    if (view.active) out.push({ key: "activity", k: "activity", active: view.active });
    for (const p of [...view.pending].reverse()) if (!inline.has(p.request_id)) out.push({ key: `pending:${p.request_id}`, k: "pending", p });
    for (let i = view.items.length - 1; i >= 0; i--) {
      const it = view.items[i]!;
      out.push({ key: it.key, k: "item", item: it, pending: it.kind === "input" && pendingIds.has(it.request_id) });
    }
    return out;
  }, [view.items, view.pending, view.active]);

  const loadEarlier = () => {
    if (!view.has_earlier || earlier) return;
    setEarlier(true);
    void sync
      .loadEarlier()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setEarlier(false));
  };

  const active = view.active;
  return (
    <Screen>
      <KeyboardAvoidingView style={s.fill} behavior="padding" keyboardVerticalOffset={100}>
        <StatusBanner />
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          onEndReached={loadEarlier}
          onEndReachedThreshold={0.5}
          ListFooterComponent={view.has_earlier ? <Button kind="link" title={earlier ? "Loading…" : "Show earlier messages"} onPress={loadEarlier} /> : null}
          ListEmptyComponent={
            view.loaded ? null : (
              <T muted style={{ textAlign: "center" }}>
                Loading…
              </T>
            )
          }
          renderItem={({ item: r }) =>
            r.k === "activity" ? (
              <ActivityLine active={r.active} />
            ) : r.k === "pending" ? (
              <InputCard sync={sync} request_id={r.p.request_id} prompt={r.p.prompt} expires_at={r.p.expires_at} />
            ) : (
              <Item item={r.item} sync={sync} pending={r.pending} />
            )
          }
        />
        <ErrorText error={error} />
        <Composer
          onSend={async (text) => {
            setError(null);
            await sync.send(text);
            return true;
          }}
          active={active}
          onStop={active && !active.stopping ? () => void sync.stop(active.run_id).catch((e) => setError(errorMessage(e))) : undefined}
          placeholder={summary?.task_id ? "Reply to this task" : "Message Claude"}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
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
      return <Event text="This needs a newer version of Homerun to show." />;
  }
}

function Event({ text, tone }: { text: string; tone?: "warn" | "danger" }) {
  return (
    <T muted={!tone} tone={tone} style={[s.small, { textAlign: "center", paddingHorizontal: 16 }]}>
      {text}
    </T>
  );
}

/** §5.7 and §9.8: sending, sealed at the relay until the Mac is back, held, steered, failed. */
export function deliveryNote(item: UserItem, now: number): string | null {
  switch (item.delivery) {
    case "sending":
      return "Sending…";
    case "queued":
      return "Waiting to send";
    case "relayed":
      return relayedText(item.expires_at, now);
    case "failed":
      return `Not sent: ${item.error ?? "error"}`;
    case "held":
      return "Held until you answer the question above";
    case "not_delivered":
      return "Not delivered: the run ended before Claude read this";
    case "delivered":
      return item.disposition === "steered" ? "Sent to the running task" : null;
  }
}

function UserBubble({ item, sync }: { item: UserItem; sync: ThreadSync }) {
  const { client } = useDesktop();
  const devices = useStore(client.remote.devices);
  const p = usePalette();
  const now = useNow();
  const note = (item.delivery === "delivered" && item.disposition !== "steered" && sentFromText(item, devices, now)) || deliveryNote(item, now);
  const bad = item.delivery === "failed" || item.delivery === "not_delivered";
  return (
    <View style={{ alignItems: "flex-end", gap: 2 }}>
      <View style={{ backgroundColor: p.bubble, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, maxWidth: "88%", opacity: item.seq === null ? 0.8 : 1 }}>
        <T selectable>{item.text}</T>
      </View>
      <View style={s.row}>
        {note ? (
          <T muted={!bad} tone={bad ? "warn" : undefined} style={s.small}>
            {note}
          </T>
        ) : null}
        {bad ? (
          <Button kind="link" title={item.delivery === "failed" ? "Retry" : "Send again"} onPress={() => void sync.resend(item.text, item.delivery === "failed" ? item.client_msg_id : undefined)} />
        ) : null}
        {item.delivery === "failed" ? <Button kind="link" title="Discard" onPress={() => sync.discard(item.client_msg_id)} /> : null}
      </View>
    </View>
  );
}

function AssistantBubble({ item }: { item: AssistantItem }) {
  return (
    <View style={{ gap: 4, paddingRight: 16 }} accessibilityState={{ busy: item.streaming }}>
      {item.subagent ? <Badge>Subagent</Badge> : null}
      <Markdown text={item.text + (item.streaming ? " ▍" : "")} />
      {item.gap ? (
        <T muted style={s.small}>
          Part of this reply is still loading.
        </T>
      ) : null}
    </View>
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
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const st = TOOL_STATE[item.state] ?? { label: item.state, tone: "plain" as const };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)}
      style={{ borderWidth: 1, borderColor: p.border, borderRadius: 10, padding: 10, gap: 6 }}
    >
      <View style={s.row}>
        <T style={[s.small, { fontWeight: "600" }]}>{toolName(item.call.tool)}</T>
        <Badge tone={st.tone}>{st.label}</Badge>
        {item.result?.duration_ms !== undefined ? (
          <T muted style={s.small}>
            {duration(item.result.duration_ms)}
          </T>
        ) : null}
      </View>
      <T muted style={s.small} selectable={open}>
        {open ? contentText(item.call.input) : toolSummary(item.call.tool, item.call.input, 80)}
      </T>
      {open && item.result?.output ? (
        <T style={[s.mono, { backgroundColor: p.code, padding: 8, borderRadius: 6 }]} selectable>
          {contentText(item.result.output)}
        </T>
      ) : null}
      {open && item.result?.error ? (
        <T tone="danger" style={s.small}>
          {item.result.error}
        </T>
      ) : null}
    </Pressable>
  );
}

function RunLine({ item }: { item: RunItem }) {
  const { client } = useDesktop();
  const [error, setError] = useState<string | null>(null);
  const e = item.event;
  switch (e.type) {
    case "run.started":
      if (e.payload.trigger === "message") return null;
      return (
        <Event
          text={`${e.payload.trigger === "schedule" ? "Scheduled run" : e.payload.trigger === "catchup" ? "Catch-up run" : "Run started by hand"}${e.payload.attempt > 0 ? ` (retry ${e.payload.attempt})` : ""}`}
        />
      );
    case "run.resumed": {
      const why = {
        runtime_restart: "Resumed after Homerun restarted",
        agent_exited: "Resumed after Claude's process stopped",
        input_answered: null,
        ambiguity_resolved: null,
      }[e.payload.reason];
      return why ? <Event text={why} /> : null;
    }
    case "run.cancelled":
      if (e.payload.reason === "user") return null;
      return <Event text={e.payload.reason === "input_timeout" ? "Stopped: nobody answered in time" : "Stopped: the monthly budget was reached"} />;
    case "run.end": {
      const p = e.payload;
      const cost = p.cost_usd !== null ? ` · ${usd(p.cost_usd)}` : "";
      if (p.state === "succeeded") return <Event text={`${p.outcome === "changed" ? "Something changed" : p.outcome === "no_change" ? "No change" : "Done"}${cost}`} />;
      if (p.state === "cancelled") return <Event text={`Stopped${cost}`} />;
      return (
        <View style={{ alignItems: "center" }}>
          <Event tone="danger" text={`${p.state === "abandoned" ? "Abandoned" : "Failed"}${p.error ? `: ${p.error.message}` : ""}${cost}`} />
          {item.run_id && client.may("runs.retry") ? (
            <Button kind="link" title="Retry" onPress={() => void client.rpc.call("runs.retry", { run_id: item.run_id! }).catch((err) => setError(errorMessage(err)))} />
          ) : null}
          <ErrorText error={error} />
        </View>
      );
    }
  }
}

function ScheduleLine({ item }: { item: ScheduleItem }) {
  const e = item.event;
  if (e.type === "schedule.paused") return <Event tone="warn" text={e.payload.detail} />;
  const p = e.payload;
  const why = p.reason === "asleep" ? "the Mac was asleep" : p.reason === "not_running" ? "Homerun wasn't running" : "the catch-up policy skipped them";
  const n = p.count === 1 ? "A scheduled check was" : `${p.count} scheduled checks were`;
  const caught = p.caught_up ? ` ${p.caught_up === 1 ? "One ran" : `${p.caught_up} ran`} late.` : "";
  return <Event text={`${n} missed because ${why}.${caught}`} />;
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
  return <Event text={text} />;
}

/**
 * The composer. While a run works, a message steers it; while it waits for an answer, the message
 * is held (§5.7). While the Mac is offline, it is sealed at the relay and sent when the Mac is
 * back, if within 12 hours (§9.4).
 */
export function Composer({
  onSend,
  active,
  onStop,
  placeholder,
  disabled = false,
}: {
  onSend: (text: string) => Promise<boolean>;
  active: ActiveRun | null;
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const { client } = useDesktop();
  const runtime = useStore(client.runtime);
  const p = usePalette();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
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
  const hint =
    runtime.state === "offline"
      ? "Your Mac is offline. Messages will send when it's back — they expire in 12 h."
      : active?.state === "waiting_input"
        ? "Claude is waiting for your answer. A message now is held and delivered with it."
        : active
          ? "Claude is working. A message now steers the running task."
          : null;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: p.border, padding: 8, gap: 6, backgroundColor: p.card }}>
      {hint ? (
        <T muted style={s.small}>
          {hint}
        </T>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          accessibilityLabel="Message"
          multiline
          editable={!disabled}
          value={text}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          onChangeText={setText}
          style={[s.body, { flex: 1, color: p.text, maxHeight: 140, borderWidth: 1, borderColor: p.border, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }]}
        />
        {onStop ? <Button kind="danger" title="Stop" onPress={onStop} /> : null}
        <Button kind="primary" title={active && active.state !== "waiting_input" ? "Steer" : "Send"} disabled={disabled || !text.trim()} busy={busy} onPress={() => void send()} />
      </View>
    </View>
  );
}
