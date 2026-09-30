import { groupThreads, oneLine, type RuntimeStatus } from "@homerun/app-state";
import type { ThreadSummary } from "@homerun/core";
import { useApp, useNow, useStore, type Route } from "../hooks";
import { Time } from "../ui/bits";
import { useState } from "react";
import { Health } from "./Health";
import { Inbox } from "./Inbox";
import { DOWNLOAD_PAGE, Settings } from "./Settings";
import { TaskEditor } from "./TaskEditor";
import { TaskPage } from "./TaskPage";
import { Tasks } from "./Tasks";
import { NewChat, Thread } from "./Thread";

export function Layout({ keyError }: { keyError: string | null }) {
  const app = useApp();
  const route = useStore(app.route);
  return (
    <div className="layout">
      <Sidebar route={route} />
      <main className="main">
        <RuntimeBanner />
        <KeyBanner error={keyError} />
        <UpdateBanner />
        <Screen route={route} />
      </main>
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
    case "new_chat":
      return <NewChat key={route.name === "new_chat" ? (route.task_id ?? "") : "home"} task_id={route.name === "new_chat" ? route.task_id : undefined} />;
    case "thread":
      return <Thread key={route.thread_id} thread_id={route.thread_id} />;
    case "inbox":
      return <Inbox />;
    case "tasks":
      return <Tasks />;
    case "task":
      return <TaskPage key={route.task_id} task_id={route.task_id} />;
    case "task_edit":
      return <TaskEditor key={route.task_id ?? `new-${route.kind}`} task_id={route.task_id} kind={route.kind} from_thread_id={route.from_thread_id} />;
    case "health":
      return <Health />;
    case "settings":
      return <Settings />;
  }
}

function Sidebar({ route }: { route: Route }) {
  const app = useApp();
  const list = useStore(app.client.threads.store);
  const inbox = useStore(app.client.inbox.store);
  const tasks = useStore(app.client.tasks.store);
  const g = groupThreads(list.threads);
  const taskName = new Map(tasks.rows.map((r) => [r.task.task_id as string, r.task.name]));
  const active = route.name === "thread" ? route.thread_id : null;
  const nav = (name: "inbox" | "tasks" | "health" | "settings", label: string, count?: number) => (
    <li>
      <button type="button" className="nav" aria-current={route.name === name || (name === "tasks" && (route.name === "task" || route.name === "task_edit")) ? "page" : undefined} onClick={() => app.go({ name })}>
        {label}
        {count ? <span className="count" aria-label={`${count} waiting`}>{count}</span> : null}
      </button>
    </li>
  );
  return (
    <nav className="sidebar" aria-label="Threads and sections">
      <div className="sidebar-top">
        <button type="button" className="primary new-chat" onClick={() => app.go({ name: "new_chat" })}>
          New chat
        </button>
      </div>
      <ul className="navlist">
        {nav("inbox", "Inbox", inbox.entries.length)}
        {nav("tasks", "Tasks")}
        {nav("health", "Health")}
        {nav("settings", "Settings")}
      </ul>
      <div className="threads">
        <Group title="Needs you" threads={g.needs_you} active={active} taskName={taskName} />
        <Group title="Running" threads={g.running} active={active} taskName={taskName} />
        <Group title="Recent" threads={g.recent} active={active} taskName={taskName} />
        {list.loaded && list.threads.length === 0 && <p className="empty small">No chats yet.</p>}
        {list.error && <p className="error small">{list.error}</p>}
        {list.has_more && (
          <button type="button" className="link" onClick={() => void app.client.threads.loadMore()}>
            Older chats
          </button>
        )}
      </div>
    </nav>
  );
}

function Group({ title, threads, active, taskName }: { title: string; threads: ThreadSummary[]; active: string | null; taskName: Map<string, string> }) {
  const app = useApp();
  if (threads.length === 0) return null;
  return (
    <section className="group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {threads.map((t) => (
          <li key={t.thread_id}>
            <button type="button" className="thread-row" aria-current={t.thread_id === active ? "page" : undefined} onClick={() => app.go({ name: "thread", thread_id: t.thread_id })}>
              <span className="title">
                {t.unread_count > 0 && t.thread_id !== active && <span className="dot" aria-label="unread" />}
                {threadTitle(t, taskName)}
              </span>
              <span className="meta">
                {t.task_id && taskName.get(t.task_id) && t.title ? <span className="task">{taskName.get(t.task_id)}</span> : null}
                <Time ts={t.updated_at} relative />
              </span>
              {t.last_message && <span className="preview">{oneLine(t.last_message.preview)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function threadTitle(t: ThreadSummary | undefined, taskName?: Map<string, string>): string {
  if (!t) return "Chat";
  if (t.title) return t.title;
  if (t.task_id && taskName?.get(t.task_id)) return taskName.get(t.task_id)!;
  if (t.last_message) return oneLine(t.last_message.preview).slice(0, 60) || "New chat";
  return "New chat";
}

/** The runtime's state when it isn't simply running (§5.1). Chat is read-only meanwhile. */
export function RuntimeBanner() {
  const app = useApp();
  const s = useStore(app.client.runtime);
  // The tick re-renders the countdown; a status change renders at once, so count from now,
  // not from the last tick, which can be up to a second old.
  useNow(1000);
  const text = runtimeText(s, Date.now());
  if (!text) return null;
  const canRestart = s.state === "crash_loop" || s.state === "blocked" || s.state === "restarting";
  return (
    <div className={`banner ${s.state === "blocked" || s.state === "crash_loop" ? "danger" : "warn"}`} role="status" aria-live="polite">
      <span>{text}</span>
      <span className="actions">
        {canRestart && (
          <button type="button" onClick={() => void app.shell.restartRuntime().catch(() => {})}>
            Restart now
          </button>
        )}
        {(s.state === "crash_loop" || s.state === "blocked") && (
          <button type="button" onClick={() => void app.shell.revealLogs().catch(() => {})}>
            Show logs
          </button>
        )}
      </span>
    </div>
  );
}

export function runtimeText(s: RuntimeStatus, now: number): string | null {
  switch (s.state) {
    case "ready":
      return null;
    case "starting":
      return "Starting Homerun…";
    case "stopping":
      return "Homerun is stopping…";
    case "restarting": {
      const at = s.retry_at && s.retry_at > now ? ` Retrying in ${Math.ceil((s.retry_at - now) / 1000)} s.` : "";
      return `Homerun stopped unexpectedly and is restarting.${at}`;
    }
    case "crash_loop": {
      const at = s.retry_at && s.retry_at > now ? ` Next try in ${Math.ceil((s.retry_at - now) / 1000)} s.` : "";
      return `Homerun keeps stopping${s.last_error ? `: ${oneLine(s.last_error)}` : "."}${at}`;
    }
    case "blocked":
      return s.message;
  }
}

/** An update is downloaded (§11): it installs on quit, or now. */
function UpdateBanner() {
  const app = useApp();
  const u = useStore(app.update);
  const route = useStore(app.route);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!u || route.name === "settings") return null;
  if (u.state === "ready" && hidden !== u.version)
    return (
      <div className="banner info" role="status">
        <span>
          Homerun {u.version} is ready. It installs when you quit Homerun.{u.note ? ` ${u.note}` : ""}
        </span>
        <span className="actions">
          <button type="button" className="primary" onClick={() => void app.shell.restartToUpdate().catch(() => {})}>
            Restart now
          </button>
          <button type="button" onClick={() => setHidden(u.version)}>
            Later
          </button>
        </span>
      </div>
    );
  if (u.state === "manual" && hidden !== u.version)
    return (
      <div className="banner warn" role="status">
        <span>
          Homerun {u.version} is available. {u.reason}
        </span>
        <span className="actions">
          <button type="button" onClick={() => void app.shell.openExternal(DOWNLOAD_PAGE).catch(() => {})}>
            Download
          </button>
          <button type="button" onClick={() => setHidden(u.version)}>
            Later
          </button>
        </span>
      </div>
    );
  return null;
}

function KeyBanner({ error }: { error: string | null }) {
  const app = useApp();
  const key = useStore(app.key);
  const route = useStore(app.route);
  if (route.name === "settings") return null;
  if (error) return <div className="banner warn" role="status">Couldn't read the API key: {error}</div>;
  if (key && !key.present)
    return (
      <div className="banner warn" role="status">
        <span>No API key connected. Chats and tasks can't run until you add one.</span>
        <button type="button" onClick={() => app.go({ name: "settings" })}>
          Connect a key
        </button>
      </div>
    );
  return null;
}
