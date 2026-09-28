import * as F from "./fixtures";

/**
 * Golden cases for `checkResponse` (§5.2, §5.6, §9.7, §9.9). These rules depend on who answers,
 * so they are not schema vectors: each case is a prompt, a response, the answering caller, and
 * whether the runtime must accept the answer. `allowed` is written by hand, never computed.
 */
export type AnswerRuleCase = {
  name: string;
  prompt: unknown;
  response: unknown;
  from: { role: string; via: "app" | "notification" };
  allowed: boolean;
};

const approval = (cls: string) => F.approvalPrompt({ class: cls });
const ambiguous = {
  type: "ambiguous_tool_call",
  tool: "Write",
  tool_call_id: F.TOOL_CALL,
  class: "write",
  input: F.inline({ file_path: "/Users/me/notes.md" }),
};
const PROMPTS: [string, unknown, unknown][] = [
  ["read approval", approval("read"), { type: "approval", decision: "allow" }],
  ["write approval", approval("write"), { type: "approval", decision: "allow" }],
  ["destructive approval", approval("destructive"), { type: "approval", decision: "allow" }],
  ["question", F.questionPrompt(), { type: "question", answers: [{ selected: ["main"] }] }],
  ["did this happen", ambiguous, { type: "ambiguous_tool_call", outcome: "not_run" }],
];

// Rows follow PROMPTS: read, write, destructive, question, did-this-happen.
const IN_APP: Record<string, boolean[]> = {
  shell: [true, true, true, true, true],
  webview: [true, true, true, true, true],
  ios: [true, true, true, true, true],
  cli_dev: [true, true, true, true, true],
  cli: [false, false, false, true, false],
  web: [true, false, false, true, true],
};
const IOS_NOTIFICATION = [true, true, false, true, false];

const always = {
  type: "approval",
  decision: "allow_always",
  grant: { tool: "Bash", pattern: "npm install", class: "write" },
};

export const answerRules: AnswerRuleCase[] = [
  ...Object.entries(IN_APP).flatMap(([role, row]) =>
    PROMPTS.map(([what, prompt, response], i) => ({
      name: `${role}: ${what}`,
      prompt,
      response,
      from: { role, via: "app" as const },
      allowed: row[i]!,
    })),
  ),
  ...PROMPTS.map(([what, prompt, response], i) => ({
    name: `ios notification: ${what}`,
    prompt,
    response,
    from: { role: "ios", via: "notification" as const },
    allowed: IOS_NOTIFICATION[i]!,
  })),
  { name: "webview: always allow", prompt: approval("write"), response: always, from: { role: "webview", via: "app" }, allowed: true },
  { name: "cli_dev: always allow", prompt: approval("write"), response: always, from: { role: "cli_dev", via: "app" }, allowed: true },
  { name: "cli: always allow", prompt: approval("write"), response: always, from: { role: "cli", via: "app" }, allowed: false },
  { name: "web: always allow", prompt: approval("write"), response: always, from: { role: "web", via: "app" }, allowed: false },
  { name: "ios notification: always allow", prompt: approval("write"), response: always, from: { role: "ios", via: "notification" }, allowed: false },
  { name: "cli: deny is still an approval answer", prompt: approval("write"), response: { type: "approval", decision: "deny" }, from: { role: "cli", via: "app" }, allowed: false },
  { name: "cli: did this happen, completed", prompt: ambiguous, response: { type: "ambiguous_tool_call", outcome: "completed" }, from: { role: "cli", via: "app" }, allowed: false },
];
