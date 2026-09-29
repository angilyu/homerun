import { useEffect } from "react";
import { digestLines, downtimeText, lastDay, usd } from "@homerun/app-state";
import { useApp, useLoad } from "../hooks";
import { Badge, Empty, ErrorText, Page, Time } from "../ui/bits";

/** How monitors did in the last 24 hours, and when the Mac was asleep or Homerun wasn't running (§8.3, §8.4). */
export function Health() {
  const app = useApp();
  const d = useLoad(() => {
    const r = lastDay(Date.now());
    return app.client.rpc.call("health.digest", r).then((x) => x.digest);
  }, [], 60_000);
  // The pushed daily digest is read once this screen is open.
  useEffect(() => app.client.digest.set(null), [app]);
  const digest = d.data;
  return (
    <Page title="Health" sub="The last 24 hours.">
      <ErrorText error={d.error} />
      {digest && (
        <>
          {digest.monitors.length === 0 ? (
            <Empty>No monitors yet.</Empty>
          ) : (
            <ul className="cards">
              {digestLines(digest).map((l) => (
                <li key={l.task_id}>
                  <button type="button" className="card row-card" onClick={() => app.go({ name: "task", task_id: l.task_id })}>
                    <strong>
                      {l.name} {l.attention && <Badge tone="warn">Needs attention</Badge>}
                    </strong>
                    <span className="muted">{l.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2>Downtime</h2>
          {digest.downtime.length === 0 ? (
            <Empty>This Mac was awake and Homerun was running the whole time.</Empty>
          ) : (
            <ul className="plain">
              {digest.downtime.map((x, i) => (
                <li key={i}>{downtimeText(x, digest.timezone)}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            Spent {usd(digest.cost_usd)} on monitors. Updated <Time ts={digest.generated_at} relative />.
          </p>
        </>
      )}
    </Page>
  );
}
