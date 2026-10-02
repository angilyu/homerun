import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATIONS, PROTOCOL_VERSION, RPC_ERROR } from "@homerun/core";
import { RpcCallError, RpcClient } from "../../src/rpc/client";
import { FakeClock } from "../../src/schedule/clock";
import { insertInputRequest } from "../../src/store/rows";
import { tokenHash } from "../../src/store/cli-tokens";
import { LAUNCH_TOKEN, sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

/** Command-line access (§5.2, milestone 8a): requests, approval, tokens and revocation. */

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const CLIENT = { name: "homerun-cli", version: "0.9.0" };

let srt: SocketRuntime | null = null;
const extra: RpcClient[] = [];
afterEach(async () => {
  for (const c of extra.splice(0)) c.close();
  await srt?.close();
  srt = null;
});

async function rejects(p: Promise<unknown>): Promise<RpcCallError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcCallError) return e;
    throw e;
  }
  throw new Error("expected an RPC error");
}

const hello = (role: string, auth: unknown) => ({ protocol: { min: 1, max: PROTOCOL_VERSION }, role, auth, client: CLIENT, capabilities: [] });

async function connect(): Promise<RpcClient> {
  const c = await RpcClient.connect(srt!.rt.config.socketPath);
  extra.push(c);
  return c;
}

/** Notifications a client received, by method. */
function inbox(c: RpcClient) {
  const got: Array<{ method: string; params: any }> = [];
  c.onNotification((method, params) => got.push({ method, params }));
  return {
    got,
    of: (m: string) => got.filter((n) => n.method === m).map((n) => n.params),
    next: async (m: string) => {
      await until(() => got.some((n) => n.method === m), 5000, m);
      return got.find((n) => n.method === m)!.params;
    },
  };
}

/** A shell that records what it is asked. */
async function shellWithInbox() {
  const shell = await srt!.shell();
  return { shell, box: inbox(shell) };
}

/** A CLI connection that has asked for access. */
async function requester() {
  const c = await connect();
  const box = inbox(c);
  const r = (await c.call("cli.request_access", { client: CLIENT, hostname: "studio.local" })) as { request_id: string; expires_at: number };
  return { c, box, ...r };
}

/** Ask, approve, and say hello with the token on the same connection. */
async function approvedCli(shell: RpcClient) {
  const r = await requester();
  await shell.call("cli.approve", { request_id: r.request_id });
  const d = await r.box.next("cli.access_decision");
  await r.c.call("hello", hello("cli", { kind: "cli_token", token: d.token }) as never);
  return { c: r.c, token: d.token as string, token_id: d.token_id as string };
}

describe("requesting and approving access", () => {
  test("approve: the token goes to the requesting connection only, and it says hello with it", async () => {
    srt = await socketRuntime({ clock: new FakeClock(T0) });
    const { shell, box } = await shellWithInbox();
    const bystander = await srt.shell();
    const bystanderBox = inbox(bystander);

    const r = await requester();
    expect(r.expires_at).toBe(T0 + 120_000);
    const asked = await box.next("cli.access_requested");
    expect(NOTIFICATIONS["cli.access_requested"].params.parse(asked)).toEqual({ request_id: r.request_id, client: CLIENT, hostname: "studio.local", requested_at: T0, expires_at: T0 + 120_000 });

    const approved = await shell.call("cli.approve", { request_id: r.request_id });
    expect(Object.keys(approved)).toEqual(["token_id"]);
    const d = NOTIFICATIONS["cli.access_decision"].params.parse(await r.box.next("cli.access_decision"));
    expect(d).toMatchObject({ request_id: r.request_id, approved: true, token_id: approved.token_id });
    expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // No other connection ever sees the token or the decision.
    for (const b of [box, bystanderBox]) expect(JSON.stringify(b.got)).not.toContain(d.token!);
    expect(bystanderBox.of("cli.access_decision")).toEqual([]);

    const h = await r.c.call("hello", hello("cli", { kind: "cli_token", token: d.token }) as never);
    expect(h.role).toBe("cli");
    expect(await r.c.call("ping", {})).toMatchObject({ pong: true });

    const [info] = (await shell.call("cli.tokens.list", {})).tokens;
    expect(info).toEqual({ token_id: approved.token_id, client: CLIENT, hostname: "studio.local", created_at: T0, last_used_at: T0 });
  });

  test("a later connection says hello with the stored token and last_used_at moves", async () => {
    const clock = new FakeClock(T0);
    srt = await socketRuntime({ clock });
    const shell = await srt.shell();
    const { c, token, token_id } = await approvedCli(shell);
    c.close();
    await clock.advance(60_000);
    const again = await connect();
    await again.call("hello", hello("cli", { kind: "cli_token", token }) as never);
    const info = (await shell.call("cli.tokens.list", {})).tokens.find((t) => t.token_id === token_id)!;
    expect(info.last_used_at).toBe(T0 + 60_000);
  });

  test("deny: no token, a reason, and the connection can't authenticate", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const r = await requester();
    await shell.call("cli.deny", { request_id: r.request_id });
    expect(await r.box.next("cli.access_decision")).toEqual({ request_id: r.request_id, approved: false, reason: "denied" });
    expect((await rejects(shell.call("cli.approve", { request_id: r.request_id }))).code).toBe(RPC_ERROR.NOT_FOUND);
    expect((await shell.call("cli.tokens.list", {})).tokens).toEqual([]);
  });

  test("a request expires after 2 minutes: the CLI is told, the prompt withdrawn, and a late approve is NOT_FOUND", async () => {
    const clock = new FakeClock(T0);
    srt = await socketRuntime({ clock });
    const { shell, box } = await shellWithInbox();
    const r = await requester();
    await box.next("cli.access_requested");
    await clock.advance(119_999);
    expect(r.box.of("cli.access_decision")).toEqual([]);
    await clock.advance(1);
    expect(await r.box.next("cli.access_decision")).toEqual({ request_id: r.request_id, approved: false, reason: "expired" });
    expect(await box.next("cli.access_withdrawn")).toEqual({ request_id: r.request_id, reason: "expired" });
    expect((await rejects(shell.call("cli.approve", { request_id: r.request_id }))).code).toBe(RPC_ERROR.NOT_FOUND);
    expect(srt.rt.cliAccess.pendingCount).toBe(0);
  });

  test("one request per connection, and at most three waiting", async () => {
    srt = await socketRuntime();
    await srt.shell();
    const first = await requester();
    const again = await rejects(first.c.call("cli.request_access", { client: CLIENT, hostname: "studio.local" }));
    expect(again.code).toBe(RPC_ERROR.INVALID_REQUEST);
    await requester();
    await requester();
    const fourth = await connect();
    const e = await rejects(fourth.call("cli.request_access", { client: CLIENT, hostname: "studio.local" }));
    expect(e.code).toBe(RPC_ERROR.UNAVAILABLE);
    expect(e.data).toEqual({ reason: "too_many_requests" });
    expect(srt.rt.cliAccess.pendingCount).toBe(3);
  });

  test("a connection that has said hello can't request access", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    expect((await rejects(shell.call("cli.request_access", { client: CLIENT, hostname: "h" }))).code).toBe(RPC_ERROR.FORBIDDEN);
    const dev = await srt.dev();
    expect((await rejects(dev.call("cli.request_access", { client: CLIENT, hostname: "h" }))).code).toBe(RPC_ERROR.FORBIDDEN);
  });

  test("a waiting request holds the hello timeout; after the decision it runs again", async () => {
    srt = await socketRuntime({ helloTimeoutMs: 100 });
    const shell = await srt.shell();
    const r = await requester();
    await Bun.sleep(250);
    expect(r.c.isOpen).toBe(true);
    await shell.call("cli.deny", { request_id: r.request_id });
    await r.box.next("cli.access_decision");
    await r.c.closed;
  });

  test("the requester disconnecting, or saying hello first, withdraws the prompt", async () => {
    srt = await socketRuntime();
    const { shell, box } = await shellWithInbox();
    const a = await requester();
    a.c.close();
    await until(() => box.of("cli.access_withdrawn").length === 1);
    expect(box.of("cli.access_withdrawn")[0]).toEqual({ request_id: a.request_id, reason: "cancelled" });

    const b = await requester();
    await rejects(b.c.call("hello", hello("cli", { kind: "cli_token", token: "Q".repeat(43) }) as never));
    await until(() => box.of("cli.access_withdrawn").length === 2);
    expect(box.of("cli.access_withdrawn")[1]).toEqual({ request_id: b.request_id, reason: "cancelled" });
    expect((await rejects(shell.call("cli.approve", { request_id: b.request_id }))).code).toBe(RPC_ERROR.NOT_FOUND);
    expect(srt.rt.cliAccess.pendingCount).toBe(0);
  });

  test("a request made while the shell is away is shown when it connects", async () => {
    srt = await socketRuntime();
    const r = await requester();
    // Listen before hello: the replay follows the hello reply directly.
    const shell = await connect();
    const box = inbox(shell);
    await shell.handshake("shell", { kind: "launch_token", token: LAUNCH_TOKEN });
    expect((await box.next("cli.access_requested")).request_id).toBe(r.request_id);
  });

  test("only the shell's own connection may approve or deny", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const r = await requester();
    const webview = await RpcClient.open(srt.rt.config.socketPath, "webview", { kind: "launch_token", token: LAUNCH_TOKEN });
    extra.push(webview);
    const dev = await srt.dev();
    const { c: cli } = await approvedCli(shell);
    const anon = await connect();
    for (const c of [webview, dev, cli]) {
      for (const m of ["cli.approve", "cli.deny"] as const) expect((await rejects(c.raw(m, { request_id: r.request_id }))).code).toBe(RPC_ERROR.FORBIDDEN);
    }
    for (const m of ["cli.approve", "cli.deny"] as const) expect((await rejects(anon.raw(m, { request_id: r.request_id }))).code).toBe(RPC_ERROR.HANDSHAKE_REQUIRED);
    expect(srt.rt.cliAccess.pendingCount).toBe(1);
  });
});

describe("tokens", () => {
  test("an unknown token is refused with a reason, and the connection closed", async () => {
    srt = await socketRuntime();
    const c = await connect();
    const e = await rejects(c.raw("hello", hello("cli", { kind: "cli_token", token: "Q".repeat(43) })));
    expect(e.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    expect(e.data).toEqual({ reason: "unknown" });
    await c.closed;
  });

  test("malformed tokens, and a CLI token for any other role, never get as far as the lookup", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const { token } = await approvedCli(shell);
    for (const [role, auth] of [
      ["cli", { kind: "cli_token", token: token.slice(1) }],
      ["cli", { kind: "cli_token", token: token + "=" }],
      ["cli_dev", { kind: "cli_token", token }],
      ["shell", { kind: "cli_token", token }],
      ["cli", { kind: "dev_token", token }],
    ] as const) {
      const c = await connect();
      expect((await rejects(c.raw("hello", hello(role, auth)))).code).toBe(RPC_ERROR.INVALID_PARAMS);
      await c.closed;
    }
    // A dev token is not a CLI token either.
    const c = await connect();
    expect((await rejects(c.raw("hello", hello("cli", { kind: "cli_token", token: srt.rt.devToken! })))).data).toEqual({ reason: "unknown" });
  });

  test("revoking closes that token's connections only, and the token stops working", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const a = await approvedCli(shell);
    const a2 = await connect();
    await a2.call("hello", hello("cli", { kind: "cli_token", token: a.token }) as never);
    const b = await approvedCli(shell);

    await shell.call("cli.tokens.revoke", { token_id: a.token_id });
    await a.c.closed;
    await a2.closed;
    expect(await b.c.call("ping", {})).toMatchObject({ pong: true });
    expect((await shell.call("cli.tokens.list", {})).tokens.map((t) => t.token_id)).toEqual([b.token_id]);

    const c = await connect();
    const e = await rejects(c.raw("hello", hello("cli", { kind: "cli_token", token: a.token })));
    expect(e.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    expect(e.data).toEqual({ reason: "revoked" });
    expect((await rejects(shell.call("cli.tokens.revoke", { token_id: uuid() }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });

  test("sign-out revokes the caller's own token and closes it", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const a = await approvedCli(shell);
    const b = await approvedCli(shell);
    expect(await a.c.call("cli.sign_out", {})).toEqual({ ok: true });
    await a.c.closed;
    expect((await shell.call("cli.tokens.list", {})).tokens.map((t) => t.token_id)).toEqual([b.token_id]);
    const c = await connect();
    expect((await rejects(c.raw("hello", hello("cli", { kind: "cli_token", token: a.token })))).data).toEqual({ reason: "revoked" });
    // Only a CLI token's connection signs out.
    expect((await rejects((await srt.dev()).raw("cli.sign_out", {}))).code).toBe(RPC_ERROR.FORBIDDEN);
  });

  test("the database holds only a hash, and no log line holds the token", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const { token } = await approvedCli(shell);
    const row = srt.rt.store.db.query<{ token_sha256: string }, []>("SELECT token_sha256 FROM cli_tokens").get()!;
    expect(row.token_sha256).toBe(tokenHash(token));
    srt.rt.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const needle = Buffer.from(token);
    const files = readdirSync(srt.dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(f.parentPath, f.name)).includes(needle)).toBe(false);
    expect(srt.logs.join("\n")).not.toContain(token);
    expect(srt.logs.some((l) => l.includes("cli access approved"))).toBe(true);
  });
});

describe("what the release CLI may not do (§5.2)", () => {
  test("no approvals, 'Did this happen?', grants, token management or secrets", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const { c: cli } = await approvedCli(shell);
    const thread = (await shell.call("threads.create", {})).thread;
    const sent = await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "wait" });
    const approvalId = uuid();
    insertInputRequest(srt.rt.store, {
      request_id: approvalId,
      run_id: sent.run_id,
      kind: "approval",
      tool_call_id: "toolu_1",
      prompt: { type: "approval", tool: "Bash", tool_call_id: "toolu_1", class: "destructive", input: { kind: "inline", value: { command: "rm -rf build" } }, reason: "destructive", offer_always: false },
      state: "pending",
      requested_at: Date.now(),
      expires_at: null,
      answered_at: null,
      response: null,
      answered_by: null,
    } as never);
    for (const decision of ["allow", "deny"]) {
      const e = await rejects(cli.call("input.answer", { request_id: approvalId, response: { type: "approval", decision }, via: "app" } as never));
      expect(e.code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    }
    const ambiguousId = uuid();
    insertInputRequest(srt.rt.store, {
      request_id: ambiguousId,
      run_id: sent.run_id,
      kind: "question",
      tool_call_id: "toolu_2",
      prompt: { type: "ambiguous_tool_call", tool: "Write", tool_call_id: "toolu_2", class: "write", input: { kind: "inline", value: { file_path: "/tmp/x" } } },
      state: "pending",
      requested_at: Date.now(),
      expires_at: null,
      answered_at: null,
      response: null,
      answered_by: null,
    } as never);
    for (const outcome of ["completed", "not_run"]) {
      const e = await rejects(cli.call("input.answer", { request_id: ambiguousId, response: { type: "ambiguous_tool_call", outcome }, via: "app" } as never));
      expect(e.code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    }
    const task = (await shell.call("tasks.create", { spec: sessionSpec() as never })).task;
    const forbidden: Array<[string, unknown]> = [
      ["grants.create", { task_id: task.task_id, grant: { tool: "WebFetch", pattern: "example.com", class: "network" } }],
      ["grants.create", { task_id: task.task_id, grant: { tool: "WebFetch", pattern: "*", class: "network" } }],
      ["cli.tokens.list", {}],
      ["cli.tokens.revoke", { token_id: uuid() }],
      ["cli.approve", { request_id: uuid() }],
      ["secrets.set", { name: "anthropic_api_key", value: "sk-ant-TEST-not-a-real-key" }],
      ["secrets.verify", { name: "anthropic_api_key", value: "sk-ant-TEST-not-a-real-key" }],
    ];
    for (const [m, p] of forbidden) expect((await rejects(cli.raw(m, p))).code).toBe(RPC_ERROR.FORBIDDEN);
  });

  test("tasks: plain specs are fine, pre-approving calls needs the app", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const { c: cli } = await approvedCli(shell);
    const bash = (cls: string) => {
      const s = sessionSpec({ builtin: ["Read", "Bash"] }) as any;
      s.policy.bash_patterns = [{ pattern: "git status", class: cls }];
      return s;
    };
    const plain = await cli.call("tasks.create", { spec: sessionSpec() as never });
    expect(plain.task.version).toBe(1);
    expect((await cli.call("tasks.create", { spec: bash("destructive") })).task.version).toBe(1);

    const e = await rejects(cli.call("tasks.create", { spec: bash("read") }));
    expect(e.code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    expect(e.message).toContain("Homerun app");
    const mcp = sessionSpec({ mcp_servers: [{ id: "gh", transport: "http", url: "https://mcp.example.com/" }] });
    expect((await rejects(cli.call("tasks.create", { spec: mcp as never }))).code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    const open = sessionSpec({ roots: [] }) as any;
    open.policy.egress = { mode: "open" };
    expect((await rejects(cli.call("tasks.create", { spec: open }))).code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);

    // The app sets the pattern; the CLI may edit the task around it, but not add another.
    const wide = (await shell.call("tasks.create", { spec: bash("read") })).task;
    const renamed = { ...bash("read"), name: "renamed" };
    expect((await cli.call("tasks.update", { task_id: wide.task_id, spec: renamed, expected_version: 1 })).task.version).toBe(2);
    expect((await rejects(cli.call("tasks.update", { task_id: wide.task_id, spec: bash("write"), expected_version: 2 }))).code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    expect((await rejects(cli.call("tasks.update", { task_id: uuid(), spec: bash("read"), expected_version: 1 }))).code).toBe(RPC_ERROR.NOT_FOUND);
    // The development CLI has full authority.
    const dev = await srt.dev();
    expect((await dev.call("tasks.create", { spec: bash("read") })).task.version).toBe(1);
  });
});
