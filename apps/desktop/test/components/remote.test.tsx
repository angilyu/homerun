import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import { encode } from "uqr";
import { THREAD, T0, accountStatus, baseTransport, ev, renderApp, summary, uuid } from "./support";

const PHONE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a09";
const OFFER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";
const QR = "https://homerun.example/pair#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const signedIn = (over: Record<string, unknown> = {}) =>
  accountStatus({ state: "signed_in", email: "me@example.com", relay: { state: "connected", since: T0, error: null }, ...over });
const phone = (over: Record<string, unknown> = {}) => ({
  device_id: PHONE,
  name: "Wenjing’s iPhone",
  platform: "ios",
  claimed_platform: "ios",
  method: "qr",
  paired_at: T0,
  online: true,
  last_seen_at: T0,
  ...over,
});

function remoteTransport(status = accountStatus(), devices: unknown[] = []) {
  const t = baseTransport();
  t.handlers["health.settings.get"] = () => ({ settings: { enabled: false, time: "09:00", timezone: "UTC" } });
  t.handlers["cli.tokens.list"] = () => ({ tokens: [] });
  t.handlers["account.status"] = () => ({ status });
  t.handlers["devices.list"] = () => ({ devices });
  t.handlers["account.sign_in"] = () => ({ status: accountStatus({ state: "signing_in" }) });
  t.handlers["account.cancel_sign_in"] = () => ({ status: accountStatus() });
  t.handlers["account.sign_out"] = () => ({ status: accountStatus() });
  t.handlers["account.delete"] = () => ({ status: accountStatus(), provider: "deleted" });
  t.handlers["devices.pairing.start"] = () => ({ offer_id: OFFER, qr_url: QR, expires_at: Date.now() + 300_000 });
  t.handlers["devices.pairing.cancel"] = () => ({ ok: true });
  t.handlers["devices.unpair"] = () => ({ ok: true });
  return t;
}

const section = () => screen.findByRole("region", { name: "Remote access" });

describe("Settings → Remote access (§10)", () => {
  test("sign in waits for the browser; the runtime's account.changed finishes it", async () => {
    const t = remoteTransport();
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Sign in" }));
    await within(s).findByText("Continue in your browser…");
    expect(t.called("account.sign_in")).toHaveLength(1);

    t.notify("account.changed", { status: signedIn() });
    await within(s).findByText(/Signed in as me@example.com/);
    expect(within(s).getByText("Connected").getAttribute("data-relay")).toBe("connected");
    t.notify("account.changed", { status: signedIn({ relay: { state: "offline", since: T0, error: "Lost the connection to the relay." } }) });
    await within(s).findByText(/^Offline since /);
    within(s).getByText("Lost the connection to the relay.");
  });

  test("a sign-in that didn't finish says why; cancel goes back", async () => {
    const t = remoteTransport(accountStatus({ state: "signing_in" }));
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Cancel" }));
    await within(s).findByRole("button", { name: "Sign in" });
    expect(t.called("account.cancel_sign_in")).toHaveLength(1);
    t.notify("account.changed", { status: accountStatus({ error: "The sign-in page timed out." }) });
    await within(s).findByText("The sign-in page timed out.");
  });

  test("a lost sign-in asks to sign in again; a build without a relay says so", async () => {
    const t = remoteTransport(accountStatus({ state: "needs_sign_in" }));
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    await within(s).findByText("Sign in again to keep using Homerun from your phone.");
    t.notify("account.changed", { status: accountStatus({ state: "not_configured" }) });
    await within(s).findByText("This build of Homerun isn’t set up for remote access.");
    expect(within(s).queryByRole("button")).toBeNull();
  });

  test("pair a phone: a QR code of the offer and a countdown, closed when the phone pairs", async () => {
    const t = remoteTransport(signedIn());
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Pair a phone" }));
    const panel = await within(s).findByRole("dialog", { name: "Pair a phone" });
    const qr = within(panel).getByRole("img", { name: "Pairing QR code" });
    const q = encode(QR, { ecc: "M", border: 2 });
    expect(qr.getAttribute("viewBox")).toBe(`0 0 ${q.size} ${q.size}`);
    const dark = q.data.flat().filter(Boolean).length;
    expect(qr.querySelector("path")!.getAttribute("d")!.split("M").length - 1).toBe(dark);
    expect(within(panel).getByRole("timer").textContent).toMatch(/^Expires in [45]:\d\d$/);
    // The secret is only in the drawing.
    expect(document.body.textContent).not.toContain("pair#k=");

    t.notify("devices.pairing_completed", { offer_id: OFFER, device: phone() });
    t.notify("devices.changed", { devices: [phone()] });
    await within(panel).findByText("Paired with Wenjing’s iPhone.");
    fireEvent.click(within(panel).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(within(s).queryByRole("dialog")).toBeNull());
    expect(t.called("devices.pairing.cancel")).toEqual([]);
    within(within(s).getByRole("group", { name: "Paired devices" })).getByText(/Wenjing’s iPhone/);
  });

  test("cancelling pairing withdraws the offer", async () => {
    const t = remoteTransport(signedIn());
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Pair a phone" }));
    const panel = await within(s).findByRole("dialog", { name: "Pair a phone" });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(t.called("devices.pairing.cancel").map((c) => c.params)).toEqual([{ offer_id: OFFER }]));
    await within(s).findByRole("button", { name: "Pair a phone" });
  });

  test("paired devices show presence; Unpair asks first", async () => {
    const t = remoteTransport(signedIn(), [phone({ online: false, last_seen_at: Date.now() - 5 * 60_000 })]);
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    const list = await within(s).findByRole("group", { name: "Paired devices" });
    const row = (await within(list).findByText(/Wenjing’s iPhone/)).closest("li") as HTMLElement;
    expect(row.textContent).toContain("iPhone");
    expect(row.textContent).toContain("Last seen 5 min ago");
    fireEvent.click(within(row).getByRole("button", { name: "Unpair" }));
    const ask = within(row).getByRole("group", { name: /Unpair it\?/ });
    fireEvent.click(within(ask).getByRole("button", { name: "Unpair" }));
    await waitForElementToBeRemoved(() => within(list).queryByText(/Wenjing’s iPhone/));
    expect(t.called("devices.unpair").map((c) => c.params)).toEqual([{ device_id: PHONE }]);
    within(list).getByText("No phones or browsers are paired.");
  });

  test("a device linking by code is confirmed in the shell's dialog, not here", async () => {
    const t = remoteTransport(signedIn({ link_request: { name: "Work laptop", platform: "web", claimed_platform: "web" } }));
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    const note = await within(s).findByText(/A web browser called “Work laptop” is asking to link/);
    expect(note.textContent).toContain("Compare the code in the Homerun dialog");
    expect(within(s).queryByRole("button", { name: /Link|Allow/ })).toBeNull();
  });

  test("an iPhone App Attest didn't vouch for is named as one, with a browser's access (§12)", async () => {
    const t = remoteTransport(signedIn({ link_request: { name: "Old phone", platform: "web", claimed_platform: "ios" } }), [phone({ platform: "web" })]);
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    expect((await within(s).findByText(/is asking to link/)).textContent).toContain("An iPhone that Apple couldn’t verify (it would link with a browser’s access)");
    expect(within(within(s).getByRole("group", { name: "Paired devices" })).getByText("Unverified iPhone")).toBeTruthy();
  });

  test("sign out and delete account ask first", async () => {
    const t = remoteTransport(signedIn(), [phone()]);
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Delete account" }));
    const ask = within(s).getByRole("group", { name: /Delete your account\?/ });
    fireEvent.click(within(ask).getByRole("button", { name: "Delete account" }));
    await within(s).findByRole("button", { name: "Sign in" });
    expect(within(s).getByRole("status").textContent).toBe("Your account was deleted, including your sign-in.");
    expect(t.called("account.delete")).toHaveLength(1);
    expect(t.called("account.sign_out")).toEqual([]);
  });

  test("after deleting, says when the sign-in itself must be deleted by hand (§10.9)", async () => {
    const t = remoteTransport(signedIn(), [phone()]);
    t.handlers["account.delete"] = () => ({ status: accountStatus(), provider: "manual" });
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Delete account" }));
    fireEvent.click(within(within(s).getByRole("group", { name: /Delete your account\?/ })).getByRole("button", { name: "Delete account" }));
    expect((await within(s).findByRole("status")).textContent).toContain("delete it with the service you signed in with");
  });
});

describe("thread: instructions queued while offline (§9.4)", () => {
  test("say when and from which device they were sent", async () => {
    const t = baseTransport();
    t.handlers["devices.list"] = () => ({ devices: [phone()] });
    t.handlers["threads.list"] = () => ({ threads: [summary(THREAD)], has_more: false });
    const e = ev(1, "user.message", { client_msg_id: uuid(), text: "Check the build", origin: { device_id: PHONE, surface: "ios" }, disposition: "started_run" });
    e.ts = Date.now();
    e.payload.sent_at = e.ts - 3 * 3600_000;
    t.handlers["threads.history"] = () => ({ events: [e], has_more: false });
    await renderApp({ t, route: { name: "thread", thread_id: THREAD } });
    await screen.findByText("Check the build");
    await screen.findByText("Sent 3 h ago from Wenjing’s iPhone");
  });
});
