import { useState } from "react";
import { bytes, errorMessage } from "@homerun/app-state";
import { verdictMessage, type CrashReportSettings, type DiagnosticFile } from "@homerun/core";
import { useAction, useApp, useLoad, useShell, useStore } from "../hooks";
import type { SavedBundle } from "../platform/types";
import { ErrorText } from "../ui/bits";
import { DOWNLOAD_PAGE } from "./Settings";

/**
 * The minimum-version gate (§11 "Updates and control"): while the signed version policy stops
 * this version, a banner that can't be dismissed says why, with an Update button wired to the
 * updater. It clears itself when the policy changes or Homerun updates. In the web client it
 * reports the Mac's runtime, which is what stopped.
 */
export function VersionBanner() {
  const app = useApp();
  const status = useStore(app.client.version);
  const update = useStore(app.update);
  const [error, setError] = useState<string | null>(null);
  const v = status?.verdict;
  if (!v || v.state === "ok") return null;
  const shell = app.shell;
  const text = `${shell ? "" : "On your Mac: "}${verdictMessage(v)}${v.interactive_allowed ? "" : " Chat is paused too."}`;
  const act = (p: Promise<unknown> | undefined) => void p?.catch((e) => setError(errorMessage(e)));
  const download = v.url ?? DOWNLOAD_PAGE;
  return (
    <div className={`banner ${v.state === "killed" ? "danger" : "warn"}`} role="alert" aria-label="Update required">
      <span>
        {text}
        {error && <span className="small"> {error}</span>}
      </span>
      <span className="actions">
        {shell &&
          (update?.state === "ready" ? (
            <button type="button" className="primary" onClick={() => act(shell.restartToUpdate())}>
              Restart to update
            </button>
          ) : update?.state === "manual" || update?.state === "unavailable" || update?.state === "failed" ? (
            <button type="button" className="primary" onClick={() => app.openExternal(download)}>
              Download update
            </button>
          ) : (
            <button type="button" className="primary" disabled={update?.state === "checking" || update?.state === "downloading"} onClick={() => act(shell.checkForUpdates())}>
              {update?.state === "downloading" ? "Downloading…" : "Update"}
            </button>
          ))}
        {v.url && (
          <button type="button" onClick={() => app.openExternal(v.url!)}>
            Details
          </button>
        )}
      </span>
    </div>
  );
}

/** Whether this build can send crash reports, and whether the user said yes (§11 Diagnostics). */
export function useCrashReports() {
  const app = useApp();
  const s = useLoad(() => app.client.rpc.call("diagnostics.crash_reports.get", {}).then((r) => r.settings), []);
  const [settings, setSettings] = useState<CrashReportSettings | null>(null);
  const set = useAction(async (enabled: boolean) => setSettings((await app.client.rpc.call("diagnostics.crash_reports.set", { enabled })).settings));
  return { settings: settings ?? s.data, set };
}

export const CRASH_REPORTS_HELP =
  "Only the kind of error, where in Homerun's code it happened, and the app version, OS and processor. Never your chats, tasks, files, links or keys.";

/** "Send crash reports": hidden in a build without a crash-report endpoint. Off by default. */
export function CrashReportsCheckbox({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        Send crash reports
      </label>
      <p className="muted small">{CRASH_REPORTS_HELP}</p>
    </>
  );
}

type Step = { s: "idle" } | { s: "preview"; files: DiagnosticFile[] } | { s: "saved"; bundle: SavedBundle };

/** Crash reports and the diagnostic bundle (§11 Diagnostics). The desktop only. */
export function DiagnosticsSection() {
  const app = useApp();
  const shell = useShell();
  const crash = useCrashReports();
  const [step, setStep] = useState<Step>({ s: "idle" });
  const preview = useAction(async () => setStep({ s: "preview", files: (await app.client.rpc.call("diagnostics.preview", {})).files }));
  const save = useAction(async (choose: boolean) => {
    const b = await shell.saveDiagnostics(choose);
    if (b) setStep({ s: "saved", bundle: b });
  });
  const reveal = useAction(() => shell.revealDiagnostics());
  const total = step.s === "preview" ? step.files.reduce((n, f) => n + f.bytes, 0) : 0;
  return (
    <section aria-label="Diagnostics">
      <h2>Diagnostics</h2>
      {crash.settings?.available && (
        <>
          <CrashReportsCheckbox checked={crash.settings.enabled} disabled={crash.set.busy} onChange={(on) => void crash.set.run(on)} />
          <ErrorText error={crash.set.error} />
        </>
      )}
      <h3>Diagnostic bundle</h3>
      <p className="muted small">A zip to attach to a bug report. Logs are redacted, the database is counted, not copied, and nothing is uploaded.</p>
      {step.s !== "preview" && (
        <button type="button" disabled={preview.busy} onClick={() => void preview.run()}>
          Create diagnostic bundle…
        </button>
      )}
      {step.s === "preview" && (
        <div role="group" aria-label="Bundle contents">
          <p>It will contain these files ({bytes(total)} before compression):</p>
          <ul className="plain">
            {step.files.map((f) => (
              <li key={f.name}>
                <code>{f.name}</code> <span className="muted small">{f.description}, {bytes(f.bytes)}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="primary" disabled={save.busy} onClick={() => void save.run(false)}>
              Save to Downloads
            </button>
            <button type="button" disabled={save.busy} onClick={() => void save.run(true)}>
              Choose location…
            </button>
            <button type="button" disabled={save.busy} onClick={() => setStep({ s: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {step.s === "saved" && (
        <p role="status">
          Saved {baseName(step.bundle.path)} ({bytes(step.bundle.bytes)}).{" "}
          <button type="button" className="link" onClick={() => void reveal.run()}>
            {navigator.userAgent.includes("Windows") ? "Show in Explorer" : "Show in Finder"}
          </button>
        </p>
      )}
      <ErrorText error={preview.error ?? save.error ?? reveal.error} />
    </section>
  );
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
