import type { Database } from "bun:sqlite";
import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK SessionStore on `sdk_transcripts` (§6). SQLite is the source of truth for resume; the
 * local JSONL under CLAUDE_CONFIG_DIR is a disposable cache (F1). Entries are keyed by their
 * uuid with INSERT OR IGNORE, so a re-sent batch is stored once (F2).
 */
export class SqliteSessionStore implements SessionStore {
  constructor(private db: Database) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const subpath = key.subpath ?? "";
    const tx = this.db.transaction(() => {
      const max = this.db
        .query<{ s: number | null }, [string, string, string]>(
          "SELECT MAX(seq) AS s FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ?",
        )
        .get(key.projectKey, key.sessionId, subpath);
      let seq = (max?.s ?? 0) + 1;
      const ins = this.db.query(
        "INSERT OR IGNORE INTO sdk_transcripts (project_key, session_id, subpath, seq, uuid, entry) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const e of entries) {
        const r = ins.run(key.projectKey, key.sessionId, subpath, seq, typeof e.uuid === "string" ? e.uuid : null, JSON.stringify(e));
        if (r.changes > 0) seq++;
      }
      if (!key.subpath) {
        const prevRow = this.db
          .query<{ mtime: number; data: string }, [string, string]>(
            "SELECT mtime, data FROM sdk_session_summaries WHERE project_key = ? AND session_id = ?",
          )
          .get(key.projectKey, key.sessionId);
        const prev: SessionSummaryEntry | undefined = prevRow
          ? { sessionId: key.sessionId, mtime: prevRow.mtime, data: JSON.parse(prevRow.data) }
          : undefined;
        const next = foldSessionSummary(prev, key, entries, { mtime: Date.now() });
        this.db
          .query(
            "INSERT INTO sdk_session_summaries (project_key, session_id, mtime, data) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(project_key, session_id) DO UPDATE SET mtime = excluded.mtime, data = excluded.data",
          )
          .run(key.projectKey, key.sessionId, next.mtime, JSON.stringify(next.data));
      }
    });
    tx();
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.db
      .query<{ entry: string }, [string, string, string]>(
        "SELECT entry FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY seq",
      )
      .all(key.projectKey, key.sessionId, key.subpath ?? "");
    return rows.length ? rows.map((r) => JSON.parse(r.entry)) : null;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return this.db
      .query<{ sessionId: string; mtime: number }, [string]>(
        "SELECT session_id AS sessionId, mtime FROM sdk_session_summaries WHERE project_key = ?",
      )
      .all(projectKey);
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    return this.db
      .query<{ sessionId: string; mtime: number; data: string }, [string]>(
        "SELECT session_id AS sessionId, mtime, data FROM sdk_session_summaries WHERE project_key = ?",
      )
      .all(projectKey)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  async delete(key: SessionKey): Promise<void> {
    if (key.subpath) {
      this.db
        .query("DELETE FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ?")
        .run(key.projectKey, key.sessionId, key.subpath);
      return;
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM sdk_transcripts WHERE project_key = ? AND session_id = ?").run(key.projectKey, key.sessionId);
      this.db.query("DELETE FROM sdk_session_summaries WHERE project_key = ? AND session_id = ?").run(key.projectKey, key.sessionId);
    })();
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.db
      .query<{ subpath: string }, [string, string]>(
        "SELECT DISTINCT subpath FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath != ''",
      )
      .all(key.projectKey, key.sessionId)
      .map((r) => r.subpath);
  }
}

/** The project key the runtime's sessions live under (CLAUDE_CODE_PROJECT_DIR_NAME, §5.3). */
export const PROJECT_KEY = "homerun";

/** Main-transcript entries of a session, parsed, in order. */
export function transcriptEntries(db: Database, sessionId: string, projectKey = PROJECT_KEY): Array<Record<string, unknown>> {
  return db
    .query<{ entry: string }, [string, string]>("SELECT entry FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND subpath = '' ORDER BY seq")
    .all(projectKey, sessionId)
    .map((r) => JSON.parse(r.entry) as Record<string, unknown>);
}

export interface TranscriptToolState {
  /** tool_use ids the transcript shows the model issuing. */
  uses: Set<string>;
  /** tool_use ids with a tool_result entry, and whether it was an error. */
  results: Map<string, { isError: boolean; content: unknown }>;
}

/** Tool uses and results recorded in a session's transcript, for crash recovery (§5.4). */
export function transcriptToolState(db: Database, sessionId: string): TranscriptToolState {
  const uses = new Set<string>();
  const results = new Map<string, { isError: boolean; content: unknown }>();
  for (const e of transcriptEntries(db, sessionId)) {
    const msg = e.message as { content?: unknown } | undefined;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use" && typeof b.id === "string") uses.add(b.id);
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") results.set(b.tool_use_id, { isError: b.is_error === true, content: b.content });
    }
  }
  return { uses, results };
}

/** Whether any transcript entry carries this uuid, or quotes this exact text as a user prompt. */
export function transcriptHasInput(db: Database, sessionId: string, uuid: string, text: string): boolean {
  const byUuid = db
    .query("SELECT 1 FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND uuid = ? LIMIT 1")
    .get(PROJECT_KEY, sessionId, uuid);
  if (byUuid) return true;
  const needle = JSON.stringify(text).slice(1, -1);
  if (needle.length < 8) return false;
  return !!db
    .query("SELECT 1 FROM sdk_transcripts WHERE project_key = ? AND session_id = ? AND instr(entry, ?) > 0 LIMIT 1")
    .get(PROJECT_KEY, sessionId, needle);
}
