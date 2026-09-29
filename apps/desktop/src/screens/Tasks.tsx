import { inTime, scheduleStateText, scheduleText, type TaskRow } from "@homerun/app-state";
import { useApp, useLoad, useNow, useStore } from "../hooks";
import { Badge, Empty, ErrorText, Page } from "../ui/bits";

/** Tasks and monitors (§2.1, §8): the list, with each monitor's next check. */
export function Tasks() {
  const app = useApp();
  const tasks = useStore(app.client.tasks.store);
  const now = useNow();
  // No change notification for tasks (plan Q10): refresh while visible.
  useLoad(() => app.client.tasks.refresh(), [], 30_000);
  const sessions = tasks.rows.filter((r) => r.task.kind === "session" && !r.task.archived_at);
  const monitors = tasks.rows.filter((r) => r.task.kind === "monitor" && !r.task.archived_at);
  return (
    <Page
      title="Tasks"
      actions={
        <>
          <button type="button" onClick={() => app.go({ name: "task_edit", kind: "session" })}>
            New task
          </button>
          <button type="button" className="primary" onClick={() => app.go({ name: "task_edit", kind: "monitor" })}>
            New monitor
          </button>
        </>
      }
    >
      <ErrorText error={tasks.error} />
      <h2>Monitors</h2>
      {tasks.loaded && monitors.length === 0 && <Empty>No monitors. A monitor checks something on a schedule and tells you when it changes.</Empty>}
      <ul className="cards">
        {monitors.map((r) => (
          <Row key={r.task.task_id} row={r} now={now} />
        ))}
      </ul>
      <h2>Tasks</h2>
      {tasks.loaded && sessions.length === 0 && <Empty>No tasks. Save a chat as a task to reuse its instructions, tools and grants.</Empty>}
      <ul className="cards">
        {sessions.map((r) => (
          <Row key={r.task.task_id} row={r} now={now} />
        ))}
      </ul>
    </Page>
  );
}

function Row({ row, now }: { row: TaskRow; now: number }) {
  const app = useApp();
  const s = row.schedule;
  return (
    <li>
      <button type="button" className="card row-card" onClick={() => app.go({ name: "task", task_id: row.task.task_id })}>
        <strong>{row.task.name}</strong>
        {s ? (
          <span className="muted">
            {scheduleText(s.schedule)} · {s.enabled ? (s.next_fire_at ? `next ${inTime(s.next_fire_at, now)}` : "no next check") : <Badge tone="warn">{scheduleStateText(s)}</Badge>}
          </span>
        ) : (
          <span className="muted">{row.task.spec.prompt.slice(0, 100)}</span>
        )}
      </button>
    </li>
  );
}
