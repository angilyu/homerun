import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionClosedError, RpcCallError, RpcClient, RpcProtocolError, RuntimeUnavailableError } from "../src";

const work = mkdtempSync(join(tmpdir(), "hr-rpcc-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** A fake server: `reply(frame)` returns the lines to send back for each request. */
function fakeServer(reply: (req: { id: number; method: string }) => string[]) {
  const path = join(work, `s${n++}.sock`);
  const listener = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open: (s) => void (s.data = { buf: "" }),
      data: (s, chunk) => {
        s.data.buf += chunk.toString();
        for (let nl = s.data.buf.indexOf("\n"); nl >= 0; nl = s.data.buf.indexOf("\n")) {
          const line = s.data.buf.slice(0, nl);
          s.data.buf = s.data.buf.slice(nl + 1);
          for (const out of reply(JSON.parse(line))) s.write(out + "\n");
        }
      },
    },
  });
  return { path, stop: () => listener.stop(true) };
}

describe("RpcClient", () => {
  test("nothing listening is RuntimeUnavailableError", async () => {
    const e = await RpcClient.connect(join(work, "none.sock")).catch((x) => x);
    expect(e).toBeInstanceOf(RuntimeUnavailableError);
  });

  test("the socket's fd is there before anything is sent, and gone after close (the CLI's peer check)", async () => {
    let received = 0;
    const s = fakeServer(() => {
      received++;
      return [];
    });
    const c = await RpcClient.connect(s.path);
    expect(typeof c.fd).toBe("number");
    await Bun.sleep(20);
    expect(received).toBe(0);
    c.close();
    expect(c.fd).toBeNull();
    s.stop();
  });

  test("results, errors and notifications", async () => {
    const s = fakeServer((r) => [
      JSON.stringify({ jsonrpc: "2.0", method: "thread.event", params: { x: 1 } }),
      r.method === "ping"
        ? JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { pong: true, runtime_version: "t", protocol: 1 } })
        : JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } }),
    ]);
    const c = await RpcClient.connect(s.path);
    const notes: string[] = [];
    c.onNotification((m) => notes.push(m));
    expect(await c.call("ping", {})).toEqual({ pong: true, runtime_version: "t", protocol: 1 });
    const e = await c.raw("nope").catch((x) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect((e as RpcCallError).code).toBe(-32601);
    expect(notes).toEqual(["thread.event", "thread.event"]);
    c.close();
    s.stop();
  });

  test("with validate, a result that fails its core schema is a protocol error", async () => {
    const s = fakeServer((r) => [JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { pong: "yes" } })]);
    const c = await RpcClient.connect(s.path);
    c.validate = true;
    expect(await c.call("ping", {}).catch((x) => x)).toBeInstanceOf(RpcProtocolError);
    c.close();
    s.stop();
  });

  test("a frame that is not JSON fails pending calls and closes", async () => {
    const s = fakeServer(() => ["{not json"]);
    const c = await RpcClient.connect(s.path);
    expect(await c.call("ping", {}).catch((x) => x)).toBeInstanceOf(RpcProtocolError);
    await c.closed;
    expect(c.isOpen).toBe(false);
    s.stop();
  });

  test("a close before the reply is ConnectionClosedError", async () => {
    const s = fakeServer(() => []);
    const c = await RpcClient.connect(s.path);
    const p = c.call("ping", {}).catch((x) => x);
    s.stop();
    expect(await p).toBeInstanceOf(ConnectionClosedError);
  });
});
