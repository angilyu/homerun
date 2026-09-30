import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, RPC_ERROR, type DeviceId } from "@homerun/core";
import { RpcCallError, RpcClient } from "../../src/rpc/client";
import { ShellCallError, type Connection, type FrameSink } from "../../src/rpc/server";
import { LAUNCH_TOKEN, persisted, sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

let srt: SocketRuntime | null = null;
afterEach(async () => {
  await srt?.close();
  srt = null;
});

/** A shell that stores what the runtime persists, like the Rust shell's keychain. */
async function keychainShell(s: SocketRuntime, opts: { fail?: boolean; hang?: boolean } = {}) {
  const keychain = new Map<string, string>();
  const calls: string[] = [];
  const c = await RpcClient.connect(s.rt.config.socketPath);
  c.onRequest((method, params) => {
    const p = params as { name: string; value?: string };
    calls.push(`${method} ${p.name}`);
    if (opts.hang) return new Promise(() => {});
    if (opts.fail) throw new Error("keychain locked");
    if (method === "secrets.persist") {
      keychain.set(p.name, p.value!);
      return { stored: true };
    }
    if (method === "secrets.delete") {
      keychain.delete(p.name);
      return { deleted: true };
    }
    throw new Error("unexpected");
  });
  await c.handshake("shell", { kind: "launch_token", token: LAUNCH_TOKEN });
  return { c, keychain, calls };
}

describe("runtime → shell requests (§5.2)", () => {
  test("secrets.persist reaches the shell and clears the pending write", async () => {
    srt = await socketRuntime();
    const shell = await keychainShell(srt);
    srt.rt.shellSecrets.persist("refresh_token", "rt-1");
    expect(srt.rt.secrets.get("refresh_token")).toBe("rt-1");
    await until(() => !srt!.rt.shellSecrets.isPending("refresh_token"));
    expect(shell.keychain.get("refresh_token")).toBe("rt-1");
    shell.c.close();
  });

  test("written while the shell is away: pending, then sent when it connects", async () => {
    srt = await socketRuntime();
    srt.rt.shellSecrets.persist("refresh_token", "rt-1");
    srt.rt.shellSecrets.persist("refresh_token", "rt-2");
    srt.rt.shellSecrets.persist("device_static_key", "keys");
    expect(srt.rt.shellSecrets.pendingCount).toBe(2);
    const shell = await keychainShell(srt);
    await until(() => srt!.rt.shellSecrets.pendingCount === 0);
    expect(Object.fromEntries(shell.keychain)).toEqual({ refresh_token: "rt-2", device_static_key: "keys" });
    shell.c.close();
  });

  test("a refused write stays pending and is retried on the next connection", async () => {
    srt = await socketRuntime();
    const bad = await keychainShell(srt, { fail: true });
    srt.rt.shellSecrets.persist("refresh_token", "rt-1");
    await until(() => bad.calls.length === 1);
    await Bun.sleep(20);
    expect(srt.rt.shellSecrets.isPending("refresh_token")).toBe(true);
    bad.c.close();
    await until(() => srt!.rt.server.shell() === null);
    const good = await keychainShell(srt);
    await until(() => !srt!.rt.shellSecrets.isPending("refresh_token"));
    expect(good.keychain.get("refresh_token")).toBe("rt-1");
    good.c.close();
  });

  test("the shell's hand-over never overwrites a value the runtime wrote", async () => {
    srt = await socketRuntime();
    srt.rt.shellSecrets.persist("refresh_token", "rotated");
    const shell = await keychainShell(srt, { hang: true });
    await shell.c.call("secrets.set", { name: "refresh_token", value: "stale" });
    expect(srt.rt.secrets.get("refresh_token")).toBe("rotated");
    await shell.c.call("secrets.clear", { name: "refresh_token" });
    expect(srt.rt.secrets.get("refresh_token")).toBe("rotated");
    // Names the runtime never wrote are the shell's to set.
    await shell.c.call("secrets.set", { name: "device_static_key", value: "from-keychain" });
    expect(srt.rt.secrets.get("device_static_key")).toBe("from-keychain");
    shell.c.close();
  });

  test("secrets.delete removes the keychain item and forgets the value", async () => {
    srt = await socketRuntime();
    const shell = await keychainShell(srt);
    srt.rt.shellSecrets.persist("refresh_token", "rt-1");
    await until(() => shell.keychain.has("refresh_token"));
    srt.rt.shellSecrets.delete("refresh_token");
    expect(srt.rt.secrets.has("refresh_token")).toBe(false);
    await until(() => !shell.keychain.has("refresh_token") && srt!.rt.shellSecrets.pendingCount === 0);
    expect(shell.calls).toEqual(["secrets.persist refresh_token", "secrets.delete refresh_token"]);
    shell.c.close();
  });

  test("an unanswered request times out; a closing connection fails what is in flight", async () => {
    srt = await socketRuntime();
    const shell = await keychainShell(srt, { hang: true });
    const conn = srt.rt.server.shell()!;
    const timedOut = await conn.request("secrets.persist", { name: "refresh_token", value: "x" }, 30).catch((e) => e);
    expect(timedOut).toBeInstanceOf(ShellCallError);
    const inFlight = conn.request("secrets.persist", { name: "refresh_token", value: "y" }).catch((e) => e);
    shell.c.close();
    expect(await inFlight).toBeInstanceOf(ShellCallError);
  });

  test("an error reply rejects with its code; only the shell's connection may be asked", async () => {
    srt = await socketRuntime();
    const shell = await keychainShell(srt, { fail: true });
    const e = (await srt.rt.server.shell()!.request("secrets.persist", { name: "refresh_token", value: "x" }).catch((x) => x)) as ShellCallError;
    expect(e.code).toBe(RPC_ERROR.INTERNAL_ERROR);
    const dev = await srt.dev();
    let devConn: Connection | null = null;
    for (const c of (srt.rt.server as unknown as { connections: Set<Connection> }).connections) if (c.role === "cli_dev") devConn = c;
    expect(await devConn!.request("secrets.persist", {}).catch((x) => x)).toBeInstanceOf(ShellCallError);
    dev.close();
    shell.c.close();
  });
});

/** A live session's plaintext side, as `remote/sessions.ts` drives it. */
function adopted(s: SocketRuntime, peer: { deviceId: string; platform: "ios" | "web" }) {
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  let ended = false;
  const sink: FrameSink = {
    write(b) {
      buf += b.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
      return b.length;
    },
    end() {
      ended = true;
    },
  };
  const conn = s.rt.server.adopt(sink, peer);
  let id = 0;
  const call = async (method: string, params: unknown) => {
    const my = ++id;
    conn.onData(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"));
    await until(() => lines.some((l) => l.id === my));
    return lines.find((l) => l.id === my) as { result?: unknown; error?: { code: number; message: string } };
  };
  const hello = (role: string, deviceId: string) =>
    call("hello", { protocol: { min: 1, max: PROTOCOL_VERSION }, role, auth: { kind: "paired_device", device_id: deviceId }, client: { name: "phone", version: "0" }, capabilities: [] });
  return { conn, call, hello, lines, ended: () => ended };
}

describe("paired devices on a live session (§9.4, §13)", () => {
  const phone = uuid() as DeviceId;

  test("hello must name the session's device and its pinned platform", async () => {
    srt = await socketRuntime();
    const wrongDevice = adopted(srt, { deviceId: phone, platform: "ios" });
    expect((await wrongDevice.hello("ios", uuid())).error!.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    const wrongRole = adopted(srt, { deviceId: phone, platform: "web" });
    expect((await wrongRole.hello("ios", phone)).error!.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    const ok = adopted(srt, { deviceId: phone, platform: "ios" });
    const r = (await ok.hello("ios", phone)).result as { role: string };
    expect(r.role).toBe("ios");
    expect(ok.conn.remote).toEqual({ deviceId: phone, platform: "ios" });
  });

  test("a live session can't use the local credentials; the socket can't use paired_device", async () => {
    srt = await socketRuntime();
    const s = adopted(srt, { deviceId: phone, platform: "ios" });
    const r = await s.call("hello", { protocol: { min: 1, max: PROTOCOL_VERSION }, role: "shell", auth: { kind: "launch_token", token: LAUNCH_TOKEN }, client: { name: "x", version: "0" }, capabilities: [] });
    expect(r.error!.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    const local = await RpcClient.connect(srt.rt.config.socketPath);
    const e = await local
      .raw("hello", { protocol: { min: 1, max: PROTOCOL_VERSION }, role: "ios", auth: { kind: "paired_device", device_id: phone }, client: { name: "x", version: "0" }, capabilities: [] })
      .catch((x: RpcCallError) => x);
    expect((e as RpcCallError).code).toBe(RPC_ERROR.UNAUTHENTICATED);
    local.close();
  });

  test("messages carry the phone's origin; the web role is read-only for account and devices", async () => {
    srt = await socketRuntime();
    const s = adopted(srt, { deviceId: phone, platform: "ios" });
    await s.hello("ios", phone);
    const t = (await s.call("threads.create", {})).result as { thread: { thread_id: string } };
    await s.call("messages.send", { thread_id: t.thread.thread_id, client_msg_id: uuid(), text: "hello" });
    const msg = persisted(srt.rt.store, t.thread.thread_id).find((e) => e.type === "user.message") as unknown as { payload: { origin: unknown } };
    expect(msg.payload.origin).toEqual({ device_id: phone, surface: "ios" });
    for (const m of ["account.status", "devices.list", "devices.pairing.start", "secrets.set"]) {
      expect((await s.call(m, {})).error!.code).toBe(RPC_ERROR.FORBIDDEN);
    }
  });

  test("a phone can't widen a task's policy (§5.2, as for the release CLI)", async () => {
    srt = await socketRuntime();
    const s = adopted(srt, { deviceId: phone, platform: "ios" });
    await s.hello("ios", phone);
    const wide = sessionSpec();
    wide.policy.egress.mode = "open";
    const r = await s.call("tasks.create", { spec: wide });
    expect(r.error!.code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    expect((await s.call("tasks.create", { spec: sessionSpec({ builtin: ["Read"] }) })).result).toBeDefined();
  });

  test("closing the device's connections ends its sessions", async () => {
    srt = await socketRuntime();
    const s = adopted(srt, { deviceId: phone, platform: "ios" });
    await s.hello("ios", phone);
    srt.rt.server.closeRemoteConnections(phone);
    expect(s.ended()).toBe(true);
    expect(s.conn.open).toBe(false);
  });
});
