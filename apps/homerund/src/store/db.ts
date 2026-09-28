import { Database } from "bun:sqlite";
import schema from "./schema.sql" with { type: "text" };

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  return db;
}

/** Append-only thread log with a monotonic seq per thread (§5.7). */
export class ThreadLog {
  constructor(private db: Database) {}

  append(threadId: string, runId: string | null, type: string, payload: unknown): number {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<{ s: number | null }, [string]>("SELECT MAX(seq) AS s FROM thread_events WHERE thread_id = ?")
        .get(threadId);
      const seq = (row?.s ?? 0) + 1;
      this.db
        .query("INSERT INTO thread_events (thread_id, seq, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(threadId, seq, runId, Date.now(), type, JSON.stringify(payload));
      return seq;
    });
    return tx();
  }

  events(threadId: string): Array<{ seq: number; run_id: string | null; type: string; payload: any }> {
    return this.db
      .query<{ seq: number; run_id: string | null; type: string; payload: string }, [string]>(
        "SELECT seq, run_id, type, payload FROM thread_events WHERE thread_id = ? ORDER BY seq",
      )
      .all(threadId)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /**
   * §5.4: a tool.call with no matching tool.result is ambiguous.
   */
  ambiguousToolCalls(threadId: string): Array<{ tool_use_id: string; tool_name: string; tool_input: unknown }> {
    const evs = this.events(threadId);
    const done = new Set(evs.filter((e) => e.type === "tool.result").map((e) => e.payload.tool_use_id));
    return evs
      .filter((e) => e.type === "tool.call" && !done.has(e.payload.tool_use_id))
      .map((e) => e.payload);
  }
}
