import type { Database } from "bun:sqlite";
import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from "@anthropic-ai/claude-agent-sdk";

/** SessionStore adapter over the `sdk_transcripts` table (design §6). */
export class SqliteSessionStore implements SessionStore {
  /** Count of append() calls, for probes. */
  appendCalls = 0;

  constructor(private db: Database) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appendCalls++;
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

  /** Spike helper: append a raw entry (used by the item 4 injection experiment). */
  rawAppend(key: SessionKey, entry: SessionStoreEntry): Promise<void> {
    return this.append(key, [entry]);
  }

  /** Spike helper: which (project_key, session_id) pairs exist. */
  keys(): Array<{ project_key: string; session_id: string; n: number }> {
    return this.db
      .query<{ project_key: string; session_id: string; n: number }, []>(
        "SELECT project_key, session_id, COUNT(*) AS n FROM sdk_transcripts WHERE subpath = '' GROUP BY 1, 2",
      )
      .all();
  }
}
