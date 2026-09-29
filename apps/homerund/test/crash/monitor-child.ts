/**
 * One life of homerund for the scheduler's crash sweep (monitor.test.ts). The clock is fixed for
 * the life (a fake clock that never advances), so each life evaluates the schedule once, at start,
 * like a Mac that opens its lid at that instant.
 *
 * - `setup`: create a monitor that runs every five minutes, watching ~/work/watched.txt, let its 10:05 baseline check run,
 *   stop cleanly, then change the file.
 * - otherwise: start at 11:05 (plus 10 s per later life). The slots 10:10–11:00 were missed while
 *   Homerun was not running; run_all catches up the last three, and 11:05 is on time. The first
 *   late check sees the change and acts once (a Write the ledger records).
 *
 * With `lagging`, the act's session stores nothing until its Write happened, so a crash before
 * that leaves a session `claude` cannot resume and the act step starts a new one.
 *
 * Answers "Did this happen?" from the ledger. Prints `{"points": n}` when it ends on its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../../src/config";
import { setLogSink } from "../../src/log";
import { RpcClient } from "../../src/rpc/client";
import { startRuntime } from "../../src/runtime";
import { NoopAssertions } from "../../src/power/power";
import { FakeClock } from "../../src/schedule/clock";
import { pendingInputRequests } from "../../src/store/rows";
import { Store } from "../../src/store/store";
import { MOCK_KEY, monitorSpec } from "../helpers";
import { TOKEN } from "./scenarios";
import { SimEngine, type Step } from "./sim-claude";

export interface MonitorChildArgs {
  dir: string;
  setup?: boolean;
  /** 1 for the life under test, 2… for recovery lives. */
  life?: number;
  killAt?: number;
  /** The act's session stores nothing of its conversation until its Write happened. */
  lagging?: boolean;
}

export const M_T0 = Date.UTC(2026, 0, 5, 10, 0, 30);
export const M_T1 = Date.UTC(2026, 0, 5, 11, 5);
export const ACT_PLAN: Step[] = [{ name: "report", tool: "Write", input: { file_path: "report.txt", content: "changed" } }];

const args = JSON.parse(process.argv[2]!) as MonitorChildArgs;
const ledger = join(args.dir, "ledger");

let points = 0;
Store.commitObserver = () => {
  points++;
  if (args.killAt === points) process.kill(process.pid, "SIGKILL");
};
setLogSink(() => {}, "error");

const config = loadConfig({
  env: { HOMERUN_DATA_DIR: args.dir, HOMERUN_CLAUDE_PATH: "/usr/bin/false", HOME: args.dir, HOMERUN_DEV_AUTO_APPROVE: "1" },
});
const clock = new FakeClock(args.setup ? M_T0 : M_T1 + ((args.life ?? 1) - 1) * 10_000);
const rt = await startRuntime({
  config,
  launchToken: TOKEN,
  engine: (store) =>
    new SimEngine(store, ACT_PLAN, ledger, {
      point: () => {
        points++;
        if (args.killAt === points) process.kill(process.pid, "SIGKILL");
      },
      dead: () => false,
    }, args.lagging ? "report" : undefined),
  setTmpdir: false,
  power: new NoopAssertions(),
  clock,
  deviceZone: () => "UTC",
});
rt.secrets.set("anthropic_api_key", MOCK_KEY);

const happened = (toolCallId: string) => existsSync(ledger) && readFileSync(ledger, "utf8").split("\n").some((l) => l.endsWith(` ${toolCallId}`));
const count = (sql: string) => (rt.store.db.query(sql).get() as { n: number }).n;
const settled = () =>
  count("SELECT count(*) AS n FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','abandoned')") === 0 &&
  count("SELECT count(*) AS n FROM schedule_fires WHERE state IN ('queued','started')") === 0;

if (args.setup) {
  const work = join(args.dir, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "watched.txt"), "v1");
  const spec = monitorSpec({
    schedule: { kind: "cron", cron: "*/5 * * * *", timezone: "UTC", catchup: "run_all", max_catchup: 3 },
    roots: ["~/work"],
    check: { kind: "rule", source: { type: "file_hash", path: "~/work/watched.txt" }, comparator: { op: "changed" } },
    act_instructions: "Write a report.",
  });
  (spec.tools as { builtin: string[] }).builtin = ["Read", "Write"];
  rt.manager.createTask(spec as never);
  await clock.advanceTo(Date.UTC(2026, 0, 5, 10, 5));
}

const shell = await RpcClient.open(config.socketPath, "shell", { kind: "launch_token", token: TOKEN });
const deadline = Date.now() + 15_000;
for (;;) {
  for (const r of pendingInputRequests(rt.store, {})) {
    if (r.prompt.type !== "ambiguous_tool_call") continue;
    await shell.call("input.answer", {
      request_id: r.request_id,
      response: { type: "ambiguous_tool_call", outcome: happened(r.prompt.tool_call_id) ? "completed" : "not_run" },
      via: "app",
    });
  }
  if (count("SELECT count(*) AS n FROM runs") > 0 && settled()) break;
  if (Date.now() > deadline) {
    const runs = rt.store.db.query("SELECT state, monitor_phase, scheduled_for FROM runs").all();
    const fires = rt.store.db.query("SELECT kind, state, scheduled_for, attempt FROM schedule_fires").all();
    console.error(`timed out: runs ${JSON.stringify(runs)} fires ${JSON.stringify(fires)}`);
    process.exit(3);
  }
  await Bun.sleep(5);
}
shell.close();
await rt.shutdown();
if (args.setup) writeFileSync(join(args.dir, "work", "watched.txt"), "v2");
console.log(JSON.stringify({ points }));
process.exit(0);
