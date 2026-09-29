import { randomUUID } from "node:crypto";
import { appendTranscript, PROJECT_KEY } from "./session-store";
import type { Store } from "./store";

/**
 * Reading and writing a session's stored transcript for crash resume (§5.4).
 *
 * `claude` links conversation entries by `parentUuid` and resumes by walking back from the
 * newest one (the leaf). Bookkeeping entries (queue operations, `last-prompt`, …) have no uuid
 * and are not part of the chain. A truncating resume (`resumeSessionAt`) starts a new branch
 * from an earlier entry, so the live conversation is the chain, not every stored entry.
 */

export type Entry = Record<string, unknown>;

export interface TEntry {
  seq: number;
  uuid: string;
  entry: Entry;
}

export interface ToolUse {
  id: string;
  name: string;
  /** The assistant entry that carries the `tool_use` block. */
  at: TEntry;
}

export interface ChainTools {
  uses: Map<string, ToolUse>;
  results: Map<string, { isError: boolean; content: unknown }>;
  /** `tool_use`s with no `tool_result` in the chain, in order. */
  dangling: ToolUse[];
}

export interface SessionView {
  /** The live conversation, root first. Ends at `resumeAt` when that is set. */
  chain: TEntry[];
  /** The truncation point still to apply, or null once the resumed branch exists. */
  resumeAt: string | null;
}

function isChainEntry(e: Entry): boolean {
  return typeof e.uuid === "string" && "parentUuid" in e && e.isSidechain !== true;
}

/**
 * Whether `claude` can resume this session: its stored transcript has a conversation message.
 * `claude` mirrors its transcript a little after the fact, so a crash early in a session's first
 * turn can leave a session id with nothing stored; resuming that fails ("No conversation found").
 */
export function hasConversation(store: Store, sessionId: string): boolean {
  return !!store.db
    .query(
      "SELECT 1 FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = '' AND uuid IS NOT NULL " +
        "AND json_extract(entry, '$.type') IN ('user', 'assistant') AND json_extract(entry, '$.isSidechain') IS NOT 1 LIMIT 1",
    )
    .get(PROJECT_KEY, sessionId);
}

/** The main transcript's chain entries, in stored order. */
export function chainEntries(store: Store, sessionId: string): TEntry[] {
  const out: TEntry[] = [];
  for (const r of store.db
    .query<{ seq: number; entry: string }, [string, string]>("SELECT seq, entry FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = '' ORDER BY seq")
    .all(PROJECT_KEY, sessionId)) {
    const e = JSON.parse(r.entry) as Entry;
    if (isChainEntry(e)) out.push({ seq: r.seq, uuid: e.uuid as string, entry: e });
  }
  return out;
}

/** Walk back from `leaf` (default: the newest entry) to the root. */
export function chainTo(entries: readonly TEntry[], leaf?: string): TEntry[] {
  if (!entries.length) return [];
  const byUuid = new Map(entries.map((e) => [e.uuid, e]));
  let cur = leaf === undefined ? entries.at(-1) : byUuid.get(leaf);
  const out: TEntry[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    out.push(cur);
    const p = cur.entry.parentUuid;
    cur = typeof p === "string" ? byUuid.get(p) : undefined;
  }
  return out.reverse();
}

/**
 * The conversation a resume will see. With a pending truncation point, the chain ends there
 * until `claude` has written the first entry of the new branch; from then on the newest entry
 * is on that branch and the truncation is spent.
 */
export function sessionView(store: Store, sessionId: string, resumeAt: string | null): SessionView {
  const entries = chainEntries(store, sessionId);
  const live = chainTo(entries);
  if (!resumeAt) return { chain: live, resumeAt: null };
  const i = live.findIndex((e) => e.uuid === resumeAt);
  if (i < 0) return { chain: live, resumeAt: null };
  const next = live[i + 1];
  // The discarded branch: the first entry ever written after the truncation point.
  const discarded = entries.filter((e) => e.entry.parentUuid === resumeAt).sort((a, b) => a.seq - b.seq)[0];
  if (next && discarded && next.uuid !== discarded.uuid) return { chain: live, resumeAt: null };
  return { chain: live.slice(0, i + 1), resumeAt };
}

function blocks(e: Entry): Array<Record<string, unknown>> {
  const m = e.message as { content?: unknown } | undefined;
  return m && Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
}

export function chainTools(chain: readonly TEntry[]): ChainTools {
  const uses = new Map<string, ToolUse>();
  const results = new Map<string, { isError: boolean; content: unknown }>();
  for (const t of chain) {
    for (const b of blocks(t.entry)) {
      if (b.type === "tool_use" && typeof b.id === "string") uses.set(b.id, { id: b.id, name: String(b.name ?? ""), at: t });
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") results.set(b.tool_use_id, { isError: b.is_error === true, content: b.content });
    }
  }
  return { uses, results, dangling: [...uses.values()].filter((u) => !results.has(u.id)) };
}

/** Every `tool_use` id anywhere in the main transcript, on any branch. */
export function allToolUseIds(store: Store, sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const t of chainEntries(store, sessionId)) for (const b of blocks(t.entry)) if (b.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
  return ids;
}

export interface Injection {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/**
 * Write results for dangling `tool_use`s, shaped like the entries `claude` writes itself (spike
 * item 4): a user message with the `tool_result`, chained after the current leaf, pointing back
 * at the assistant entry that made the call. Returns the ids written; a call not in the chain
 * is skipped. `claude` accepts these on resume and does not add its own "interrupted" result.
 */
export function injectResults(store: Store, sessionId: string, chain: readonly TEntry[], items: readonly Injection[], now = Date.now()): string[] {
  const tools = chainTools(chain);
  let parent = chain.at(-1)?.uuid ?? null;
  const entries: Entry[] = [];
  const done: string[] = [];
  for (const it of items) {
    const use = tools.uses.get(it.toolUseId);
    if (!use || tools.results.has(it.toolUseId) || parent === null) continue;
    const from = use.at.entry;
    const uuid = randomUUID();
    const e: Entry = {
      parentUuid: parent,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ tool_use_id: it.toolUseId, type: "tool_result", content: it.text, is_error: it.isError }] },
      uuid,
      timestamp: new Date(now).toISOString(),
      toolUseResult: it.isError ? `Error: ${it.text}` : it.text,
      sourceToolAssistantUUID: use.at.uuid,
    };
    for (const k of ["userType", "entrypoint", "cwd", "sessionId", "version", "gitBranch"]) if (from[k] !== undefined) e[k] = from[k];
    entries.push(e);
    done.push(it.toolUseId);
    parent = uuid;
  }
  if (entries.length) appendTranscript(store, { projectKey: PROJECT_KEY, sessionId }, entries as never);
  return done;
}

/**
 * Where a truncating resume must start so the model never sees this call: the entry before the
 * assistant message that made it. `claude` stores each content block of a message as its own
 * entry (same `message.id`), so this is the parent of the message's first entry.
 */
export function truncationPoint(chain: readonly TEntry[], toolUseId: string): string | null {
  let i = chain.findIndex((t) => blocks(t.entry).some((b) => b.type === "tool_use" && b.id === toolUseId));
  if (i < 0) return null;
  const msgId = (chain[i]!.entry.message as { id?: unknown } | undefined)?.id;
  while (i > 0 && msgId !== undefined && (chain[i - 1]!.entry.message as { id?: unknown } | undefined)?.id === msgId) i--;
  const p = chain[i]!.entry.parentUuid;
  return typeof p === "string" ? p : null;
}
