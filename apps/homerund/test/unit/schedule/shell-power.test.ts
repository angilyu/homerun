import { expect, test } from "bun:test";
import { FakeClock } from "../../../src/schedule/clock";
import { LAUNCH_TOKEN, socketRuntime } from "../../helpers";

/**
 * The shell's sleep and wake notifications, byte for byte as the desktop shell sends them
 * (apps/desktop/src-tauri/src/power.rs): hello, the notification, then a ping whose reply means
 * the runtime has handled it (§8.1, §8.4).
 */
async function shellSays(socketPath: string, method: string, params: unknown): Promise<void> {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: { min: 1, max: 1 }, role: "shell", auth: { kind: "launch_token", token: LAUNCH_TOKEN }, client: { name: "homerun-shell", version: "0.0.1" }, capabilities: [] } },
    { jsonrpc: "2.0", method, params },
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
  ];
  const got = Promise.withResolvers<void>();
  let buf = "";
  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, d) {
        buf += d.toString();
        for (const l of buf.split("\n").filter(Boolean)) {
          const v = JSON.parse(l);
          if (v.error) got.reject(new Error(JSON.stringify(v.error)));
          if (v.id === 2) got.resolve();
        }
      },
    },
  });
  sock.write(lines.map((l) => JSON.stringify(l) + "\n").join(""));
  await got.promise;
  sock.end();
}

test("will_sleep and did_wake from the shell record the sleep with the OS's times", async () => {
  const T0 = Date.UTC(2026, 0, 5, 10, 0);
  const clock = new FakeClock(T0);
  const srt = await socketRuntime({ clock, deviceZone: "UTC" });
  try {
    await shellSays(srt.rt.config.socketPath, "power.will_sleep", { at: T0 + 60_000 });
    clock.sleep(3_600_000);
    await shellSays(srt.rt.config.socketPath, "power.did_wake", { at: T0 + 3_600_000, slept_at: T0 + 60_000 });
    const rows = srt.rt.store.db.query("SELECT start_at, end_at, cause, source FROM downtime WHERE cause = 'asleep'").all();
    expect(rows).toEqual([{ start_at: T0 + 60_000, end_at: T0 + 3_600_000, cause: "asleep", source: "os" }]);
  } finally {
    await srt.close();
  }
});
