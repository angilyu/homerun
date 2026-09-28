import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { sessionSpec } from "../../../homerund/test/helpers";
import { HOMERUND_DIR, Homerund, REPLAY_KEY, scratchDir } from "../../../homerund/test/replay/harness";
import { ReplayServer } from "../../../homerund/test/replay/replay-server";
import { cli, events } from "../e2e/support";

/**
 * The CLI driving a real `homerund serve` and the real bundled `claude`, against homerund's
 * recorded cassettes (§16.2). The CLI sends the same prompts and specs as homerund's `text-chat`
 * and `bash-tool` scenarios, so their cassettes replay unchanged: no key, no network, no
 * re-recording. Replay only; the cassettes are recorded by homerund's scenarios.
 */
const CASSETTES = join(HOMERUND_DIR, "test", "replay", "cassettes");
const SDK_PKG = JSON.parse(readFileSync(join(HOMERUND_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")) as { version: string; claudeCodeVersion: string };
const TIMEOUT = 90_000;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) if (!process.env.HOMERUN_REPLAY_KEEP) rmSync(r, { recursive: true, force: true });
});

interface Scene {
  root: string;
  work: string;
  dataDir: string;
}

/** The same layout as homerund's scenes (`<root>/data`, `<root>/work`), so paths normalise alike. */
async function scene(name: string, body: (s: Scene) => Promise<void>): Promise<void> {
  const root = scratchDir("hr-cli-replay-");
  roots.push(root);
  const work = join(root, "work");
  const dataDir = join(root, "data");
  mkdirSync(work);
  mkdirSync(dataDir);
  const normalize: Array<[string, string]> = [
    [realpathSync(root), "<ROOT_REAL>"],
    [root, "<ROOT>"],
    [homedir(), "<HOME>"],
  ];
  if (userInfo().username.length >= 4) normalize.push([userInfo().username, "<USER>"]);
  const server = new ReplayServer({ mode: "replay", scenario: name, cassettePath: join(CASSETTES, `${name}.json`), normalize, expectKey: REPLAY_KEY }).start();
  const hr = new Homerund({ dataDir, baseUrl: server.url });
  try {
    await hr.start();
    // homerund's harness plays the shell and sets the key; the CLI uses the dev token.
    await hr.shell(REPLAY_KEY);
    await body({ root, work, dataDir });
    server.finish({ claude: SDK_PKG.claudeCodeVersion, sdk: SDK_PKG.version, model: "claude-haiku-4-5", note: "" });
    expect(server.errors).toEqual([]);
  } catch (e) {
    if (server.errors.length) console.error(`replay server errors for ${name}:\n${server.errors.join("\n")}`);
    console.error(`homerund stderr (last 40 lines) for ${name}:\n${hr.stderr.split("\n").slice(-40).join("\n")}`);
    throw e;
  } finally {
    server.stop();
    await hr.stop().catch(() => {});
  }
}

describe("the CLI against real claude (replay)", () => {
  test(
    "send --new streams a chat answer to stdout; threads show prints the transcript",
    () =>
      scene("text-chat", async (s) => {
        const r = await cli(s.dataDir, ["send", "--new", "--title", "text", "In two short sentences, what is a home run in baseball? Do not use any tools."], { timeoutMs: TIMEOUT - 10_000 });
        expect(r.stderr).toMatch(/^new thread [0-9a-f]{8}\n/);
        expect(r.stderr).toMatch(/— done · \$0\.\d{4}\n$/);
        expect(r.code).toBe(0);
        const answer = r.stdout.trim();
        expect(answer.length).toBeGreaterThan(20);
        expect(r.stdout).toBe(`${answer}\n`);

        const list = await cli(s.dataDir, ["--json", "threads", "list"]);
        const [thread] = (JSON.parse(list.stdout) as { threads: Array<{ thread_id: string; title: string }> }).threads;
        expect(thread!.title).toBe("text");
        const show = await cli(s.dataDir, ["threads", "show", thread!.thread_id.slice(0, 6)]);
        expect(show.code).toBe(0);
        expect(show.stdout).toContain("you› In two short sentences");
        expect(show.stdout).toContain(`claude› ${answer.split("\n")[0]}`);
        const json = await cli(s.dataDir, ["--json", "threads", "show", thread!.thread_id]);
        const types = (JSON.parse(json.stdout) as { events: Array<{ type: string }> }).events.map((e) => e.type);
        expect(types[0]).toBe("user.message");
        expect(types.at(-1)).toBe("run.end");
      }),
    TIMEOUT,
  );

  test(
    "a Bash task: created from a spec file, streamed as NDJSON, and its output blob fetched",
    () =>
      scene("bash-tool", async (s) => {
        const specFile = join(s.root, "spec.json");
        writeFileSync(specFile, JSON.stringify(sessionSpec({ max_run_usd: 0.05, roots: [s.work], builtin: ["Bash"] })));
        const created = await cli(s.dataDir, ["--json", "tasks", "create", "--spec", specFile]);
        expect(created.code).toBe(0);
        const { thread_id } = JSON.parse(created.stdout) as { thread_id: string };

        const r = await cli(s.dataDir, ["--json", "send", thread_id, "-"], {
          stdin: 'Run exactly this bash command once, unchanged: echo homerun > out.txt && echo "home=$HOME" && seq 1 3000\nThen reply with just the word done.',
          timeoutMs: TIMEOUT - 10_000,
        });
        expect(r.code).toBe(0);
        const ev = events(r.stdout);
        const call = ev.find((e) => e.type === "tool.call");
        const result = ev.find((e) => e.type === "tool.result");
        expect(call?.type === "tool.call" && call.payload).toMatchObject({ tool: "Bash", class: "destructive" });
        expect(result?.type === "tool.result" && result.payload).toMatchObject({ status: "ok", output: { kind: "blob" } });
        expect(ev.at(-1)).toMatchObject({ type: "run.end", payload: { state: "succeeded" } });
        expect(readFileSync(join(s.work, "out.txt"), "utf8")).toBe("homerun\n");

        const sha = result?.type === "tool.result" && result.payload.output?.kind === "blob" ? result.payload.output.sha256 : "";
        const blob = await cli(s.dataDir, ["blob", sha]);
        expect(blob.code).toBe(0);
        // The blob holds the tool's output as stored: Bash's result object, as JSON.
        const { stdout } = JSON.parse(blob.stdout) as { stdout: string };
        expect(stdout).toContain(`home=${join(s.dataDir, "shell-home")}`);
        expect(stdout).toContain("\n2999\n");

        const show = await cli(s.dataDir, ["threads", "show", thread_id]);
        expect(show.stdout).toContain("▸ Bash echo homerun > out.txt");
        // The preview is Bash's stdout, decoded from the start of the stored JSON.
        expect(show.stdout).toMatch(/\n +home=\S+shell-home\n +1\n +2\n/);
        expect(show.stdout).toContain(`homerun blob ${sha}`);
      }),
    TIMEOUT,
  );
});
