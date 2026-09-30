/**
 * One life of homerund for the crash harness (crash.test.ts): start the runtime on a data dir
 * with the simulated `claude`, make sure the scenario's message was sent (as a client retrying
 * after a crash would), answer "Did this happen?" truthfully from the ledger, and wait for the
 * thread to settle. With `approvals`, it also approves each call and answers each question. `killAt` SIGKILLs this process at that boundary; `dieAt` kills `claude` alone.
 * Prints `{"points": n}` when it ends on its own, with each boundary's kind when `label` is set.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, type Origin, type RunState } from "@homerun/core";
import { loadConfig } from "../../src/config";
import { setLogSink } from "../../src/log";
import { RpcClient } from "../../src/rpc/client";
import { startRuntime } from "../../src/runtime";
import { NoopAssertions } from "../../src/power/power";
import { pendingInputRequests } from "../../src/store/rows";
import { Store } from "../../src/store/store";
import { MOCK_KEY } from "../helpers";
import { SCENARIOS, type ChildArgs, CLIENT_MSG_ID, HELD_MSG_ID, TOKEN } from "./scenarios";
import { BoundaryKinds } from "./boundaries";
import { SimEngine } from "./sim-claude";

const args = JSON.parse(process.argv[2]!) as ChildArgs;
const scenario = SCENARIOS[args.scenario]!;
const ledger = join(args.dir, "ledger");

let points = 0;
let dying = false;
const kinds = args.label ? new BoundaryKinds(args.dir) : null;
const point = () => {
  points++;
  if (args.killAt === points) process.kill(process.pid, "SIGKILL");
  if (args.dieAt === points) dying = true;
};
Store.commitObserver = () => {
  kinds?.commit();
  point();
};
setLogSink(() => {}, "error");

const config = loadConfig({
  env: {
    HOMERUN_DATA_DIR: args.dir,
    HOMERUN_CLAUDE_PATH: "/usr/bin/false",
    HOME: args.dir,
    ...(args.approvals ? { HOMERUN_INPUT_GRACE_MS: args.approvals === "defer" ? "0" : "600000" } : { HOMERUN_DEV_AUTO_APPROVE: "1" }),
    ...(args.mode ? { HOMERUN_DEV_AMBIGUITY_MODE: args.mode } : {}),
  },
});
let engineDied = false;
const rt = await startRuntime({
  config,
  launchToken: TOKEN,
  engine: (store) =>
    new SimEngine(store, scenario.plan, ledger, {
      point: (where) => {
        kinds?.tool(where);
        point();
      },
      dead: () => {
        if (dying && !engineDied) {
          engineDied = true;
          return true;
        }
        return false;
      },
    }, scenario.mirrorAfter),
  setTmpdir: false,
  power: new NoopAssertions(),
});
rt.secrets.set("anthropic_api_key", MOCK_KEY);
const origin: Origin = { device_id: rt.device.device_id, surface: "desktop" };

const existing = rt.store.db.query<{ thread_id: string }, []>("SELECT thread_id FROM threads WHERE task_id IS NOT NULL").get();
const threadId = existing?.thread_id ?? rt.manager.createTask(scenario.spec as never).thread.thread_id;
rt.manager.sendMessage({ thread_id: threadId, client_msg_id: CLIENT_MSG_ID, text: scenario.message }, origin);

// Every local notification this life's shell receives (§8.2), for the harness's checks: sent
// only for committed requests, at most once per key per life.
const shell = await RpcClient.connect(config.socketPath);
shell.onNotification((method, params) => {
  if (method === "notification.requested" || method === "notification.withdrawn") {
    appendFileSync(join(args.dir, "notified.ndjson"), JSON.stringify({ life: process.pid, method, key: (params as { key: string }).key }) + "\n");
  }
});
await shell.handshake("shell", { kind: "launch_token", token: TOKEN });
const happened = (toolCallId: string) => existsSync(ledger) && readFileSync(ledger, "utf8").split("\n").some((l) => l.endsWith(` ${toolCallId}`));

const deadline = Date.now() + 15_000;
for (;;) {
  for (const r of pendingInputRequests(rt.store, { threadId })) {
    // In `defer`, the user answers once the run has let its process go (§5.6).
    if (r.prompt.type !== "ambiguous_tool_call" && args.approvals === "defer" && rt.scheduler.driverFor(r.run_id)) continue;
    // The user also writes while the run waits (idempotent across lives).
    rt.manager.sendMessage({ thread_id: threadId, client_msg_id: HELD_MSG_ID, text: "Status?" }, origin);
    if (r.prompt.type === "approval") {
      await shell.call("input.answer", { request_id: r.request_id, response: { type: "approval", decision: "allow" }, via: "app" });
      continue;
    }
    if (r.prompt.type === "question") {
      const answers = r.prompt.questions.map((q) => ({ selected: [q.options[0]!.label] }));
      await shell.call("input.answer", { request_id: r.request_id, response: { type: "question", answers }, via: "app" });
      continue;
    }
    await shell.call("input.answer", {
      request_id: r.request_id,
      response: { type: "ambiguous_tool_call", outcome: happened(r.prompt.tool_call_id) ? "completed" : "not_run" },
      via: "app",
    });
  }
  const runs = rt.store.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE thread_id = ?").all(threadId);
  if (runs.length && runs.every((r) => isTerminal(r.state as RunState))) break;
  if (Date.now() > deadline) {
    console.error(`timed out: runs ${JSON.stringify(runs)}`);
    process.exit(3);
  }
  await Bun.sleep(5);
}
shell.close();
await rt.shutdown();
console.log(JSON.stringify({ points, ...(kinds ? { kinds: kinds.kinds } : {}) }));
process.exit(0);
