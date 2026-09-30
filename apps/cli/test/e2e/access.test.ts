import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RpcClient } from "@homerun/client";
import { sessionSpec, until, type SocketRuntime } from "../../../homerund/test/helpers";
import { FakeClock } from "../../../homerund/src/schedule/clock";
import type { Io } from "../../src/context";
import { main } from "../../src/main";
import { currentUserSid, privacyProblems, readPathSecurity } from "@homerun/win32";
import { cli, NO_CTRL_C, runtime, spawnCli, WIN } from "./support";

/**
 * The release role's access flow (§5.2) from a development build: `--dev-role cli` with a file
 * token store and no peer check (the peer check itself is a unit test, and a nightly macOS test
 * against a signed runtime). The app's prompt is played by a shell connection.
 */

let srt: SocketRuntime;
afterEach(async () => {
  await srt?.close();
});

const REL = ["--dev-role", "cli", "--dev-skip-peer-check"];
const storePath = () => join(srt.dir, "cli-token");
const rel = (args: string[]) => [...args, ...REL, "--dev-token-store", storePath()];

/** The app's side: a shell that records the prompts it is asked to show. */
async function app() {
  const shell = await srt.shell();
  const got: Array<{ method: string; params: any }> = [];
  shell.onNotification((method, params) => got.push({ method, params }));
  return {
    shell,
    of: (m: string) => got.filter((n) => n.method === m).map((n) => n.params),
    next: async (m: string, i = 0) => {
      await until(() => got.filter((n) => n.method === m).length > i, 10_000, m);
      return got.filter((n) => n.method === m)[i]!.params;
    },
  };
}

async function login(a: Awaited<ReturnType<typeof app>>, i = 0) {
  const p = spawnCli(srt.dir, rel(["login"]));
  const req = await a.next("cli.access_requested", i);
  await a.shell.call("cli.approve", { request_id: req.request_id });
  const r = await p.done;
  expect(r.code).toBe(0);
  return { req, r };
}

describe("asking for access", () => {
  test("login: the app is asked, approves, and the token is stored; later commands use it", async () => {
    srt = await runtime();
    const a = await app();
    const { req, r } = await login(a);
    expect(req.client.name).toBe("homerun-cli");
    expect(req.hostname.length).toBeGreaterThan(0);
    expect(req.expires_at - req.requested_at).toBe(120_000);
    expect(r.stderr).toContain("Homerun needs to approve this command-line tool.");
    expect(r.stderr).toContain("✓ Approved. The token is saved in the development token store");
    expect(r.stderr).toContain("--dev-skip-peer-check: not checking who is listening");
    if (WIN) expect(privacyProblems(readPathSecurity(storePath()), currentUserSid(), { protected: true })).toEqual([]);
    else expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    const token = readFileSync(storePath(), "utf8").trim();
    expect(r.stdout + r.stderr).not.toContain(token);

    const st = await cli(srt.dir, rel(["status", "--json"]));
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout)).toMatchObject({ role: "cli", token_store: expect.stringContaining("development token store") });
    const { tokens } = await a.shell.call("cli.tokens.list", {});
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.last_used_at).not.toBeNull();
    expect(srt.logs.join("\n")).not.toContain(token);
  }, 30_000);

  test("deny: exit 77, nothing stored", async () => {
    srt = await runtime();
    const a = await app();
    const p = spawnCli(srt.dir, rel(["login"]));
    const req = await a.next("cli.access_requested");
    await a.shell.call("cli.deny", { request_id: req.request_id });
    const r = await p.done;
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("✗ Denied in the Homerun app.");
    expect(existsSync(storePath())).toBe(false);
  }, 30_000);

  test("expiry: exit 77 after 2 minutes with nobody answering", async () => {
    const clock = new FakeClock(Date.now());
    srt = await runtime({ clock });
    const a = await app();
    const p = spawnCli(srt.dir, rel(["login"]));
    await a.next("cli.access_requested");
    await clock.advance(120_000);
    const r = await p.done;
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("✗ No answer within 2 minutes.");
    expect((await a.next("cli.access_withdrawn")).reason).toBe("expired");
  }, 30_000);

  // NO_CTRL_C: Windows can't send one process Ctrl-C (support.ts).
  test.skipIf(NO_CTRL_C)("Ctrl-C: exit 130, and the prompt is withdrawn", async () => {
    srt = await runtime();
    const a = await app();
    const p = spawnCli(srt.dir, rel(["login"]));
    const req = await a.next("cli.access_requested");
    p.proc.kill("SIGINT");
    const r = await p.done;
    expect(r.code).toBe(130);
    expect(await a.next("cli.access_withdrawn")).toEqual({ request_id: req.request_id, reason: "cancelled" });
  }, 30_000);

  test("too many waiting: exit 69 and no prompt", async () => {
    srt = await runtime();
    const a = await app();
    const waiting = [0, 1, 2].map(() => spawnCli(srt.dir, rel(["login"])));
    await until(() => a.of("cli.access_requested").length === 3, 10_000, "three requests");
    const r = await cli(srt.dir, rel(["login"]));
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("answer the waiting requests in the Homerun app first");
    // On Windows this terminates them; either way they are gone before the count is checked.
    for (const w of waiting) w.proc.kill("SIGINT");
    await Promise.all(waiting.map((w) => w.done));
    expect(a.of("cli.access_requested")).toHaveLength(3);
  }, 30_000);

  test("outside a terminal, a command without a token never asks: exit 77 pointing to login", async () => {
    srt = await runtime();
    const a = await app();
    const r = await cli(srt.dir, rel(["status"]));
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("this command-line tool isn't approved yet");
    expect(r.stderr).toContain("homerun login");
    await Bun.sleep(50);
    expect(a.of("cli.access_requested")).toHaveLength(0);
  }, 30_000);

  test("on a terminal, the first command asks, waits, and then runs", async () => {
    srt = await runtime();
    const a = await app();
    let out = "";
    let err = "";
    const io: Io = {
      argv: rel(["status", "--json"]),
      env: { HOMERUN_DATA_DIR: srt.dir, NO_COLOR: "1" },
      channel: "development",
      stdout: { write: (s) => void (out += s) },
      stderr: { write: (s) => void (err += s), isTTY: true },
      stdin: Object.assign(process.stdin, { isTTY: true }),
      onInterrupt: () => () => {},
    };
    const running = main(io);
    const req = await a.next("cli.access_requested");
    await until(() => err.includes("Waiting for approval…"), 5_000, "the spinner");
    await a.shell.call("cli.approve", { request_id: req.request_id });
    expect(await running).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ role: "cli" });
    expect(err).toContain("Ctrl-C cancels.");
    expect(err).toContain("\r\x1b[K✓ Approved.");
  }, 30_000);
});

describe("using and giving up the token", () => {
  test("revoking in the app ends a running watch; the next command says so and forgets the token", async () => {
    srt = await runtime();
    const a = await app();
    await login(a);
    const dev: RpcClient = await srt.dev();
    const thread = (await dev.call("threads.create", {})).thread.thread_id;
    const before = (await a.shell.call("cli.tokens.list", {})).tokens[0]!.last_used_at!;
    await Bun.sleep(5);
    const w = spawnCli(srt.dir, rel(["watch", thread]));
    // Its hello moves last_used_at; then give it a moment to subscribe.
    await until(() => (srt.rt.store.db.query("SELECT last_used_at FROM cli_tokens").get() as { last_used_at: number }).last_used_at > before, 10_000, "watch's hello");
    await Bun.sleep(200);
    const { tokens } = await a.shell.call("cli.tokens.list", {});
    await a.shell.call("cli.tokens.revoke", { token_id: tokens[0]!.token_id });
    const wr = await w.done;
    expect(wr.code).not.toBe(0);
    expect(wr.stderr).toContain("closed the connection");

    const r = await cli(srt.dir, rel(["status"]));
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("this command-line tool's access was revoked in the Homerun app");
    expect(r.stderr).toContain("homerun login");
    expect(existsSync(storePath())).toBe(false);
  }, 30_000);

  test("logout revokes the token and removes it; a second logout has nothing to do", async () => {
    srt = await runtime();
    const a = await app();
    await login(a);
    const r = await cli(srt.dir, rel(["logout"]));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Signed out. The token is revoked");
    expect(existsSync(storePath())).toBe(false);
    expect((await a.shell.call("cli.tokens.list", {})).tokens).toHaveLength(0);
    const again = await cli(srt.dir, rel(["logout", "--json"]));
    expect(JSON.parse(again.stdout)).toEqual({ signed_out: false, revoked: false });
  }, 30_000);

  test("the release role can't pre-approve tool calls through a task spec (§5.2)", async () => {
    srt = await runtime();
    const a = await app();
    await login(a);
    const spec = sessionSpec();
    spec.policy.bash_patterns = [{ pattern: "git status", class: "read" } as never];
    const r = await cli(srt.dir, rel(["tasks", "create", "--spec", "-"]), { stdin: JSON.stringify(spec) });
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("Change this in the Homerun app");
  }, 30_000);
});
