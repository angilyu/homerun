import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "@homerun/app-state";
import { useApp, useShell } from "../hooks";
import type { LoginItemStatus, NotificationPermission } from "../platform/types";
import { useAutofocus } from "../ui/bits";

const CONSOLE_URL = "https://console.anthropic.com/settings/keys";

type Phase = { s: "idle" } | { s: "checking" } | { s: "rejected"; detail: string } | { s: "unverified"; detail: string } | { s: "error"; detail: string };

/**
 * Connect an Anthropic API key (§7.2). The shell checks it with Anthropic (`secrets.verify`, no
 * token cost), stores it in the keychain, and hands it to the runtime; the webview never keeps it.
 */
export function Onboarding({ onSkip }: { onSkip?: () => void }) {
  return (
    <main className="center">
      <div className="card narrow onboarding">
        <p className="brand">Homerun, powered by Claude</p>
        <h1>Connect your Anthropic API key</h1>
        <p>
          Homerun runs Claude on this Mac with your own key. Create one in the{" "}
          <a href={CONSOLE_URL}>Anthropic Console</a>, then paste it here.
        </p>
        <KeyForm submitLabel="Connect" />
        {onSkip && (
          <button type="button" className="link skip" onClick={onSkip}>
            Skip for now
          </button>
        )}
      </div>
    </main>
  );
}

/** The key field, shared by onboarding and Settings → Replace key. */
export function KeyForm({ submitLabel, onDone }: { submitLabel: string; onDone?: () => void }) {
  const app = useApp();
  const shell = useShell();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const input = useAutofocus<HTMLInputElement>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || phase.s === "checking") return;
    setPhase({ s: "checking" });
    try {
      const r = await shell.setKey(value);
      if (r.outcome === "rejected") return setPhase({ s: "rejected", detail: r.detail });
      setValue("");
      if (r.outcome === "saved_unverified") return setPhase({ s: "unverified", detail: r.detail });
      await app.refreshKey();
      onDone?.();
    } catch (err) {
      setPhase({ s: "error", detail: errorMessage(err) });
    }
  };

  if (phase.s === "unverified")
    return (
      <div className="notice warn" role="status">
        <p>Saved, but not checked: {phase.detail} Homerun will use it once Anthropic can be reached.</p>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            await app.refreshKey().catch(() => {});
            onDone?.();
          }}
        >
          Continue
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} className="key-form">
      <label htmlFor="api-key">API key</label>
      <div className="row">
        <input
          id="api-key"
          ref={input}
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (phase.s !== "checking") setPhase({ s: "idle" });
          }}
          aria-invalid={phase.s === "rejected" || undefined}
          aria-describedby="key-help"
        />
        <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>
          {show ? "Hide" : "Show"}
        </button>
      </div>
      {phase.s === "rejected" && (
        <p className="error" role="alert">
          Anthropic didn't accept this key. {phase.detail !== "Anthropic didn't accept this key." ? phase.detail : "Check that you copied all of it."}
        </p>
      )}
      {phase.s === "error" && (
        <p className="error" role="alert">
          {phase.detail}
        </p>
      )}
      <p id="key-help" className="help">
        Stored in your macOS Keychain and sent only to Anthropic.
      </p>
      <button type="submit" className="primary" disabled={!value.trim() || phase.s === "checking"}>
        {phase.s === "checking" ? "Checking…" : submitLabel}
      </button>
    </form>
  );
}

/**
 * Shown once after the key (§5.1, plan Q2): Homerun stays in the menu bar when the window
 * closes, opens at login (pre-checked, so it is the user's choice), and asks for notifications
 * so approvals and monitor news reach them (§8.2).
 */
export function KeepRunning({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const shell = useShell();
  const [login, setLogin] = useState<LoginItemStatus | null>(null);
  const [atLogin, setAtLogin] = useState(true);
  const [notify, setNotify] = useState<NotificationPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    shell.loginItem().then(setLogin, () => setLogin("unavailable"));
    shell.notifications().then(setNotify, () => setNotify("unavailable"));
  }, [app]);

  const done = async () => {
    await shell.keepRunningDone().catch(() => {});
    onDone();
  };
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (login && login !== "unavailable" && atLogin !== (login === "enabled")) await shell.setLoginItem(atLogin);
    } catch (e) {
      setBusy(false);
      return setError(`${errorMessage(e)} You can change this later in Settings.`);
    }
    await done();
  };

  return (
    <main className="center">
      <div className="card narrow onboarding">
        <h1>Keep Homerun running</h1>
        <p>When you close the window, Homerun stays in the menu bar so your monitors keep running. Quit it from the menu bar. Monitors don't run while Homerun is quit.</p>
        {login !== null && login !== "unavailable" && (
          <label className="check">
            <input type="checkbox" checked={atLogin} onChange={(e) => setAtLogin(e.target.checked)} />
            Open Homerun when you log in
          </label>
        )}
        {notify === "not_determined" && (
          <div className="row">
            <button type="button" onClick={() => void shell.requestNotifications().then(setNotify, () => {})}>
              Allow notifications
            </button>
            <span className="muted small">For approvals, questions and monitor news. Never your data or API key.</span>
          </div>
        )}
        {notify === "allowed" && <p className="muted small">Notifications are on.</p>}
        {notify === "denied" && <p className="muted small">Notifications are off. You can turn them on in System Settings.</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="primary" disabled={busy} onClick={() => void (error ? done() : finish())}>
          Continue
        </button>
      </div>
    </main>
  );
}
