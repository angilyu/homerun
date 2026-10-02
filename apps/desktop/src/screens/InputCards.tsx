import { useState } from "react";
import {
  ALL_WEB_FETCHES,
  ALL_WEB_FETCHES_WARNING,
  CLASS_LABEL,
  allWebFetchesResponse,
  alreadyAnswered,
  approvalResponse,
  cantAnswer,
  checkGrant,
  contentText,
  describeResolution,
  errorMessage,
  grantEditor,
  initialAnswers,
  initialGrant,
  offersAllWebFetches,
  offersAlways,
  questionResponse,
  setFreeform,
  toggleOption,
  toolName,
  type ApprovalDecision,
  type ClientRole,
  type GrantDraft,
  type InputResolution,
  type QuestionDraft,
  type ThreadSync,
} from "@homerun/app-state";
import type { AmbiguousCallPrompt, ApprovalPrompt, InputPrompt, InputResponse, QuestionPrompt } from "@homerun/core";
import { useApp, useStore } from "../hooks";
import { Fold, Time } from "../ui/bits";

/**
 * Approvals, questions and "Did this happen?" (§5.4, §5.6). Answering goes through
 * `ThreadSync.answer`; first answer wins, so a late answer shows who answered first. A card
 * this client can't answer (the web and a destructive call, §9.9; any remote while its desktop is
 * offline, §9.8) says why instead of offering buttons.
 */

const REASON: Record<ApprovalPrompt["reason"], string> = {
  not_allowlisted: "This tool isn't in the task's allowlist.",
  untrusted_tool: "This tool comes from a third-party MCP server you haven't trusted yet.",
  destructive: "This call can delete or overwrite things, so it's approved one call at a time.",
  tainted_egress: "This run read untrusted content and now wants to reach a site outside its allowlist.",
  web_read_only: "Someone on the web client steered this run, so it needs approval for anything beyond reading.",
};

export function InputCard({ sync, request_id, prompt, expires_at }: { sync: ThreadSync; request_id: string; prompt: InputPrompt; expires_at: number | null }) {
  const [late, setLate] = useState<string | null>(null);
  const app = useApp();
  const runtime = useStore(app.client.runtime);
  const deviceId = runtime.state === "ready" ? runtime.device_id : null;
  const role = app.client.role;
  const notice = cantAnswer(prompt, role, app.client.signsApprovals) ?? (runtime.state === "offline" ? "Can be answered when your Mac is back" : null);

  const answer = async (response: InputResponse) => {
    const r = await sync.answer(request_id, response, { prompt, expires_at });
    if (r.status === "already_resolved") setLate(alreadyAnswered(r.state, r.answered_by, deviceId, app.client.role));
  };

  if (late)
    return (
      <div className="card input-card resolved" role="status">
        {late}
      </div>
    );
  const expiry = expires_at ? (
    <p className="help">
      Expires <Time ts={expires_at} />
    </p>
  ) : null;
  switch (prompt.type) {
    case "approval":
      return <ApprovalCard prompt={prompt} onAnswer={answer} footer={expiry} role={role} notice={notice} />;
    case "question":
      return <QuestionCard prompt={prompt} onAnswer={answer} footer={expiry} role={role} notice={notice} />;
    case "ambiguous_tool_call":
      return <AmbiguityCard prompt={prompt} onAnswer={answer} notice={notice} />;
  }
}

type OnAnswer = (r: InputResponse) => Promise<void>;

/** What a card shows: who may answer it, and why this client can't, if it can't. */
interface CardProps {
  onAnswer: OnAnswer;
  footer?: React.ReactNode;
  role?: ClientRole;
  notice?: string | null;
}

function Notice({ text }: { text: string }) {
  return (
    <p className="notice" role="note">
      {text}
    </p>
  );
}

function useSubmit(onAnswer: OnAnswer) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (r: InputResponse) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

export function ApprovalCard({ prompt, onAnswer, footer, role = "webview", notice = null }: CardProps & { prompt: ApprovalPrompt }) {
  const { busy, error, setError, submit } = useSubmit(onAnswer);
  const [editing, setEditing] = useState(false);
  const [grant, setGrant] = useState<GrantDraft>(() => initialGrant(prompt));
  const editor = grantEditor(prompt);
  const check = checkGrant(prompt, grant);
  const always = offersAlways(prompt, role) && editor.classes.length > 0;
  // "Allow all web fetches for this task" (§5.6): its own choice, confirmed against its warning.
  const [confirmAll, setConfirmAll] = useState(false);
  const allFetches = always && offersAllWebFetches(prompt, role);

  const decide = (d: ApprovalDecision) => {
    const r = approvalResponse(prompt, d, d === "allow_always" ? grant : undefined, role);
    if (!r.response) return setError(r.errors.join(" ") || "Check the pattern.");
    void submit(r.response);
  };
  const allowAll = () => {
    const r = allWebFetchesResponse(prompt, role);
    if (!r.response) return setError(r.errors.join(" "));
    void submit(r.response);
  };

  return (
    <section className="card input-card approval" aria-label={`Approve ${toolName(prompt.tool)}`}>
      <header>
        <strong>Allow {toolName(prompt.tool)}?</strong> <span className={`badge badge-${prompt.class === "destructive" ? "danger" : "plain"}`}>{CLASS_LABEL[prompt.class]}</span>
      </header>
      <p className="help">{REASON[prompt.reason]}</p>
      {prompt.url && (
        <p className="url">
          <code>{prompt.url}</code>
        </p>
      )}
      <Fold text={contentText(prompt.input)} lines={10} />
      {notice && <Notice text={notice} />}
      {editing && !notice && (
        <fieldset className="grant-editor">
          <legend>Always allow for this task</legend>
          {editor.pattern_editable ? (
            <label>
              {editor.pattern_label}
              <input
                type="text"
                value={grant.pattern}
                spellCheck={false}
                onChange={(e) => {
                  setError(null);
                  setGrant({ ...grant, pattern: e.target.value });
                }}
                aria-invalid={check.errors.length > 0 || undefined}
              />
            </label>
          ) : (
            <p>Every call to {toolName(prompt.tool)} in this task.</p>
          )}
          {editor.classes.length > 1 && (
            <label>
              Treat as
              <select value={grant.class} onChange={(e) => setGrant({ ...grant, class: e.target.value as GrantDraft["class"] })}>
                {editor.classes.map((c) => (
                  <option key={c} value={c}>
                    {CLASS_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {check.errors.map((e) => (
            <p key={e} className="error">
              {e}
            </p>
          ))}
          <p className="help">You can revoke this later on the task's page.</p>
          <div className="row">
            <button type="button" className="primary" disabled={busy || !check.proposal || check.errors.length > 0} onClick={() => decide("allow_always")}>
              Save and allow
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Back
            </button>
          </div>
        </fieldset>
      )}
      {confirmAll && !editing && !notice && (
        <fieldset className="grant-editor all-web-fetches">
          <legend>{ALL_WEB_FETCHES}?</legend>
          <p className="error" role="note">
            {ALL_WEB_FETCHES_WARNING}
          </p>
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={allowAll}>
              Allow all web fetches
            </button>
            <button type="button" onClick={() => setConfirmAll(false)}>
              Back
            </button>
          </div>
        </fieldset>
      )}
      {!editing && !confirmAll && !notice && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => decide("allow")}>
            Allow once
          </button>
          <button type="button" disabled={busy} onClick={() => decide("deny")}>
            Deny
          </button>
          {always && (
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              Always allow…
            </button>
          )}
          {allFetches && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setConfirmAll(true);
              }}
            >
              {ALL_WEB_FETCHES}…
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {footer}
    </section>
  );
}

export function QuestionCard({ prompt, onAnswer, footer, role = "webview", notice = null }: CardProps & { prompt: QuestionPrompt }) {
  const { busy, error, submit } = useSubmit(onAnswer);
  const [draft, setDraft] = useState<QuestionDraft>(() => initialAnswers(prompt));
  const response = questionResponse(prompt, draft, role);
  return (
    <section className="card input-card question" aria-label="Question from Claude">
      {prompt.questions.map((q, qi) => {
        const a = draft.answers[qi]!;
        const name = `q${qi}`;
        return (
          <fieldset key={qi} disabled={notice !== null}>
            <legend>
              {q.header && <span className="badge">{q.header}</span>} {q.question}
            </legend>
            {q.multi_select && <p className="help">Choose any that apply.</p>}
            <div className="options">
              {q.options.map((o) => (
                <label key={o.label} className="option">
                  <input type={q.multi_select ? "checkbox" : "radio"} name={name} checked={a.selected.includes(o.label)} onChange={() => setDraft(toggleOption(prompt, draft, qi, o.label))} />
                  <span>
                    {o.label}
                    {o.description && <span className="help"> — {o.description}</span>}
                  </span>
                </label>
              ))}
            </div>
            {q.allow_freeform && (
              <label className="freeform">
                {q.options.length ? "Or write your own" : "Your answer"}
                <textarea rows={2} value={a.text} onChange={(e) => setDraft(setFreeform(draft, qi, e.target.value))} />
              </label>
            )}
          </fieldset>
        );
      })}
      {notice ? (
        <Notice text={notice} />
      ) : (
        <div className="row">
          <button type="button" className="primary" disabled={busy || !response} onClick={() => response && void submit(response)}>
            Send answer
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {footer}
    </section>
  );
}

/** "Did this happen?" after a crash interrupted a call that isn't safe to repeat (§5.4). */
export function AmbiguityCard({ prompt, onAnswer, notice = null }: Omit<CardProps, "footer" | "role"> & { prompt: AmbiguousCallPrompt }) {
  const { busy, error, submit } = useSubmit(onAnswer);
  return (
    <section className="card input-card ambiguity" aria-label="Did this happen?">
      <header>
        <strong>Did this happen?</strong>
      </header>
      <p>
        Homerun stopped while Claude was running {toolName(prompt.tool)}, and can't tell whether it finished. Check, then tell Claude. It won't run it
        again on its own.
      </p>
      <Fold text={contentText(prompt.input)} lines={8} />
      {notice ? (
        <Notice text={notice} />
      ) : (
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void submit({ type: "ambiguous_tool_call", outcome: "completed" })}>
            Yes, it happened
          </button>
          <button type="button" disabled={busy} onClick={() => void submit({ type: "ambiguous_tool_call", outcome: "not_run" })}>
            No, it didn't run
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** A resolved request, as one line in the timeline. */
export function ResolvedLine({ prompt, resolution }: { prompt: InputPrompt; resolution: InputResolution }) {
  const app = useApp();
  const runtime = useStore(app.client.runtime);
  const deviceId = runtime.state === "ready" ? runtime.device_id : null;
  const what =
    prompt.type === "approval"
      ? toolName(prompt.tool)
      : prompt.type === "ambiguous_tool_call"
        ? `Did ${toolName(prompt.tool)} happen?`
        : prompt.questions.map((q) => q.header ?? q.question).join(", ");
  const answers =
    resolution.response?.type === "question"
      ? resolution.response.answers.map((a) => [...a.selected, ...(a.text ? [a.text] : [])].join(", ")).join("; ")
      : null;
  return (
    <p className="event resolved-line">
      <span>
        {what}: {describeResolution(prompt, resolution, deviceId, app.client.role)}
        {answers ? ` — ${answers}` : ""}
        {resolution.response?.type === "approval" && resolution.response.grant ? ` (${resolution.response.grant.pattern ?? "any call"})` : ""}
      </span>{" "}
      <Time ts={resolution.ts} />
    </p>
  );
}
