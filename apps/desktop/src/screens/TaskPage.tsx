import { useState } from "react";
import {
  COVERAGE_DAYS,
  activeGrants,
  coverageRange,
  errorMessage,
  grantText,
  inTime,
  isConflict,
  scheduleStateText,
  scheduleText,
  summarizeCoverage,
  usd,
  type CoverageSummary,
} from "@homerun/app-state";
import type { MonitorState, Run, Task, ToolGrant } from "@homerun/core";
import { useAction, useApp, useLoad, useNow, useStore } from "../hooks";
import { Badge, ConfirmButton, Empty, ErrorText, Fold, Page, Time } from "../ui/bits";
import { threadTitle } from "./Layout";

/** A task or monitor: what it is, its chats, runs and grants (§2.1, §5.6, §8). */
export function TaskPage({ task_id }: { task_id: string }) {
  const app = useApp();
  const task = useLoad(() => app.client.rpc.call("tasks.get", { task_id }).then((r) => r.task), [task_id]);
  const t = task.data;
  if (!t) return <Page title="Task">{task.error ? <ErrorText error={task.error} /> : <p aria-busy="true">Loading…</p>}</Page>;
  const monitor = t.kind === "monitor";
  return (
    <Page
      title={t.name}
      sub={monitor ? "Monitor" : "Task"}
      actions={
        t.archived_at ? (
          <Badge>Archived</Badge>
        ) : (
          <>
            {!monitor && (
              <button type="button" className="primary" onClick={() => app.go({ name: "new_chat", task_id })}>
                New chat
              </button>
            )}
            <button type="button" onClick={() => app.go({ name: "task_edit", task_id })}>
              Edit
            </button>
            <ConfirmButton
              label="Archive"
              danger
              confirm={monitor ? "Stop checking and archive?" : "Archive this task?"}
              onConfirm={() => void app.client.tasks.archive(task_id).then(() => app.go({ name: "tasks" }), () => task.reload())}
            />
          </>
        )
      }
    >
      <ErrorText error={task.error} />
      {monitor && <MonitorSection task={t} />}
      {!monitor && (
        <section>
          <h2>Instructions</h2>
          <Fold text={t.spec.prompt} lines={6} className="prose" />
        </section>
      )}
      <TaskThreads task_id={task_id} />
      <Runs task_id={task_id} monitor={monitor} />
      <Grants task_id={task_id} />
      {monitor && <StateSection task_id={task_id} />}
    </Page>
  );
}

function MonitorSection({ task }: { task: Task }) {
  const app = useApp();
  const tasks = useStore(app.client.tasks.store);
  const now = useNow();
  const row = tasks.rows.find((r) => r.task.task_id === task.task_id);
  const s = row?.schedule ?? null;
  const toggle = useAction((id: string, on: boolean) => app.client.tasks.setEnabled(id, on));
  const runNow = useAction(async () => {
    const r = await app.client.tasks.runNow(task.task_id);
    app.go({ name: "thread", thread_id: r.thread_id });
  });
  useLoad(() => app.client.tasks.refresh(), [task.task_id], 30_000);
  return (
    <section>
      <h2>Schedule</h2>
      {s ? (
        <div className="kv">
          <p>
            {scheduleText(s.schedule)} · <Badge tone={s.enabled ? "ok" : "warn"}>{scheduleStateText(s)}</Badge>
          </p>
          <p>
            {s.enabled && s.next_fire_at ? (
              <>
                Next check {inTime(s.next_fire_at, now)} (<Time ts={s.next_fire_at} />)
              </>
            ) : (
              "No check scheduled."
            )}
            {s.last_fired_at && (
              <>
                {" "}
                Last <Time ts={s.last_fired_at} relative />.
              </>
            )}
          </p>
          {s.missed_since_last_run > 0 && <p className="warn-text">{s.missed_since_last_run} missed since the last check that ran.</p>}
          <div className="row">
            <button type="button" disabled={toggle.busy} onClick={() => void toggle.run(s.schedule_id, !s.enabled)}>
              {s.enabled ? "Pause" : "Resume"}
            </button>
            <button type="button" disabled={runNow.busy} onClick={() => void runNow.run()}>
              Check now
            </button>
          </div>
          <ErrorText error={toggle.error ?? runNow.error} />
        </div>
      ) : (
        <p className="muted">Loading the schedule…</p>
      )}
      <Coverage task={task} />
    </section>
  );
}

/** Scheduled vs ran, per day, and why the rest didn't (§8.4: be upfront about sleep). */
export function Coverage({ task }: { task: Task }) {
  const app = useApp();
  const zone = task.spec.kind === "monitor" && task.spec.schedule.kind === "cron" ? task.spec.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cov = useLoad(async () => {
    const range = coverageRange(zone, Date.now());
    const r = await app.client.rpc.call("schedules.coverage", { task_id: task.task_id, from_day: range.from_day, to_day: range.to_day });
    return summarizeCoverage(r.days, range.days);
  }, [task.task_id, zone], 60_000);
  if (!cov.data) return <ErrorText error={cov.error} />;
  return <CoverageView c={cov.data} />;
}

export function CoverageView({ c }: { c: CoverageSummary }) {
  const max = Math.max(1, ...c.days.map((d) => d.expected));
  return (
    <div className="coverage">
      <h3>Last {COVERAGE_DAYS} days</h3>
      <ol className="bars" aria-label="Checks per day">
        {c.days.map((d) => (
          <li key={d.day} title={`${d.day}: ran ${d.ran} of ${d.expected}; asleep ${d.asleep}; not running ${d.not_running}; merged ${d.merged}`}>
            <span className="bar" style={{ height: `${(d.expected / max) * 100}%` }}>
              <span className="seg ran" style={{ flexGrow: d.ran }} />
              <span className="seg asleep" style={{ flexGrow: d.asleep }} />
              <span className="seg not-running" style={{ flexGrow: d.not_running }} />
              <span className="seg merged" style={{ flexGrow: d.merged }} />
              <span className="seg other" style={{ flexGrow: d.other }} />
            </span>
            <span className="day">{new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
          </li>
        ))}
      </ol>
      <p className="legend">
        <span className="key ran" /> ran <span className="key asleep" /> Mac asleep <span className="key not-running" /> Homerun not running <span className="key merged" /> merged
      </p>
      <p>{c.sentence}</p>
      {c.low && (
        <p className="notice info">
          Checks only run while this Mac is awake. To run more of them, turn on “Prevent automatic sleeping when the display is off” in System Settings → Energy (it
          needs power), or run Homerun on a Mac that stays on.
        </p>
      )}
    </div>
  );
}

function TaskThreads({ task_id }: { task_id: string }) {
  const app = useApp();
  const list = useStore(app.client.threads.store);
  const threads = list.threads.filter((t) => t.task_id === task_id);
  return (
    <section>
      <h2>Chats</h2>
      {threads.length === 0 ? (
        <Empty>No chats yet.</Empty>
      ) : (
        <ul className="plain">
          {threads.map((t) => (
            <li key={t.thread_id}>
              <button type="button" className="link" onClick={() => app.go({ name: "thread", thread_id: t.thread_id })}>
                {threadTitle(t)}
              </button>{" "}
              <span className="muted">
                <Time ts={t.updated_at} relative />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Runs({ task_id, monitor }: { task_id: string; monitor: boolean }) {
  const app = useApp();
  const runs = useLoad(() => app.client.rpc.call("runs.list", { task_id, limit: 20 }).then((r) => r.runs), [task_id], 30_000);
  return (
    <section>
      <h2>Recent runs</h2>
      <ErrorText error={runs.error} />
      {runs.data && runs.data.length === 0 && <Empty>No runs yet.</Empty>}
      <ul className="runs">
        {runs.data?.map((r) => (
          <RunRow key={r.run_id} run={r} monitor={monitor} />
        ))}
      </ul>
    </section>
  );
}

const RUN_TONE: Record<string, "ok" | "warn" | "danger" | "plain" | "info"> = { succeeded: "ok", failed: "danger", abandoned: "danger", cancelled: "plain", running: "info", pending: "info", waiting_input: "warn" };

function RunRow({ run, monitor }: { run: Run; monitor: boolean }) {
  const app = useApp();
  const label = run.state === "succeeded" && monitor ? (run.outcome === "changed" ? "changed" : "no change") : run.state.replace("_", " ");
  return (
    <li>
      <button type="button" className="link" onClick={() => app.go({ name: "thread", thread_id: run.thread_id })}>
        <Time ts={run.started_at ?? run.scheduled_for ?? 0} />
      </button>{" "}
      <Badge tone={run.outcome === "changed" ? "info" : (RUN_TONE[run.state] ?? "plain")}>{label}</Badge> <span className="muted">{run.trigger === "catchup" ? "catch-up" : run.trigger}</span>
      {run.cost_usd !== null && <span className="muted"> · {usd(run.cost_usd)}</span>}
      {run.error && <p className="error small">{run.error.message}</p>}
      {run.check_result && (
        <details>
          <summary>Evidence</summary>
          <Fold text={run.check_result.evidence} lines={6} />
        </details>
      )}
    </li>
  );
}

/** The task's "Always allow" grants (§5.6), each revocable. */
function Grants({ task_id }: { task_id: string }) {
  const app = useApp();
  const grants = useLoad(() => app.client.rpc.call("grants.list", { task_id }).then((r) => r.grants), [task_id]);
  const revoke = useAction(async (g: ToolGrant) => {
    await app.client.rpc.call("grants.revoke", { grant_id: g.grant_id });
    grants.reload();
  });
  const list = grants.data ? activeGrants(grants.data) : [];
  return (
    <section>
      <h2>Always allowed</h2>
      <ErrorText error={grants.error ?? revoke.error} />
      {grants.data && list.length === 0 && <Empty>Nothing yet. Choosing “Always allow” on an approval adds it here.</Empty>}
      <ul className="grants">
        {list.map((g) => (
          <li key={g.grant_id}>
            <code>{grantText(g)}</code>{" "}
            <span className="muted">
              since <Time ts={g.granted_at} />
            </span>{" "}
            <ConfirmButton label="Revoke" confirm="Ask again next time?" onConfirm={() => void revoke.run(g)} disabled={revoke.busy} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the monitor remembers between checks (§8.3): view, edit, or reset. */
function StateSection({ task_id }: { task_id: string }) {
  const app = useApp();
  const st = useLoad(() => app.client.rpc.call("monitors.state.get", { task_id }).then((r) => r.state), [task_id]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s: MonitorState | null = st.data ?? null;
  const onErr = (e: unknown) => setError(isConflict(e) ? "It changed while you were editing (a check ran). Reload and try again." : errorMessage(e));
  return (
    <section>
      <h2>Remembered state</h2>
      <ErrorText error={st.error ?? error} />
      {!s && st.data === null && <Empty>Nothing yet: the first check records it.</Empty>}
      {s && editing === null && (
        <>
          <Fold text={JSON.stringify(s.state, null, 2)} lines={10} />
          <p className="muted small">
            Updated <Time ts={s.updated_at} relative />
          </p>
          <div className="row">
            <button type="button" onClick={() => setEditing(JSON.stringify(s.state, null, 2))}>
              Edit
            </button>
            <ConfirmButton
              label="Reset"
              danger
              confirm="Forget it? The next check starts fresh."
              onConfirm={() =>
                void app.client.rpc
                  .call("monitors.state.reset", { task_id, expected_version: s.version })
                  .then(() => st.reload(), onErr)
              }
            />
          </div>
        </>
      )}
      {s && editing !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            let v: unknown;
            try {
              v = JSON.parse(editing);
            } catch (err) {
              return setError(`Not valid JSON: ${errorMessage(err)}`);
            }
            setError(null);
            void app.client.rpc
              .call("monitors.state.set", { task_id, state: v as never, expected_version: s.version })
              .then(() => {
                setEditing(null);
                st.reload();
              }, onErr);
          }}
        >
          <textarea className="mono" rows={10} aria-label="State JSON" value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck={false} />
          <div className="row">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
