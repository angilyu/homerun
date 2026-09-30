import { useEffect, useState } from "react";
import { errorMessage } from "@homerun/app-state";
import { routeFor, useApp, useStore } from "../hooks";
import { isKeychainApproval } from "../platform/types";
import { Layout } from "./Layout";
import { KeepRunning, Onboarding } from "./Onboarding";

/**
 * First run shows onboarding until a key is connected or skipped (§7.2), then, once, how Homerun
 * keeps running (§5.1); then the app. Shell events (notification clicks, the updater) are
 * handled here for the window's lifetime.
 */
export function Root() {
  const app = useApp();
  const key = useStore(app.key);
  const [error, setError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState(false);
  const [keepRunning, setKeepRunning] = useState<boolean | null>(null);

  const load = () => {
    setError(null);
    app.refreshKey().catch(setError);
  };
  useEffect(load, [app]);
  useEffect(() => {
    const off = app.shell.onEvent((e) => {
      if (e.type === "navigate") app.go(routeFor(e.target));
      else app.update.set(e.state);
    });
    app.shell.updateStatus().then((s) => app.update.get() ?? app.update.set(s), () => {});
    app.shell.prefs().then(
      (p) => setKeepRunning(!p.keep_running_asked),
      () => setKeepRunning(false),
    );
    return off;
  }, [app]);

  if (error && isKeychainApproval(error)) return <KeychainWait onRetry={load} />;
  if ((!key && !error) || keepRunning === null) return <div className="splash" aria-busy="true" />;
  if (key && !key.present && !skipped) return <Onboarding onSkip={() => setSkipped(true)} />;
  if (keepRunning && key?.present) return <KeepRunning onDone={() => setKeepRunning(false)} />;
  return <Layout keyError={error ? errorMessage(error) : null} />;
}

/** macOS is asking whether Homerun may read its keychain item (§11). */
function KeychainWait({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Keychain access needs your approval</h1>
        <p>macOS is asking whether Homerun may use its saved API key. Choose Allow in the dialog, then try again.</p>
        <button type="button" className="primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </main>
  );
}
