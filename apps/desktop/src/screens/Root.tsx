import { useEffect, useState } from "react";
import { errorMessage } from "@homerun/app-state";
import { useApp, useStore } from "../hooks";
import { isKeychainApproval } from "../platform/types";
import { Layout } from "./Layout";
import { Onboarding } from "./Onboarding";

/** First run shows onboarding until a key is connected or skipped (§7.2); then the app. */
export function Root() {
  const app = useApp();
  const key = useStore(app.key);
  const [error, setError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState(false);

  const load = () => {
    setError(null);
    app.refreshKey().catch(setError);
  };
  useEffect(load, [app]);

  if (error && isKeychainApproval(error)) return <KeychainWait onRetry={load} />;
  if (!key && !error) return <div className="splash" aria-busy="true" />;
  if (key && !key.present && !skipped) return <Onboarding onSkip={() => setSkipped(true)} />;
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
