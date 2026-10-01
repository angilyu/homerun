import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import {
  CLASS_LABEL,
  alreadyAnswered,
  approvalResponse,
  cantAnswer,
  checkGrant,
  contentText,
  describeResolution,
  errorMessage,
  grantEditor,
  inTime,
  initialAnswers,
  initialGrant,
  offersAlways,
  questionResponse,
  setFreeform,
  toggleOption,
  toolName,
  truncate,
  type ApprovalDecision,
  type ClientRole,
  type GrantDraft,
  type InputResolution,
  type QuestionDraft,
  type ThreadSync,
} from "@homerun/app-state";
import type { AmbiguousCallPrompt, ApprovalPrompt, InputPrompt, InputResponse, QuestionPrompt } from "@homerun/core";
import { useDesktop, useNow, useStore } from "./hooks";
import { Badge, Button, Card, ErrorText, Notice, T, s, usePalette } from "./theme";

/**
 * Approvals, questions and "Did this happen?" in the app (§5.4, §5.6, §9.8). The first answer
 * wins. Allowing a destructive call asks Face ID for the approval key's signature, which the Mac
 * checks; without a pinned key the card says "Approve on your Mac" (§18 row 115). While the Mac is
 * offline nothing here can be answered: the run that asked is on the Mac.
 */

const REASON: Record<ApprovalPrompt["reason"], string> = {
  not_allowlisted: "This tool isn't in the task's allowlist.",
  untrusted_tool: "This tool comes from a third-party MCP server you haven't trusted yet.",
  destructive: "This call can delete or overwrite things, so it's approved one call at a time, with Face ID.",
  tainted_egress: "This run read untrusted content and now wants to reach a site outside its allowlist.",
  web_read_only: "Someone on the web client steered this run, so it needs approval for anything beyond reading.",
};

export const OFFLINE_ANSWER = "Questions and approvals can be answered when your Mac is back.";

export function InputCard({ sync, request_id, prompt, expires_at }: { sync: ThreadSync; request_id: string; prompt: InputPrompt; expires_at: number | null }) {
  const { client } = useDesktop();
  const runtime = useStore(client.runtime);
  const now = useNow();
  const [late, setLate] = useState<string | null>(null);
  const deviceId = runtime.state === "ready" ? runtime.device_id : null;
  const role = client.role;
  const notice = cantAnswer(prompt, role, client.signsApprovals) ?? (runtime.state !== "ready" ? OFFLINE_ANSWER : null);

  const answer = async (response: InputResponse) => {
    const r = await sync.answer(request_id, response, { prompt, expires_at });
    if (r.status === "already_resolved") setLate(alreadyAnswered(r.state, r.answered_by, deviceId, role));
  };

  if (late)
    return (
      <Card>
        <T muted>{late}</T>
      </Card>
    );
  const footer = expires_at ? (
    <T muted style={s.small}>
      Expires {inTime(expires_at, now)}
    </T>
  ) : null;
  switch (prompt.type) {
    case "approval":
      return <ApprovalCard prompt={prompt} onAnswer={answer} footer={footer} role={role} notice={notice} />;
    case "question":
      return <QuestionCard prompt={prompt} onAnswer={answer} footer={footer} notice={notice} />;
    case "ambiguous_tool_call":
      return <AmbiguityCard prompt={prompt} onAnswer={answer} notice={notice} />;
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

function Preview({ text }: { text: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const long = text.length > 400 || text.split("\n").length > 8;
  return (
    <Pressable accessibilityRole="button" accessibilityHint={long ? "Shows all of it" : undefined} disabled={!long} onPress={() => setOpen(!open)}>
      <T style={[s.mono, { backgroundColor: p.code, padding: 8, borderRadius: 6 }]} selectable>
        {open || !long ? text : truncate(text, 400)}
      </T>
      {long ? (
        <T muted style={s.small}>
          {open ? "Show less" : "Show all"}
        </T>
      ) : null}
    </Pressable>
  );
}

function ApprovalCard({ prompt, onAnswer, footer, role, notice }: { prompt: ApprovalPrompt; onAnswer: OnAnswer; footer: ReactNode; role: ClientRole; notice: string | null }) {
  const { busy, error, setError, submit } = useSubmit(onAnswer);
  const p = usePalette();
  const [editing, setEditing] = useState(false);
  const [grant, setGrant] = useState<GrantDraft>(() => initialGrant(prompt));
  const editor = grantEditor(prompt);
  const check = checkGrant(prompt, grant);
  const always = offersAlways(prompt, role) && editor.classes.length > 0;
  const decide = (d: ApprovalDecision) => {
    const r = approvalResponse(prompt, d, d === "allow_always" ? grant : undefined, role);
    if (!r.response) return setError(r.errors.join(" ") || "Check the pattern.");
    void submit(r.response);
  };
  return (
    <Card label={`Approve ${toolName(prompt.tool)}`}>
      <View style={s.row}>
        <T style={s.h2}>Allow {toolName(prompt.tool)}?</T>
        <Badge tone={prompt.class === "destructive" ? "danger" : "plain"}>{CLASS_LABEL[prompt.class]}</Badge>
      </View>
      <T muted style={s.small}>
        {REASON[prompt.reason]}
      </T>
      {prompt.url ? <T style={s.mono}>{prompt.url}</T> : null}
      <Preview text={contentText(prompt.input)} />
      {notice ? <Notice text={notice} /> : null}
      {editing && !notice ? (
        <View style={{ gap: 8 }}>
          <T style={s.h2}>Always allow for this task</T>
          {editor.pattern_editable ? (
            <>
              <T muted style={s.small}>
                {editor.pattern_label}
              </T>
              <TextInput
                value={grant.pattern}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel={editor.pattern_label}
                onChangeText={(t) => (setError(null), setGrant({ ...grant, pattern: t }))}
                style={[s.mono, { color: p.text, borderWidth: 1, borderColor: check.errors.length ? p.danger : p.border, borderRadius: 8, padding: 8 }]}
              />
            </>
          ) : (
            <T muted style={s.small}>
              Every call to {toolName(prompt.tool)} in this task.
            </T>
          )}
          {editor.classes.length > 1 ? (
            <View style={s.row}>
              {editor.classes.map((c) => (
                <Button key={c} title={CLASS_LABEL[c]} kind={grant.class === c ? "primary" : "plain"} onPress={() => setGrant({ ...grant, class: c })} />
              ))}
            </View>
          ) : null}
          {check.errors.map((e) => (
            <ErrorText key={e} error={e} />
          ))}
          <View style={s.row}>
            <Button kind="primary" title="Save and allow" disabled={!check.proposal || check.errors.length > 0} busy={busy} onPress={() => decide("allow_always")} />
            <Button title="Back" onPress={() => setEditing(false)} />
          </View>
        </View>
      ) : null}
      {!editing && !notice ? (
        <View style={s.row}>
          <Button kind="primary" title="Allow once" busy={busy} onPress={() => decide("allow")} />
          <Button title="Deny" disabled={busy} onPress={() => decide("deny")} />
          {always ? <Button title="Always allow…" disabled={busy} onPress={() => setEditing(true)} /> : null}
        </View>
      ) : null}
      <ErrorText error={error} />
      {footer}
    </Card>
  );
}

function QuestionCard({ prompt, onAnswer, footer, notice }: { prompt: QuestionPrompt; onAnswer: OnAnswer; footer: ReactNode; notice: string | null }) {
  const { client } = useDesktop();
  const { busy, error, submit } = useSubmit(onAnswer);
  const p = usePalette();
  const [draft, setDraft] = useState<QuestionDraft>(() => initialAnswers(prompt));
  const response = questionResponse(prompt, draft, client.role);
  return (
    <Card label="Question from Claude">
      {prompt.questions.map((q, qi) => {
        const a = draft.answers[qi]!;
        return (
          <View key={qi} style={{ gap: 6 }}>
            <View style={s.row}>
              {q.header ? <Badge>{q.header}</Badge> : null}
              <T style={s.h2}>{q.question}</T>
            </View>
            {q.multi_select ? (
              <T muted style={s.small}>
                Choose any that apply.
              </T>
            ) : null}
            {q.options.map((o) => {
              const on = a.selected.includes(o.label);
              return (
                <Pressable
                  key={o.label}
                  disabled={notice !== null}
                  accessibilityRole={q.multi_select ? "checkbox" : "radio"}
                  accessibilityState={{ checked: on, disabled: notice !== null }}
                  onPress={() => setDraft(toggleOption(prompt, draft, qi, o.label))}
                  style={{ borderWidth: 1, borderColor: on ? p.accent : p.border, borderRadius: 10, padding: 10 }}
                >
                  <T>
                    {on ? (q.multi_select ? "☑ " : "◉ ") : q.multi_select ? "☐ " : "○ "}
                    {o.label}
                  </T>
                  {o.description ? (
                    <T muted style={s.small}>
                      {o.description}
                    </T>
                  ) : null}
                </Pressable>
              );
            })}
            {q.allow_freeform ? (
              <TextInput
                multiline
                editable={notice === null}
                placeholder={q.options.length ? "Or write your own" : "Your answer"}
                placeholderTextColor={p.muted}
                value={a.text}
                onChangeText={(t) => setDraft(setFreeform(draft, qi, t))}
                style={[s.body, { color: p.text, borderWidth: 1, borderColor: p.border, borderRadius: 10, padding: 10, minHeight: 60 }]}
              />
            ) : null}
          </View>
        );
      })}
      {notice ? <Notice text={notice} /> : <Button kind="primary" title="Send answer" disabled={!response} busy={busy} onPress={() => response && void submit(response)} />}
      <ErrorText error={error} />
      {footer}
    </Card>
  );
}

function AmbiguityCard({ prompt, onAnswer, notice }: { prompt: AmbiguousCallPrompt; onAnswer: OnAnswer; notice: string | null }) {
  const { busy, error, submit } = useSubmit(onAnswer);
  return (
    <Card label="Did this happen?">
      <T style={s.h2}>Did this happen?</T>
      <T>
        Homerun stopped while Claude was running {toolName(prompt.tool)}, and can't tell whether it finished. Check, then tell Claude. It won't run it again on its
        own.
      </T>
      <Preview text={contentText(prompt.input)} />
      {notice ? (
        <Notice text={notice} />
      ) : (
        <View style={s.row}>
          <Button title="Yes, it happened" disabled={busy} onPress={() => void submit({ type: "ambiguous_tool_call", outcome: "completed" })} />
          <Button title="No, it didn't run" disabled={busy} onPress={() => void submit({ type: "ambiguous_tool_call", outcome: "not_run" })} />
        </View>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

/** A resolved request, as one line in the timeline. */
export function ResolvedLine({ prompt, resolution }: { prompt: InputPrompt; resolution: InputResolution }) {
  const { client } = useDesktop();
  const runtime = useStore(client.runtime);
  const deviceId = runtime.state === "ready" ? runtime.device_id : null;
  const what =
    prompt.type === "approval"
      ? toolName(prompt.tool)
      : prompt.type === "ambiguous_tool_call"
        ? `Did ${toolName(prompt.tool)} happen?`
        : prompt.questions.map((q) => q.header ?? q.question).join(", ");
  const answers =
    resolution.response?.type === "question" ? resolution.response.answers.map((a) => [...a.selected, ...(a.text ? [a.text] : [])].join(", ")).join("; ") : null;
  return (
    <T muted style={[s.small, { textAlign: "center", paddingHorizontal: 16 }]}>
      {what}: {describeResolution(prompt, resolution, deviceId, client.role)}
      {answers ? ` — ${answers}` : ""}
    </T>
  );
}

/** One line for an inbox row or a notification-opened request. */
export function promptTitle(p: InputPrompt): string {
  switch (p.type) {
    case "approval":
      return `Allow ${toolName(p.tool)}?`;
    case "question":
      return p.questions[0]!.question + (p.questions.length > 1 ? ` (+${p.questions.length - 1} more)` : "");
    case "ambiguous_tool_call":
      return `Did ${toolName(p.tool)} happen?`;
  }
}
