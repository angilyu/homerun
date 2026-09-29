import { useState, type FormEvent } from "react";
import { errorMessage } from "@homerun/app-state";
import { useApp } from "../hooks";
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
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const input = useAutofocus<HTMLInputElement>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || phase.s === "checking") return;
    setPhase({ s: "checking" });
    try {
      const r = await app.shell.setKey(value);
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
