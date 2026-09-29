import { useState } from "react";
import {
  CLASS_LABEL,
  alreadyAnswered,
  approvalResponse,
  checkGrant,
  contentText,
  describeResolution,
  errorMessage,
  grantEditor,
  initialAnswers,
  initialGrant,
  offersAlways,
  questionResponse,
  setFreeform,
  toggleOption,
  toolName,
  type ApprovalDecision,
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
 * `ThreadSync.answer`; first answer wins, so a late answer shows who answered first.
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

  const answer = async (response: InputResponse) => {
    const r = await sync.answer(request_id, response);
    if (r.status === "already_resolved") setLate(alreadyAnswered(r.state, r.answered_by, deviceId));
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
      return <ApprovalCard prompt={prompt} onAnswer={answer} footer={expiry} />;
    case "question":
      return <QuestionCard prompt={prompt} onAnswer={answer} footer={expiry} />;
    case "ambiguous_tool_call":
      return <AmbiguityCard prompt={prompt} onAnswer={answer} />;
  }
}

type OnAnswer = (r: InputResponse) => Promise<void>;

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

export function ApprovalCard({ prompt, onAnswer, footer }: { prompt: ApprovalPrompt; onAnswer: OnAnswer; footer?: React.ReactNode }) {
  const { busy, error, setError, submit } = useSubmit(onAnswer);
  const [editing, setEditing] = useState(false);
  const [grant, setGrant] = useState<GrantDraft>(() => initialGrant(prompt));
  const editor = grantEditor(prompt);
  const check = checkGrant(prompt, grant);
  const always = offersAlways(prompt) && editor.classes.length > 0;

  const decide = (d: ApprovalDecision) => {
    const r = approvalResponse(prompt, d, d === "allow_always" ? grant : undefined);
    if (!r.response) return setError(r.errors.join(" ") || "Check the pattern.");
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
      {editing && (
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
      {!editing && (
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

export function QuestionCard({ prompt, onAnswer, footer }: { prompt: QuestionPrompt; onAnswer: OnAnswer; footer?: React.ReactNode }) {
  const { busy, error, submit } = useSubmit(onAnswer);
  const [draft, setDraft] = useState<QuestionDraft>(() => initialAnswers(prompt));
  const response = questionResponse(prompt, draft);
  return (
    <section className="card input-card question" aria-label="Question from Claude">
      {prompt.questions.map((q, qi) => {
        const a = draft.answers[qi]!;
        const name = `q${qi}`;
        return (
          <fieldset key={qi}>
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
      <div className="row">
        <button type="button" className="primary" disabled={busy || !response} onClick={() => response && void submit(response)}>
          Send answer
        </button>
      </div>
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
export function AmbiguityCard({ prompt, onAnswer }: { prompt: AmbiguousCallPrompt; onAnswer: OnAnswer }) {
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
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void submit({ type: "ambiguous_tool_call", outcome: "completed" })}>
          Yes, it happened
        </button>
        <button type="button" disabled={busy} onClick={() => void submit({ type: "ambiguous_tool_call", outcome: "not_run" })}>
          No, it didn't run
        </button>
      </div>
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
        {what}: {describeResolution(prompt, resolution, deviceId)}
        {answers ? ` — ${answers}` : ""}
        {resolution.response?.type === "approval" && resolution.response.grant ? ` (${resolution.response.grant.pattern ?? "any call"})` : ""}
      </span>{" "}
      <Time ts={resolution.ts} />
    </p>
  );
}
