import type { RpcClient } from "@homerun/client";
import { CliError, EXIT, usageError } from "./exit";
import { shortId } from "./format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MIN_PREFIX = 4;

export const isFullId = (s: string) => UUID.test(s.toLowerCase());

/** A full id as given, or the one id that starts with a prefix of at least 4 characters. */
export function matchPrefix(kind: string, arg: string, ids: Iterable<string>): string {
  const a = arg.toLowerCase();
  if (isFullId(a)) return a;
  if (!/^[0-9a-f-]+$/.test(a)) throw usageError(`"${arg}" is not a ${kind} id`);
  if (a.length < MIN_PREFIX) throw usageError(`${kind} id "${arg}" is too short: give at least ${MIN_PREFIX} characters`);
  const m = [...new Set([...ids].filter((id) => id.startsWith(a)))];
  if (m.length === 1) return m[0]!;
  if (!m.length) throw new CliError(`no ${kind} matches "${arg}"`, EXIT.ERROR);
  throw usageError(`"${arg}" matches ${m.length} ${kind}s (${m.slice(0, 4).map(shortId).join(", ")}${m.length > 4 ? ", …" : ""}); give more characters`);
}

export async function allThreadIds(c: RpcClient): Promise<string[]> {
  const ids: string[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await c.call("threads.list", { limit: 500, ...(before !== undefined ? { updated_before: before } : {}) });
    ids.push(...page.threads.map((t) => t.thread_id));
    const last = page.threads.at(-1);
    if (!page.has_more || !last) return ids;
    before = last.updated_at;
  }
}

export async function resolveThread(c: RpcClient, arg: string): Promise<string> {
  return isFullId(arg) ? arg.toLowerCase() : matchPrefix("thread", arg, await allThreadIds(c));
}

/** Runs are matched among the newest 500; older ones need the full id. */
export async function resolveRun(c: RpcClient, arg: string): Promise<string> {
  if (isFullId(arg)) return arg.toLowerCase();
  const { runs } = await c.call("runs.list", { limit: 500 });
  return matchPrefix("run", arg, runs.map((r) => r.run_id));
}

export async function resolveTask(c: RpcClient, arg: string): Promise<string> {
  if (isFullId(arg)) return arg.toLowerCase();
  const { tasks } = await c.call("tasks.list", { include_archived: true });
  return matchPrefix("task", arg, tasks.map((t) => t.task_id));
}
