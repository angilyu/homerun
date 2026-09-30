// Runs the relay Worker in workerd (through wrangler's startWorker) for the test suite, which
// can't host it from Bun. Vars come as JSON in argv[2] and another config may come in argv[3]
// (relative to the relay); prints {"url": ...} once it's ready and
// stops when stdin closes. Node only: wrangler's dev server hangs under Bun.
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const vars = JSON.parse(process.argv[2] ?? "{}");
const worker = await unstable_startWorker({
  config: fileURLToPath(new URL(`../${process.argv[3] ?? "wrangler.jsonc"}`, import.meta.url)),
  envFiles: [],
  bindings: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: "plain_text", value: String(v) }])),
  dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false, watch: false, logLevel: "warn" },
});
await worker.ready;
const url = await worker.url;
process.stdout.write(`${JSON.stringify({ url: url.origin })}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.dispose().catch(() => {});
  process.exit(0);
};
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
