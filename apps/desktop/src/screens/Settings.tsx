import { useEffect, useState } from "react";
import { errorMessage } from "@homerun/app-state";
import type { HealthSettings } from "@homerun/core";
import { useAction, useApp, useLoad, useStore } from "../hooks";
import { ConfirmButton, Empty, ErrorText, Page, Time } from "../ui/bits";
import { runtimeText } from "./Layout";
import { KeyForm } from "./Onboarding";

export function Settings() {
  return (
    <Page title="Settings">
      <KeySection />
      <DigestSection />
      <CliSection />
      <RuntimeSection />
    </Page>
  );
}

/** The API key lives in the keychain; the shell hands it to the runtime (§7.2, §18 row 7). */
function KeySection() {
  const app = useApp();
  const key = useStore(app.key);
  const [replacing, setReplacing] = useState(false);
  const clear = useAction(async () => {
    await app.shell.clearKey();
    await app.refreshKey();
  });
  return (
    <section>
      <h2>Anthropic API key</h2>
      {key?.present ? (
        <p>
          Connected: <code>…{key.hint}</code> <span className="muted">(stored in {key.store})</span>
        </p>
      ) : (
        <p>No key connected.</p>
      )}
      {replacing || !key?.present ? (
        <KeyForm submitLabel={key?.present ? "Replace key" : "Connect"} onDone={() => setReplacing(false)} />
      ) : (
        <div className="row">
          <button type="button" onClick={() => setReplacing(true)}>
            Replace key
          </button>
          <ConfirmButton label="Remove key" danger confirm="Remove it? Chats and monitors stop until you add one." onConfirm={() => void clear.run()} />
        </div>
      )}
      <ErrorText error={clear.error} />
    </section>
  );
}

/** The daily health summary (§8.3). */
function DigestSection() {
  const app = useApp();
  const s = useLoad(() => app.client.rpc.call("health.settings.get", {}).then((r) => r.settings), []);
  const [draft, setDraft] = useState<HealthSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (s.data) setDraft(s.data);
  }, [s.data]);
  if (!draft) return <ErrorText error={s.error} />;
  const save = async (next: HealthSettings) => {
    setDraft(next);
    setError(null);
    setSaved(false);
    try {
      const r = await app.client.rpc.call("health.settings.set", { settings: next });
      setDraft(r.settings);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section>
      <h2>Daily summary</h2>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => void save({ ...draft, enabled: e.target.checked })} />
        Send a daily summary of how monitors did
      </label>
      <label className="field inline">
        <span>At</span>
        <input type="time" value={draft.time} disabled={!draft.enabled} onChange={(e) => e.target.value && void save({ ...draft, time: e.target.value })} />
        <span className="muted">{draft.timezone}</span>
      </label>
      {saved && <span className="muted small">Saved.</span>}
      <ErrorText error={error} />
    </section>
  );
}

/** Command-line access (§5.2): tokens approved from `homerun login`. */
function CliSection() {
  const app = useApp();
  const t = useLoad(() => app.client.rpc.call("cli.tokens.list", {}).then((r) => r.tokens), []);
  const revoke = useAction(async (token_id: string) => {
    await app.client.rpc.call("cli.tokens.revoke", { token_id });
    t.reload();
  });
  return (
    <section>
      <h2>Command-line access</h2>
      <ErrorText error={t.error ?? revoke.error} />
      {t.data && t.data.length === 0 && <Empty>No command-line clients are signed in.</Empty>}
      <ul className="plain">
        {t.data?.map((x) => (
          <li key={x.token_id}>
            {x.client.name} {x.client.version}{" "}
            <span className="muted">
              added <Time ts={x.created_at} />
              {x.last_used_at && (
                <>
                  , used <Time ts={x.last_used_at} relative />
                </>
              )}
            </span>{" "}
            <ConfirmButton label="Revoke" confirm="Sign it out?" onConfirm={() => void revoke.run(x.token_id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RuntimeSection() {
  const app = useApp();
  const s = useStore(app.client.runtime);
  const info = useLoad(() => app.shell.appInfo(), []);
  const restart = useAction(() => app.shell.restartRuntime());
  const logs = useAction(() => app.shell.revealLogs());
  return (
    <section>
      <h2>Homerun</h2>
      <p>{s.state === "ready" ? `Running (runtime ${s.runtime_version}).` : runtimeText(s, Date.now())}</p>
      <div className="row">
        <ConfirmButton label="Restart Homerun" confirm="Running chats resume after the restart." onConfirm={() => void restart.run()} />
        <button type="button" onClick={() => void logs.run()}>
          Show logs
        </button>
      </div>
      <ErrorText error={restart.error ?? logs.error} />
      {info.data && (
        <dl className="about">
          <dt>Version</dt>
          <dd>
            {info.data.version} ({info.data.build})
          </dd>
          <dt>Data</dt>
          <dd>
            <code>{info.data.data_dir}</code>
          </dd>
          <dt>Key storage</dt>
          <dd>{info.data.key_store}</dd>
        </dl>
      )}
    </section>
  );
}
