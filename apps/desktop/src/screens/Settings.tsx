import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@homerun/app-state";
import type { HealthSettings } from "@homerun/core";
import type { CliToolStatus, LoginItemStatus, NotificationPermission, UpdateState } from "../platform/types";
import { useAction, useApp, useLoad, useStore } from "../hooks";
import { ConfirmButton, Empty, ErrorText, Page, Time } from "../ui/bits";
import { runtimeText } from "./Layout";
import { KeyForm } from "./Onboarding";

export function Settings() {
  return (
    <Page title="Settings">
      <KeySection />
      <BackgroundSection />
      <DigestSection />
      <CliSection />
      <UpdatesSection />
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
    <section aria-label="Anthropic API key">
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

/** Re-read when the window comes back: the user may have changed it in System Settings. */
function useOnFocus<T>(read: () => Promise<T>): [T | null, (v: T) => void] {
  const [v, setV] = useState<T | null>(null);
  const load = useCallback(() => void read().then(setV, () => {}), [read]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  return [v, setV];
}

/** Menu-bar residency, open at login and notifications (§5.1, §8.2). */
function BackgroundSection() {
  const app = useApp();
  const [login, setLogin] = useOnFocus<LoginItemStatus>(useCallback(() => app.shell.loginItem(), [app]));
  const [notify, setNotify] = useOnFocus<NotificationPermission>(useCallback(() => app.shell.notifications(), [app]));
  const setAtLogin = useAction(async (on: boolean) => setLogin(await app.shell.setLoginItem(on)));
  const ask = useAction(async () => setNotify(await app.shell.requestNotifications()));
  return (
    <section aria-label="Running in the background">
      <h2>Running in the background</h2>
      <p className="muted">Closing the window keeps Homerun in the menu bar, so monitors keep running. Monitors don't run while Homerun is quit.</p>
      <label className="check">
        <input
          type="checkbox"
          checked={login === "enabled" || login === "needs_approval"}
          disabled={login === null || login === "unavailable" || setAtLogin.busy}
          onChange={(e) => void setAtLogin.run(e.target.checked)}
        />
        Open Homerun when you log in
      </label>
      {login === "needs_approval" && (
        <p className="notice warn">
          Turned off in System Settings, so Homerun won't open at login.{" "}
          <button type="button" className="link" onClick={() => void app.shell.openLoginItems()}>
            Open Login Items
          </button>
        </p>
      )}
      {login === "unavailable" && <p className="muted small">Available in the installed app.</p>}
      <ErrorText error={setAtLogin.error} />
      <h3>Notifications</h3>
      <p className="muted small">Approvals, questions, monitor news and problems. They never show your data, tool input or API key, and approvals are answered here, not from a notification.</p>
      {notify === "not_determined" && (
        <button type="button" onClick={() => void ask.run()}>
          Allow notifications
        </button>
      )}
      {(notify === "allowed" || notify === "denied") && (
        <p>
          {notify === "allowed" ? "On." : "Off in System Settings."}{" "}
          <button type="button" className="link" onClick={() => void app.shell.openNotificationSettings()}>
            Notification settings
          </button>
        </p>
      )}
      {notify === "unavailable" && <p className="muted small">Available in the installed app.</p>}
      <ErrorText error={ask.error} />
    </section>
  );
}

export function updateText(u: UpdateState): string {
  switch (u.state) {
    case "idle":
      return "Homerun checks for updates every few hours.";
    case "unavailable":
      return u.message;
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "Homerun is up to date.";
    case "downloading":
      return `Downloading Homerun ${u.version}…`;
    case "ready":
      return `Homerun ${u.version} is ready. It installs when you quit Homerun.${u.note ? ` ${u.note}` : ""}`;
    case "manual":
      return `Homerun ${u.version} is available. ${u.reason}`;
    case "failed":
      return u.message;
  }
}

/** The signed updater (§11): downloads in the background, installs when Homerun quits. */
function UpdatesSection() {
  const app = useApp();
  const u = useStore(app.update);
  const prefs = useLoad(() => app.shell.prefs(), []);
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    if (prefs.data) setAuto(prefs.data.auto_download_updates);
  }, [prefs.data]);
  if (!u) return null;
  const off = u.state === "unavailable";
  return (
    <section aria-label="Updates">
      <h2>Updates</h2>
      <p role="status">{updateText(u)}</p>
      {!off && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={auto ?? true}
              onChange={(e) => {
                setAuto(e.target.checked);
                void app.shell.setAutoUpdate(e.target.checked);
              }}
            />
            Check for and download updates automatically
          </label>
          <div className="row">
            {u.state === "ready" ? (
              <button type="button" className="primary" onClick={() => void app.shell.restartToUpdate()}>
                Restart to update
              </button>
            ) : u.state === "manual" ? (
              <button type="button" onClick={() => void app.shell.openExternal(DOWNLOAD_PAGE)}>
                Download
              </button>
            ) : (
              <button type="button" disabled={u.state === "checking" || u.state === "downloading"} onClick={() => void app.shell.checkForUpdates()}>
                Check now
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export const DOWNLOAD_PAGE = "https://github.com/angilyu/homerun/releases/latest";

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
    <section aria-label="Daily summary">
      <h2>Daily summary</h2>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => void save({ ...draft, enabled: e.target.checked })} />
        Send a daily summary of how monitors did
      </label>
      <label className="field inline">
        <span className="field-name">At</span>
        <input type="time" value={draft.time} disabled={!draft.enabled} onChange={(e) => e.target.value && void save({ ...draft, time: e.target.value })} />
        <span className="muted">{draft.timezone}</span>
      </label>
      {saved && <span className="muted small">Saved.</span>}
      <ErrorText error={error} />
    </section>
  );
}

/** Command-line access (§5.2): the `homerun` link, and the clients approved from `homerun login`. */
function CliSection() {
  const app = useApp();
  const t = useLoad(() => app.client.rpc.call("cli.tokens.list", {}).then((r) => r.tokens), []);
  const revoke = useAction(async (token_id: string) => {
    await app.client.rpc.call("cli.tokens.revoke", { token_id });
    t.reload();
  });
  return (
    <section aria-label="Command-line access">
      <h2>Command-line access</h2>
      <CliTool />
      <ErrorText error={t.error ?? revoke.error} />
      {t.data && t.data.length === 0 && <Empty>No command-line clients are signed in.</Empty>}
      <ul className="plain">
        {t.data?.map((x) => (
          <li key={x.token_id}>
            {x.client.name} {x.client.version} <span className="muted">on {x.hostname}</span>{" "}
            <span className="muted">
              added <Time ts={x.created_at} />
              {x.last_used_at ? (
                <>
                  , used <Time ts={x.last_used_at} relative />
                </>
              ) : (
                ", never used"
              )}
            </span>{" "}
            <ConfirmButton label="Revoke" confirm="Sign it out? Anything it has open closes now." onConfirm={() => void revoke.run(x.token_id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const PATH_HINT = 'export PATH="$HOME/.local/bin:$PATH"';

/** A symlink in ~/.local/bin to the CLI inside this app; no admin rights (§5.2). */
function CliTool() {
  const app = useApp();
  const [s, setS] = useOnFocus<CliToolStatus>(useCallback(() => app.shell.cliTool(), [app]));
  const install = useAction(async () => setS(await app.shell.installCliTool()));
  const remove = useAction(async () => setS(await app.shell.removeCliTool()));
  const busy = install.busy || remove.busy;
  const installButton = (label: string) => (
    <button type="button" disabled={busy} onClick={() => void install.run()}>
      {label}
    </button>
  );
  if (!s) return null;
  return (
    <div aria-label="Command-line tool" role="group">
      {s.state === "unavailable" && <p className="muted">{s.reason}</p>}
      {s.state === "not_installed" && (
        <p>
          Use <code>homerun</code> in Terminal to ask about your tasks and monitors. {installButton("Install command-line tool")}
        </p>
      )}
      {s.state === "installed" && (
        <>
          <p>
            Installed at <code>{s.link}</code>.{" "}
            <button type="button" disabled={busy} onClick={() => void remove.run()}>
              Remove
            </button>
          </p>
          <p className="muted small">
            If Terminal says <code>command not found</code>, add this line to <code>~/.zshrc</code>: <code>{PATH_HINT}</code>
          </p>
        </>
      )}
      {s.state === "other_copy" && (
        <p>
          <code>{s.link}</code> points to another copy of Homerun (<code>{s.target}</code>). {installButton("Use this copy")}
        </p>
      )}
      {s.state === "dangling" && (
        <p>
          <code>{s.link}</code> points to a copy of Homerun that has moved or been deleted. {installButton("Repair")}
        </p>
      )}
      {s.state === "foreign" && (
        <p className="muted">
          Something else is already at <code>{s.link}</code>, so Homerun leaves it alone.
        </p>
      )}
      <ErrorText error={install.error ?? remove.error} />
    </div>
  );
}

function RuntimeSection() {
  const app = useApp();
  const s = useStore(app.client.runtime);
  const info = useLoad(() => app.shell.appInfo(), []);
  const restart = useAction(() => app.shell.restartRuntime());
  const logs = useAction(() => app.shell.revealLogs());
  return (
    <section aria-label="Homerun">
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
