import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Cassettes (§16.2): real Messages API exchanges, recorded once and replayed in CI with no key.
 *
 * A request is identified by a fingerprint, not its bytes: the model, the tool names, and per
 * message the role and a skeleton of its blocks (user text with system reminders stripped,
 * tool_use ids and names, tool_result ids and is_error). Temp paths, the home directory and
 * dates never reach a fingerprint. System prompts, tool schemas and headers are not stored, so
 * cassettes stay a few KB and hold nothing sensitive.
 */
export const CASSETTE_VERSION = 1;

export type Skeleton =
  | { t: "text"; text: string }
  | { t: "tool_use"; id: string; name: string }
  | { t: "tool_result"; id: string; is_error: boolean; steer?: string[] }
  | { t: "thinking" | "redacted_thinking" | "image" | "document" | "other" };

export interface Fingerprint {
  path: string;
  model: string | null;
  tools: string[];
  messages: Array<{ role: string; blocks: Skeleton[] }>;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface Entry {
  summary: string;
  request: Fingerprint;
  response: { status: number; events?: SseEvent[]; body?: unknown };
}

export interface Cassette {
  version: number;
  scenario: string;
  recorded_with: { claude_agent_sdk: string; claude: string; model: string };
  note: string;
  entries: Entry[];
}

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: string | Block[] };

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const STEER = /The user sent a new message while you were working:\n([\s\S]*?)(?:\n\n|$)/g;

export function blocksOf(m: Msg): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}

function textOfResult(b: Block): string {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) return (b.content as Block[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("\n");
  return "";
}

export interface Normalizer {
  (s: string): string;
}

/** Replace machine-specific strings (temp dirs, home, user name) with placeholders. */
export function normalizer(pairs: Array<[string, string]>): Normalizer {
  const sorted = [...pairs].filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
  return (s) => {
    let out = s;
    for (const [from, to] of sorted) out = out.split(from).join(to);
    return out;
  };
}

export function fingerprint(path: string, body: Record<string, unknown>, norm: Normalizer): Fingerprint {
  const messages = (body.messages as Msg[] | undefined) ?? [];
  return {
    path,
    model: typeof body.model === "string" ? body.model : null,
    tools: ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((t) => t.name ?? "?").sort(),
    messages: messages.map((m) => ({
      role: m.role,
      blocks: blocksOf(m).flatMap((b): Skeleton[] => {
        switch (b.type) {
          case "text": {
            const text = norm(String(b.text ?? "").replace(REMINDER, "")).replace(/\s+/g, " ").trim();
            return text ? [{ t: "text", text }] : [];
          }
          case "tool_use":
            return [{ t: "tool_use", id: String(b.id), name: String(b.name) }];
          case "tool_result": {
            const steer = [...textOfResult(b).matchAll(STEER)].map((x) => norm(x[1]!).trim());
            return [{ t: "tool_result", id: String(b.tool_use_id), is_error: b.is_error === true, ...(steer.length ? { steer } : {}) }];
          }
          case "thinking":
          case "redacted_thinking":
          case "image":
          case "document":
            return [{ t: b.type }];
          default:
            return [{ t: "other" }];
        }
      }),
    })),
  };
}

export const fpKey = (f: Fingerprint) => JSON.stringify(f);

/** One line for humans reading a cassette: the last user turn → what the model did. */
export function summarize(f: Fingerprint, events: SseEvent[] | undefined): string {
  const last = f.messages.at(-1);
  const input = last
    ? last.blocks.map((b) => (b.t === "text" ? JSON.stringify(b.text.slice(0, 60)) : b.t === "tool_result" ? `tool_result(${b.is_error ? "error" : "ok"})` : b.t)).join(" + ")
    : "(none)";
  const out: string[] = [];
  for (const e of events ?? []) {
    const d = e.data as { type?: string; content_block?: { type: string; name?: string } };
    if (e.event === "content_block_start" && d.content_block) out.push(d.content_block.type === "tool_use" ? `tool_use ${d.content_block.name}` : d.content_block.type);
  }
  return `${f.path} ${input} → ${out.join(", ") || "(no content)"}`;
}

/** First difference between two fingerprints, for a readable mismatch report. */
export function diff(a: Fingerprint, b: Fingerprint): string {
  for (const k of ["path", "model"] as const) if (a[k] !== b[k]) return `${k}: ${JSON.stringify(a[k])} vs recorded ${JSON.stringify(b[k])}`;
  if (fpKey({ ...a, messages: [] }) !== fpKey({ ...b, messages: [] })) return `tools: ${a.tools.join(",")} vs recorded ${b.tools.join(",")}`;
  const n = Math.max(a.messages.length, b.messages.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a.messages[i] ?? null);
    const y = JSON.stringify(b.messages[i] ?? null);
    if (x !== y) return `messages[${i}]:\n  got      ${x}\n  recorded ${y}`;
  }
  return "(identical)";
}

export function loadCassette(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  const c = JSON.parse(readFileSync(path, "utf8")) as Cassette;
  if (c.version !== CASSETTE_VERSION) throw new Error(`${path}: cassette version ${c.version}, expected ${CASSETTE_VERSION}; re-record it`);
  return c;
}

/** Known dummy keys that may appear in the repository. Anything else shaped like a key is a leak. */
/** Kept in sync with scripts/check-no-secrets.sh. */
export const ALLOWED_KEYS = ["sk-ant-replay-not-a-key", "sk-ant-mock-not-a-real-key", "sk-ant-mock-not-a-key", "sk-ant-TEST-not-a-real-key"];
export const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/** Scrub secrets and machine-specific strings from everything written to a cassette. */
export function redact(text: string, secrets: string[], norm: Normalizer): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  out = out.replace(KEY_PATTERN, (m) => (ALLOWED_KEYS.includes(m) ? m : "[REDACTED]"));
  return norm(out);
}

export function saveCassette(path: string, c: Cassette, secrets: string[], norm: Normalizer): void {
  const text = redact(JSON.stringify(c, null, 1) + "\n", secrets, norm);
  if (/"(x-api-key|authorization)"\s*:/i.test(text)) throw new Error("refusing to write a cassette containing credential headers");
  writeFileSync(path, text);
}
