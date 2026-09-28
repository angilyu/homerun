/**
 * One life of homerund for the crash harness (crash.test.ts): start the runtime on a data dir
 * with the simulated `claude`, make sure the scenario's message was sent (as a client retrying
 * after a crash would), answer "Did this happen?" truthfully from the ledger, and wait for the
 * thread to settle. `killAt` SIGKILLs this process at that boundary; `dieAt` kills `claude` alone.
 * Prints `{"points": n}` when it ends on its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, type Origin, type RunState } from "@homerun/core";
import { loadConfig } from "../../src/config";
import { setLogSink } from "../../src/log";
import { RpcClient } from "../../src/rpc/client";
import { startRuntime } from "../../src/runtime";
import { pendingInputRequests } from "../../src/store/rows";
import { Store } from "../../src/store/store";
import { MOCK_KEY } from "../helpers";
import { SCENARIOS, type ChildArgs, CLIENT_MSG_ID, TOKEN } from "./scenarios";
import { SimEngine } from "./sim-claude";

const args = JSON.parse(process.argv[2]!) as ChildArgs;
const scenario = SCENARIOS[args.scenario]!;
const ledger = join(args.dir, "ledger");

let points = 0;
let dying = false;
const point = () => {
  points++;
  if (args.killAt === points) process.kill(process.pid, "SIGKILL");
  if (args.dieAt === points) dying = true;
};
Store.commitObserver = point;
setLogSink(() => {}, "error");

const config = loadConfig({
  env: {
    HOMERUN_DATA_DIR: args.dir,
    HOMERUN_CLAUDE_PATH: "/usr/bin/false",
    HOME: args.dir,
    HOMERUN_DEV_AUTO_APPROVE: "1",
    ...(args.mode ? { HOMERUN_DEV_AMBIGUITY_MODE: args.mode } : {}),
  },
});
let engineDied = false;
const rt = await startRuntime({
  config,
  launchToken: TOKEN,
  engine: (store) =>
    new SimEngine(store, scenario.plan, ledger, {
      point,
      dead: () => {
        if (dying && !engineDied) {
          engineDied = true;
          return true;
        }
        return false;
      },
    }),
  setTmpdir: false,
});
rt.secrets.set("anthropic_api_key", MOCK_KEY);
const origin: Origin = { device_id: rt.device.device_id, surface: "desktop" };

const existing = rt.store.db.query<{ thread_id: string }, []>("SELECT thread_id FROM threads WHERE task_id IS NOT NULL").get();
const threadId = existing?.thread_id ?? rt.manager.createTask(scenario.spec as never).thread.thread_id;
rt.manager.sendMessage({ thread_id: threadId, client_msg_id: CLIENT_MSG_ID, text: scenario.message }, origin);

const shell = await RpcClient.open(config.socketPath, "shell", { kind: "launch_token", token: TOKEN });
const happened = (toolCallId: string) => existsSync(ledger) && readFileSync(ledger, "utf8").split("\n").some((l) => l.endsWith(` ${toolCallId}`));

const deadline = Date.now() + 15_000;
for (;;) {
  for (const r of pendingInputRequests(rt.store, { threadId })) {
    if (r.prompt.type !== "ambiguous_tool_call") continue;
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
console.log(JSON.stringify({ points }));
process.exit(0);
