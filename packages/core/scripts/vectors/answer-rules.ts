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
const ambiguousOf = (tool: string, cls: string) => ({
  type: "ambiguous_tool_call",
  tool,
  tool_call_id: F.TOOL_CALL,
  class: cls,
  input: F.inline({ file_path: "/Users/me/notes.md" }),
});
// §5.4 resumes read calls without asking, so only the write and destructive prompts occur in
// practice. The read case pins the class rule anyway.
const ambiguous = ambiguousOf("Write", "write");
const notRun = { type: "ambiguous_tool_call", outcome: "not_run" };
const PROMPTS: [string, unknown, unknown][] = [
  ["read approval", approval("read"), { type: "approval", decision: "allow" }],
  ["write approval", approval("write"), { type: "approval", decision: "allow" }],
  ["destructive approval", approval("destructive"), { type: "approval", decision: "allow" }],
  ["question", F.questionPrompt(), { type: "question", answers: [{ selected: ["main"] }] }],
  ["did this happen (read)", ambiguousOf("Read", "read"), notRun],
  ["did this happen (write)", ambiguous, notRun],
  ["did this happen (destructive)", ambiguousOf("mcp__github__delete_repository", "destructive"), notRun],
];

// Columns follow PROMPTS: approvals read/write/destructive, question, did-this-happen read/write/destructive.
const T = true;
const f = false;
const IN_APP: Record<string, boolean[]> = {
  shell: [T, T, T, T, T, T, T],
  webview: [T, T, T, T, T, T, T],
  ios: [T, T, T, T, T, T, T],
  cli_dev: [T, T, T, T, T, T, T],
  cli: [f, f, f, T, f, f, f],
  web: [T, f, f, T, T, f, f],
};
const IOS_NOTIFICATION = [T, T, f, T, f, f, f];

const always = {
  type: "approval",
  decision: "allow_always",
  grant: { tool: "Bash", pattern: "npm install *", class: "write" },
};
const alwaysFor = (grant: Record<string, unknown>) => ({ type: "approval", decision: "allow_always", grant });
/** An unmatched Bash command: destructive by default, so its grant names a class (§5.5, §5.6). */
const bashDefault = F.approvalPrompt({ class: "destructive", reason: "not_allowlisted" });
const untrustedMcp = F.approvalPrompt({
  tool: "mcp__github__create_issue",
  class: "destructive",
  reason: "untrusted_tool",
  input: F.inline({ title: "Bug" }),
  suggested_grant: undefined,
});
const declaredDestructive = F.approvalPrompt({
  tool: "mcp__github__delete_repository",
  class: "destructive",
  reason: "destructive",
  input: F.inline({ repo: "x" }),
  suggested_grant: undefined,
});
const taintedFetch = F.approvalPrompt({
  tool: "WebFetch",
  class: "network",
  reason: "tainted_egress",
  input: F.inline({ url: "https://api.github.com/repos?q=1", prompt: "p" }),
  url: "https://api.github.com/repos?q=1",
  suggested_grant: { tool: "WebFetch", pattern: "api.github.com", class: "network" },
});

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
  { name: "shell: always allow an unmatched Bash command", prompt: bashDefault, response: always, from: { role: "shell", via: "app" }, allowed: true },
  { name: "shell: always allow must cover the call", prompt: bashDefault, response: alwaysFor({ tool: "Bash", pattern: "npm test", class: "write" }), from: { role: "shell", via: "app" }, allowed: false },
  { name: "shell: always allow not offered", prompt: F.approvalPrompt({ offer_always: false }), response: always, from: { role: "shell", via: "app" }, allowed: false },
  { name: "shell: trust an untrusted MCP tool", prompt: untrustedMcp, response: alwaysFor({ tool: "mcp__github__create_issue", pattern: null, class: "write" }), from: { role: "shell", via: "app" }, allowed: true },
  { name: "shell: never always allow a declared destructive tool", prompt: declaredDestructive, response: alwaysFor({ tool: "mcp__github__delete_repository", pattern: null, class: "write" }), from: { role: "shell", via: "app" }, allowed: false },
  { name: "shell: always allow a domain in a tainted run", prompt: taintedFetch, response: alwaysFor({ tool: "WebFetch", pattern: "api.github.com", class: "network" }), from: { role: "shell", via: "app" }, allowed: true },
  { name: "shell: a wildcard domain grant covers a subdomain", prompt: taintedFetch, response: alwaysFor({ tool: "WebFetch", pattern: "*.github.com", class: "network" }), from: { role: "shell", via: "app" }, allowed: true },
  { name: "shell: a domain grant must cover the host", prompt: taintedFetch, response: alwaysFor({ tool: "WebFetch", pattern: "github.com", class: "network" }), from: { role: "shell", via: "app" }, allowed: false },
  { name: "cli: deny is still an approval answer", prompt: approval("write"), response: { type: "approval", decision: "deny" }, from: { role: "cli", via: "app" }, allowed: false },
  { name: "cli: did this happen, completed", prompt: ambiguous, response: { type: "ambiguous_tool_call", outcome: "completed" }, from: { role: "cli", via: "app" }, allowed: false },
];
