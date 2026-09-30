/**
 * Scripted stand-in for the Anthropic Messages API (ANTHROPIC_BASE_URL target), used when
 * no real API key is available. It lets items 1–5 exercise the *real* Agent SDK and the
 * *real* bundled `claude` binary end to end: only the model is replaced.
 *
 * Faithfulness where it matters:
 *  - SSE streaming in the documented event format (message_start … message_stop).
 *  - The API's tool_use/tool_result pairing rule: a tool_use not answered by a tool_result
 *    in the next user message is rejected with the same 400 the real API returns.
 *    This is the crux of item 4 (what does claude send after a mid-tool-call kill?).
 *  - Every request body is recorded to <outdir>/NNN-<path>.json.
 *
 * The "model" is a deterministic policy over the conversation:
 *  - Backticked commands in user instructions are run with Bash, one per turn, in order
 *    (all at once if the instruction says "in parallel"). A command whose tool_result says it
 *    was interrupted counts as not done — i.e. a model that retries interrupted
 *    work when asked to continue — unless the latest instruction says "Do not run it again".
 *  - "AskUserQuestion" in the instruction → one AskUserQuestion call (Red/Blue).
 *  - "Take N seconds" in the first instruction delays the reply to it by N seconds (at most 60), so
 *    a run stays busy long enough to observe its power assertion (§8.1, update-test.sh).
 *  - Final text follows "reply with the single word X" / "Reply with exactly: X" /
 *    "if there is none, reply X" / "Then reply X", the secret-word question, and the
 *    colour question. Any BANANA-* token visible anywhere in the request is appended
 *    (a model that obeys injected memory), so leaked CLAUDE.md content is observable.
 *
 *   bun run spikes/sdk/src/mock-api.ts <port> <outdir>
 * Requests to /<label>/v1/... are recorded under <outdir>/<label>/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8770);
const out = process.argv[3] ?? ".spike/mock-api";
mkdirSync(out, { recursive: true });
let n = 0;
let idn = 0;

type Block = { type: string; [k: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };
const toolResultText = (b: Block) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));
const blocks = (m: Msg): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
// Harness-injected context is not an instruction, except relayed user messages (steering).
const stripReminders = (s: string) => s.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, (_, inner) => (/user sent|user's message|new message/i.test(inner) ? inner : "")).trim();
// Mid-turn user messages (steering) arrive inside the next tool_result as a system-reminder.
const steerOf = (b: Block) => [...toolResultText(b).replace(/\\n/g, "\n").matchAll(/The user sent a new message while you were working:\n([\s\S]*?)\n\n/g)].map((x) => x[1]!);
const textOf = (m: Msg) =>
  [...blocks(m).filter((b) => b.type === "tool_result").flatMap(steerOf), stripReminders(blocks(m).filter((b) => b.type === "text").map((b) => b.text).join("\n"))].filter(Boolean).join("\n");

function validatePairing(messages: Msg[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const ids = blocks(m).filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    const answered = new Set(next && next.role === "user" ? blocks(next).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : []);
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length)
      return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(", ")}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
  }
  return null;
}

function decide(body: any): { content: Block[]; stop: "end_turn" | "tool_use" } {
  const messages: Msg[] = body.messages ?? [];
  const toolNames = new Set((body.tools ?? []).map((t: any) => t.name));
  const instructions = messages.filter((m) => m.role === "user").map(textOf).filter(Boolean);
  const latest = instructions.at(-1) ?? "";
  const whole = JSON.stringify(body);
  const bananas = [...new Set(whole.match(/BANANA-[A-Z-]+/g) ?? [])];
  const text = (t: string): { content: Block[]; stop: "end_turn" } => ({
    content: [{ type: "text", text: [t, ...bananas].join(" ") }],
    stop: "end_turn",
  });
  const tool = (name: string, input: object): Block => ({ type: "tool_use", id: `toolu_mock_${Date.now().toString(36)}_${++idn}`, name, input });

  // Commands already attempted, and whether each finished cleanly.
  const results = new Map<string, Block>();
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const done = new Set<string>();
  let askAnswer: string | null = null;
  for (const m of messages)
    for (const b of blocks(m)) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id);
      const rt = r ? toolResultText(r) : "";
      if (b.name === "AskUserQuestion") askAnswer = rt.match(/\b(Red|Blue)\b/i)?.[1] ?? askAnswer;
      // Interrupted/unanswered calls count as not done; ordinary non-zero exits count as done.
      const failed = !r || (/interrupt|aborted|cancel/i.test(rt) && !/did complete|do not run it again/i.test(rt));
      if (b.name === "Bash" && (!failed || /do not run it again/i.test(latest))) done.add(b.input.command);
    }

  if (toolNames.has("AskUserQuestion") && /AskUserQuestion/.test(latest) && askAnswer === null && !messages.some((m) => blocks(m).some((b) => b.name === "AskUserQuestion")))
    return {
      content: [tool("AskUserQuestion", { questions: [{ question: "Which colour do you prefer?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "Red" }, { label: "Blue", description: "Blue" }] }] })],
      stop: "tool_use",
    };

  if (toolNames.has("Bash")) {
    const pending = instructions.flatMap((t) => [...t.matchAll(/`([^`]+)`/g)].map((x) => x[1]!)).filter((c) => !done.has(c) && !/^\$|^claude\b/.test(c));
    // Commands mentioned as history in a recovery note are not instructions.
    const runnable = /do not run it again/i.test(latest) ? [] : pending;
    if (runnable.length) {
      const batch = instructions.some((t) => /in parallel/i.test(t)) ? runnable : runnable.slice(0, 1);
      return { content: batch.map((command) => tool("Bash", { command, description: "mock" })), stop: "tool_use" };
    }
  }

  const secret = whole.match(/secret word is (\w+)/)?.[1];
  if (/what is the secret word/i.test(latest)) return text(secret ?? "I-DO-NOT-KNOW");
  if (/colou?r I chose/i.test(latest) || /colou?r I chose/i.test(instructions.join("\n"))) if (askAnswer) return text(askAnswer.toUpperCase());
  const directive =
    latest.match(/reply with (?:the single word|exactly:?|just:?)\s*([A-Za-z0-9-]+)/i) ??
    instructions.join("\n").match(/reply with the single word ([A-Za-z0-9-]+)/i) ??
    latest.match(/if there is none, reply ([A-Z-]+)/) ??
    latest.match(/Then reply ([A-Z]+)/);
  if (directive) return text(directive[1]!);
  const lastResult = [...results.values()].at(-1);
  return text(lastResult ? `Tool output: ${toolResultText(lastResult).slice(0, 300)}` : "ok");
}

function sse(model: string, content: Block[], stop: string, inputTokens: number): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", {
    message: { id: `msg_mock_${++idn}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  });
  content.forEach((b, index) => {
    if (b.type === "text") {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      s += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    s += ev("content_block_stop", { index });
  });
  s += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  s += ev("message_stop", {});
  return s;
}

Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    // Optional run label as a path prefix: ANTHROPIC_BASE_URL=http://127.0.0.1:8770/<label>
    const seg = url.pathname.split("/").filter(Boolean);
    const label = seg[0] && seg[0] !== "v1" ? seg.shift()! : "";
    url.pathname = "/" + seg.join("/");
    const dir = join(out, label);
    mkdirSync(dir, { recursive: true });
    const raw = req.method === "POST" ? await req.text() : "";
    const id = String(++n).padStart(3, "0");
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}
    const record = (response: unknown) =>
      writeFileSync(join(dir, `${id}-${url.pathname.replaceAll("/", "_")}.json`), JSON.stringify({ path: url.pathname, body, response }, null, 2));

    if (url.pathname.endsWith("/messages/count_tokens")) {
      record({ input_tokens: 1000 });
      return Response.json({ input_tokens: 1000 });
    }
    if (!url.pathname.endsWith("/v1/messages")) {
      record({ status: 404 });
      return Response.json({ type: "error", error: { type: "not_found_error", message: "mock: not found" } }, { status: 404 });
    }
    const bad = validatePairing(body.messages ?? []);
    if (bad) {
      const err = { type: "error", error: { type: "invalid_request_error", message: bad } };
      record({ status: 400, ...err });
      return Response.json(err, { status: 400 });
    }
    const msgs: Msg[] = body.messages ?? [];
    const first = !msgs.some((m) => m.role === "assistant") && msgs.find((m) => m.role === "user");
    const slow = first ? /\bTake (\d+) seconds\b/.exec(textOf(first)) : null;
    if (slow) await Bun.sleep(Math.min(Number(slow[1]), 60) * 1000);
    const { content, stop } = decide(body);
    record({ status: 200, content, stop });
    const inputTokens = Math.ceil(raw.length / 4);
    if (body.stream)
      return new Response(sse(body.model, content, stop, inputTokens), { headers: { "content-type": "text/event-stream", "request-id": `req_mock_${id}` } });
    return Response.json({
      id: `msg_mock_${id}`, type: "message", role: "assistant", model: body.model, content, stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 20 },
    });
  },
});
console.log(`mock Anthropic API on ${port} → ${out}`);
