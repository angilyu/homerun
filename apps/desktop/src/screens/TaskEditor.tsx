import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  MODEL_ALIASES,
  checkSpec,
  errorMessage,
  getAt,
  isConflict,
  issuesAt,
  newMonitorSpec,
  newSessionSpec,
  setAt,
  type SpecCheck,
} from "@homerun/app-state";
import { BuiltinTool, MONITOR_FORBIDDEN_BUILTINS, type Task } from "@homerun/core";
import { useApp } from "../hooks";
import { ErrorText, Page } from "../ui/bits";

type Draft = Record<string, unknown>;

/**
 * Create or edit a task or monitor (§2.1, §8). The form covers the common fields; Advanced
 * edits the whole spec as JSON. `checkSpec` is core's schema, so what saves here is exactly
 * what the runtime accepts. Saving an edit sends `expected_version`: CONFLICT means it changed
 * elsewhere (§6).
 */
export function TaskEditor({ task_id, kind, from_thread_id }: { task_id?: string; kind?: "session" | "monitor"; from_thread_id?: string }) {
  const app = useApp();
  const [task, setTask] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Draft | null>(task_id ? null : ((kind === "monitor" ? newMonitorSpec() : newSessionSpec()) as unknown as Draft));
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showIssues, setShowIssues] = useState(false);

  const load = async () => {
    if (!task_id) return;
    try {
      const r = await app.client.rpc.call("tasks.get", { task_id });
      setTask(r.task);
      setDraft(structuredClone(r.task.spec) as unknown as Draft);
      setConflict(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task_id]);

  if (!draft) return <Page title="Edit task">{error ? <ErrorText error={error} /> : <p aria-busy="true">Loading…</p>}</Page>;

  const check = checkSpec(draft);
  const isMonitor = draft.kind === "monitor";
  const set = (path: string, v: unknown) => setDraft((d) => setAt(d!, path, v));
  const noun = isMonitor ? "monitor" : "task";

  const save = async () => {
    setShowIssues(true);
    if (!check.ok) return;
    setSaving(true);
    setError(null);
    try {
      if (task) {
        await app.client.tasks.update(task.task_id, check.spec, task.version);
        app.go({ name: "task", task_id: task.task_id });
      } else {
        const r = await app.client.tasks.create(check.spec, from_thread_id);
        app.go({ name: "task", task_id: r.task.task_id });
      }
    } catch (e) {
      if (isConflict(e)) setConflict(true);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => app.go(task ? { name: "task", task_id: task.task_id } : from_thread_id ? { name: "thread", thread_id: from_thread_id } : { name: "tasks" });

  return (
    <Page
      title={task ? `Edit ${task.name}` : from_thread_id ? "Save chat as a task" : `New ${noun}`}
      actions={
        <>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={saving || (showIssues && !check.ok)} onClick={() => void save()}>
            {saving ? "Saving…" : task ? "Save" : `Create ${noun}`}
          </button>
        </>
      }
    >
      {conflict && (
        <div className="notice warn" role="alert">
          <p>This {noun} was changed somewhere else while you were editing. Reload it to see the latest version; your edits here will be lost.</p>
          <button type="button" onClick={() => void load()}>
            Reload
          </button>
        </div>
      )}
      <ErrorText error={error} />
      {from_thread_id && <p className="help">The new task takes this chat's approvals as its starting grants, and the chat moves into it.</p>}
      <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Field label="Name" path="name" check={check} show={showIssues}>
          <input type="text" value={str(draft, "name")} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={isMonitor ? "What to do when it changes" : "Instructions"} path="prompt" check={check} show={showIssues}>
          <textarea rows={6} value={str(draft, "prompt")} onChange={(e) => set("prompt", e.target.value)} />
        </Field>
        {isMonitor ? <MonitorFields draft={draft} set={set} check={check} show={showIssues} /> : <ModelField label="Model" path="model.model" draft={draft} set={set} />}
        <fieldset>
          <legend>Budget</legend>
          <div className="row">
            <Field label="Per run (USD)" path="budget.max_run_usd" check={check} show={showIssues}>
              <NumberInput value={getAt(draft, "budget.max_run_usd")} onChange={(v) => set("budget.max_run_usd", v)} step="0.1" />
            </Field>
            <Field label="Per month (USD, optional)" path="budget.monthly_cap_usd" check={check} show={showIssues}>
              <NumberInput value={getAt(draft, "budget.monthly_cap_usd")} onChange={(v) => set("budget.monthly_cap_usd", v)} step="1" optional />
            </Field>
          </div>
        </fieldset>
        <ToolsField draft={draft} set={set} check={check} show={showIssues} />
        <fieldset>
          <legend>Access</legend>
          <Field label="Folders it may use (one per line)" path="policy.roots" check={check} show={showIssues}>
            <LinesInput value={arr(draft, "policy.roots")} onChange={(v) => set("policy.roots", v)} placeholder="~/Projects/site" />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={getAt(draft, "policy.egress.mode") === "open"}
              onChange={(e) => set("policy.egress", e.target.checked ? { mode: "open" } : { mode: "allowlist", domains: [] })}
            />
            Allow any website
          </label>
          {getAt(draft, "policy.egress.mode") !== "open" && (
            <Field label="Websites it may reach (one per line)" path="policy.egress" check={check} show={showIssues}>
              <LinesInput value={arr(draft, "policy.egress.domains")} onChange={(v) => set("policy.egress.domains", v)} placeholder="example.com" />
            </Field>
          )}
          {getAt(draft, "policy.egress.mode") === "open" && issuesAt(check, "policy.egress").map((m) => <p key={m} className="error">{m}</p>)}
        </fieldset>
        <Advanced draft={draft} onChange={setDraft} />
        {showIssues && !check.ok && (
          <div className="notice warn" role="alert">
            <p>Fix these first:</p>
            <ul>
              {check.issues.map((i, n) => (
                <li key={n}>
                  <code>{i.path || "spec"}</code>: {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Page>
  );
}

function str(d: Draft, p: string): string {
  const v = getAt(d, p);
  return typeof v === "string" ? v : "";
}
function arr(d: Draft, p: string): string[] {
  const v = getAt(d, p);
  return Array.isArray(v) ? (v as string[]) : [];
}

// Issues sit outside the <label> so they don't become part of the control's name; they're linked by aria-describedby instead.
function Field({ label, path, check, show, children }: { label: string; path: string; check: SpecCheck; show: boolean; children: ReactNode }) {
  const errs = show ? issuesAt(check, path) : [];
  const id = useId();
  const control =
    errs.length && isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>(children)
      ? cloneElement(children, { "aria-describedby": `${id}-err`, "aria-invalid": true })
      : children;
  return (
    <div className="field" data-invalid={errs.length ? "" : undefined}>
      <label className="field-label">
        <span className="field-name">{label}</span>
        {control}
      </label>
      {errs.length > 0 && (
        <span id={`${id}-err`} className="error">
          {errs.join(" ")}
        </span>
      )}
    </div>
  );
}

function NumberInput({ value, onChange, step, optional = false }: { value: unknown; onChange: (v: number | undefined) => void; step: string; optional?: boolean }) {
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min="0"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value.trim() === "" ? undefined : Number(e.target.value);
        onChange(n === undefined ? (optional ? undefined : 0) : n);
      }}
    />
  );
}

function LinesInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      rows={Math.max(2, Math.min(8, value.length + 1))}
      spellCheck={false}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function ModelField({ label, path, draft, set }: { label: string; path: string; draft: Draft; set: (p: string, v: unknown) => void }) {
  const v = str(draft, path);
  const known = MODEL_ALIASES.some((m) => m.id === v);
  const [custom, setCustom] = useState(!known && v !== "");
  return (
    <label className="field">
      <span className="field-name">{label}</span>
      <div className="row">
        <select
          value={custom ? "custom" : v}
          onChange={(e) => {
            if (e.target.value === "custom") return setCustom(true);
            setCustom(false);
            set(path, e.target.value);
          }}
        >
          {MODEL_ALIASES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="custom">Other model id…</option>
        </select>
        {custom && <input type="text" aria-label="Model id" value={v} onChange={(e) => set(path, e.target.value)} spellCheck={false} />}
      </div>
    </label>
  );
}

const TOOL_HELP: Partial<Record<string, string>> = {
  Read: "read files",
  Write: "create files",
  Edit: "change files",
  Glob: "find files",
  Grep: "search files",
  Bash: "run commands",
  WebFetch: "fetch web pages",
  WebSearch: "search the web",
  AskUserQuestion: "ask you questions",
};

function ToolsField({ draft, set, check, show }: { draft: Draft; set: (p: string, v: unknown) => void; check: SpecCheck; show: boolean }) {
  const on = new Set(arr(draft, "tools.builtin"));
  const forbidden = new Set<string>(draft.kind === "monitor" ? MONITOR_FORBIDDEN_BUILTINS : []);
  const errs = show ? issuesAt(check, "tools") : [];
  return (
    <fieldset>
      <legend>Tools</legend>
      <div className="tool-grid">
        {BuiltinTool.options
          .filter((t) => !forbidden.has(t))
          .map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={on.has(t)}
                onChange={(e) => {
                  const next = new Set(on);
                  if (e.target.checked) next.add(t);
                  else next.delete(t);
                  set(
                    "tools.builtin",
                    BuiltinTool.options.filter((x) => next.has(x)),
                  );
                }}
              />
              {t} <span className="help">{TOOL_HELP[t]}</span>
            </label>
          ))}
      </div>
      {arr(draft, "tools.mcp_servers").length > 0 && <p className="help">{arr(draft, "tools.mcp_servers").length} MCP server(s): edit them under Advanced.</p>}
      {errs.map((m) => (
        <p key={m} className="error">
          {m}
        </p>
      ))}
    </fieldset>
  );
}

function MonitorFields({ draft, set, check, show }: { draft: Draft; set: (p: string, v: unknown) => void; check: SpecCheck; show: boolean }) {
  const sk = getAt(draft, "schedule.kind");
  const ck = getAt(draft, "check.kind");
  const srcType = getAt(draft, "check.source.type");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const catchup = { catchup: getAt(draft, "schedule.catchup") ?? "run_once", max_catchup: getAt(draft, "schedule.max_catchup") ?? 1 };
  return (
    <>
      <fieldset>
        <legend>Schedule</legend>
        <div className="row">
          <label className="check">
            <input type="radio" name="sk" checked={sk === "interval"} onChange={() => set("schedule", { kind: "interval", every_minutes: 60, ...catchup })} />
            Every few minutes
          </label>
          <label className="check">
            <input type="radio" name="sk" checked={sk === "cron"} onChange={() => set("schedule", { kind: "cron", cron: "0 9 * * *", timezone: zone, ...catchup })} />
            At set times (cron)
          </label>
        </div>
        {sk === "interval" ? (
          <Field label="Every (minutes)" path="schedule.every_minutes" check={check} show={show}>
            <NumberInput value={getAt(draft, "schedule.every_minutes")} onChange={(v) => set("schedule.every_minutes", v)} step="1" />
          </Field>
        ) : (
          <div className="row">
            <Field label="Cron" path="schedule.cron" check={check} show={show}>
              <input type="text" spellCheck={false} value={str(draft, "schedule.cron")} onChange={(e) => set("schedule.cron", e.target.value)} />
            </Field>
            <Field label="Time zone" path="schedule.timezone" check={check} show={show}>
              <input type="text" spellCheck={false} value={str(draft, "schedule.timezone")} onChange={(e) => set("schedule.timezone", e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Checks missed while the Mac sleeps (§8.1)" path="schedule.catchup" check={check} show={show}>
          <select value={String(catchup.catchup)} onChange={(e) => set("schedule.catchup", e.target.value)}>
            <option value="run_once">Run one check when it wakes</option>
            <option value="run_all">Run every missed check</option>
            <option value="skip">Skip them</option>
          </select>
        </Field>
      </fieldset>
      <fieldset>
        <legend>Check</legend>
        <div className="row">
          <label className="check">
            <input
              type="radio"
              name="ck"
              checked={ck === "rule"}
              onChange={() => set("check", { kind: "rule", source: { type: "http", url: "https://example.com", extract: { kind: "body" } }, comparator: { op: "changed" } })}
            />
            A web page changes (no model cost)
          </label>
          <label className="check">
            <input type="radio" name="ck" checked={ck === "model"} onChange={() => set("check", { kind: "model", model: "haiku", instructions: "" })} />
            Claude decides
          </label>
        </div>
        {ck === "rule" && srcType === "http" && (
          <Field label="Page URL" path="check.source.url" check={check} show={show}>
            <input type="url" spellCheck={false} value={str(draft, "check.source.url")} onChange={(e) => set("check.source.url", e.target.value)} />
          </Field>
        )}
        {ck === "rule" && srcType !== "http" && <p className="help">This check reads a {String(srcType)} source: edit it under Advanced.</p>}
        {ck === "model" && (
          <>
            <Field label="What counts as a change" path="check.instructions" check={check} show={show}>
              <textarea rows={3} value={str(draft, "check.instructions")} onChange={(e) => set("check.instructions", e.target.value || undefined)} />
            </Field>
            <ModelField label="Check model" path="check.model" draft={draft} set={set} />
          </>
        )}
      </fieldset>
      <ModelField label="Model when it changes" path="act.model.model" draft={draft} set={set} />
    </>
  );
}

/** The whole spec as JSON. Edits apply as soon as they parse. */
function Advanced({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const own = useRef<Draft | null>(null);
  useEffect(() => {
    // Reformat only for changes made in the form, never under the cursor.
    if (open && draft !== own.current) setText(JSON.stringify(draft, null, 2));
  }, [open, draft]);
  return (
    <details className="advanced" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Advanced: edit as JSON</summary>
      <textarea
        aria-label="Task spec JSON"
        className="mono"
        rows={18}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The spec is a JSON object.");
            setBad(null);
            own.current = v as Draft;
            onChange(v as Draft);
          } catch (err) {
            setBad(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {bad && <p className="error">{bad}</p>}
    </details>
  );
}
