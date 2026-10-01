import { describe, expect, test } from "bun:test";
import { AppClient } from "../src/client";
import { relayText, seenText, sentFromText } from "../src/remote";
import { threadView } from "../src/threads/timeline";
import { initialThreadState, reduceThread } from "../src/threads/reducer";
import { DEVICE, FakeTransport, OTHER_DEVICE, THREAD, T0, ev, uuid } from "./helpers";

const PHONE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a09";
const OFFER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";

const status = (over: Record<string, unknown> = {}) => ({
  state: "signed_in",
  email: "me@example.com",
  error: null,
  relay: { state: "connected", since: T0, error: null },
  link_request: null,
  ...over,
});
const phone = (over: Record<string, unknown> = {}) => ({
  device_id: PHONE,
  name: "Wenjing’s iPhone",
  platform: "ios",
  claimed_platform: "ios",
  method: "qr",
  paired_at: T0,
  biometric_approvals: false,
  online: false,
  last_seen_at: T0 - 5 * 60_000,
  ...over,
});

function remoteTransport() {
  const t = new FakeTransport();
  t.handlers = {
    "threads.list": () => ({ threads: [], has_more: false }),
    "input.list_pending": () => ({ requests: [] }),
    "tasks.list": () => ({ tasks: [] }),
    "account.status": () => ({ status: status() }),
    "devices.list": () => ({ devices: [phone()] }),
    "devices.pairing.start": () => ({ offer_id: OFFER, qr_url: "homerun://pair#secret", expires_at: T0 + 300_000 }),
    "devices.pairing.cancel": () => ({ ok: true }),
    "devices.unpair": () => ({ ok: true }),
    "account.sign_out": () => ({ status: status({ state: "signed_out", email: null, relay: { state: "off", since: null, error: null } }) }),
  };
  return t;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the desktop's account and devices (§10)", () => {
  test("loaded on connect only when asked for, then kept current by notifications", async () => {
    const t = remoteTransport();
    const plain = new AppClient(t);
    plain.start();
    t.ready();
    await tick();
    expect(t.called("account.status")).toEqual([]);
    plain.stop();

    const c = new AppClient(t, { remote: true });
    c.start();
    t.ready();
    await tick();
    expect(c.remote.account.get()?.state).toBe("signed_in");
    expect(c.remote.devices.get()?.map((d): string => d.device_id)).toEqual([PHONE]);

    t.notify("account.changed", { status: status({ relay: { state: "offline", since: T0, error: "Lost the connection to the relay." } }) });
    expect(c.remote.account.get()?.relay.state).toBe("offline");
    t.notify("devices.changed", { devices: [] });
    expect(c.remote.devices.get()).toEqual([]);

    let bad = null as string | null;
    const c2 = new AppClient(t, { remote: true, onProtocolError: (w) => (bad = w) });
    c2.start();
    t.notify("account.changed", { status: { state: "haunted" } });
    expect(bad).toBe("account.changed");
  });

  test("a pairing offer closes on its own completion only; closing an unused one cancels it", async () => {
    const t = remoteTransport();
    const c = new AppClient(t, { remote: true });
    c.start();
    t.ready();
    await c.remote.startPairing();
    t.notify("devices.pairing_completed", { offer_id: uuid(), device: phone() });
    expect(c.remote.pairing.get()?.paired).toBeNull();
    t.notify("devices.pairing_completed", { offer_id: OFFER, device: phone() });
    expect(c.remote.pairing.get()?.paired?.name).toBe("Wenjing’s iPhone");
    await c.remote.closePairing();
    expect(t.called("devices.pairing.cancel")).toEqual([]);

    await c.remote.startPairing();
    await c.remote.closePairing();
    expect(t.called("devices.pairing.cancel").map((x) => x.params)).toEqual([{ offer_id: OFFER }]);
    expect(c.remote.pairing.get()).toBeNull();
  });

  test("sign-out and unpair update the stores from their answers", async () => {
    const t = remoteTransport();
    const c = new AppClient(t, { remote: true });
    c.start();
    t.ready();
    await tick();
    await c.remote.unpair(PHONE);
    expect(c.remote.devices.get()).toEqual([]);
    await c.remote.signOut();
    expect(c.remote.account.get()?.state).toBe("signed_out");
  });

  test("texts", () => {
    const now = T0 + 3 * 3600_000;
    expect(relayText(status() as never, now)).toBe("Connected");
    expect(relayText(status({ relay: { state: "connecting", since: T0, error: null } }) as never, now)).toBe("Connecting…");
    expect(relayText(status({ relay: { state: "offline", since: T0, error: "x" } }) as never, now)).toStartWith("Offline since ");
    expect(relayText(status({ relay: { state: "off", since: null, error: null } }) as never, now)).toBe("Not connected");
    expect(seenText(phone() as never, T0)).toBe("Last seen 5 min ago");
    expect(seenText(phone({ online: true }) as never, T0)).toBe("Online");
    expect(seenText(phone({ last_seen_at: null }) as never, T0)).toBe("Not seen yet");
  });
});

describe("instructions queued while the desktop was offline (§9.4)", () => {
  const msg = (seq: number, sent_ago_ms: number | null, device = PHONE, surface = "ios") =>
    ev(seq, "user.message", {
      client_msg_id: uuid(),
      text: `m${seq}`,
      origin: { device_id: device, surface },
      disposition: "started_run",
      ...(sent_ago_ms !== null ? { sent_at: T0 + seq * 1000 - sent_ago_ms } : {}),
    });

  test("say when and where they were sent; prompt ones don't", () => {
    const events = [msg(1, 3 * 3600_000), msg(2, 5_000), msg(3, null, DEVICE, "desktop"), msg(4, 2 * 3600_000, OTHER_DEVICE, "web")];
    const s = reduceThread(initialThreadState(THREAD), { type: "latest", events, has_more: false });
    const users = threadView(s).items.filter((i) => i.kind === "user");
    expect(users.map((u) => u.kind === "user" && u.sent_at !== null)).toEqual([true, false, false, true]);
    const now = T0 + 10_000;
    const text = users.map((u) => (u.kind === "user" ? sentFromText(u, [phone() as never], now) : null));
    expect(text).toEqual(["Sent 3 h ago from Wenjing’s iPhone", null, null, "Sent 2 h ago from the web"]);
  });
});
