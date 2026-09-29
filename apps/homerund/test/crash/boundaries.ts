import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Names the kind of each crash boundary, so a sampled sweep can cover every kind (§16.2).
 *
 * A commit's kind is what it changed: the types of the thread events it appended, and the other
 * tables whose rows changed, e.g. `commit:tool.call+runs` or `commit:schedule_fires`. Boundaries
 * inside the simulated tool are `tool:before_effect` and `tool:after_effect`. Only the life that
 * counts a sweep's boundaries labels them; it reads every table after each commit, which is cheap
 * at test sizes. What a data dir already held when the life began is not a change.
 */
export class BoundaryKinds {
  readonly kinds: string[] = [];
  private eventSeq = 0;
  private sigs = new Map<string, string>();

  private conn: Database | null = null;

  /** Call before the runtime starts, so a data dir from an earlier life counts as the baseline. */
  constructor(private readonly dataDir: string) {
    const db = this.db();
    if (db) this.diff(db);
  }

  /** A reader of its own, so labelling never touches the runtime's connection. */
  private db(): Database | null {
    if (this.conn) return this.conn;
    const path = join(this.dataDir, "homerun.db");
    if (!existsSync(path)) return null;
    try {
      this.conn = new Database(path, { readonly: true });
      return this.conn;
    } catch {
      return null;
    }
  }

  commit(): void {
    this.kinds.push(`commit:${this.changes().join("+") || "none"}`);
  }

  tool(where: "before_effect" | "after_effect"): void {
    this.kinds.push(`tool:${where}`);
  }

  private changes(): string[] {
    const db = this.db();
    if (!db) return ["startup"];
    try {
      return this.diff(db);
    } catch {
      return ["startup"];
    }
  }

  private diff(db: Database): string[] {
    const out: string[] = [];
    const types = db
      .query<{ seq: number; type: string }, [number]>("SELECT seq, type FROM thread_events WHERE seq > ? ORDER BY seq")
      .all(this.eventSeq);
    for (const e of types) if (!out.includes(e.type)) out.push(e.type);
    if (types.length) this.eventSeq = types.at(-1)!.seq;
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('thread_events', 'sqlite_sequence') ORDER BY name")
      .all()
      .map((t) => t.name);
    for (const t of tables) {
      const rows = db.query(`SELECT * FROM "${t}"`).all();
      const sig = createHash("sha1").update(JSON.stringify(rows)).digest("hex");
      if (this.sigs.has(t) && this.sigs.get(t) !== sig) out.push(t);
      else if (!this.sigs.has(t) && rows.length) out.push(t);
      this.sigs.set(t, sig);
    }
    return out;
  }
}
