import { type AccountStatus, type PairedDevice, PROTOCOL_VERSION } from "@homerun/core";
import { Account, MemoryStore, RemoteClient, type RemoteLive } from "@homerun/remote";
import { startLocalRelay, type LocalRelay } from "@homerun/relay/local";
import { ApnsMock, OidcIssuer } from "@homerun/testkit";
import { RpcClient } from "../../src/rpc/client";
import { LAUNCH_TOKEN, socketRuntime, until, type SocketRuntime } from "../helpers";

/**
 * Remote access end to end, all local (§16.2): a local OIDC issuer, the relay's Bun adapter
 * with a mock APNs, the runtime in process with a stand-in shell, and the reference client
 * playing the phone or browser.
 */

export interface World {
  issuer: OidcIssuer;
  apns: ApnsMock;
  relay: LocalRelay;
  stop(): Promise<void>;
}

export async function startWorld(): Promise<World> {
  const issuer = await OidcIssuer.start();
  const apns = await ApnsMock.start();
  const relay = await startLocalRelay({
    issuer: issuer.url,
    clientId: issuer.clientId,
    apns: { keyP8: apns.p8, keyId: apns.keyId, teamId: apns.teamId, topic: apns.topic, endpoint: apns.url },
  });
  return {
    issuer,
    apns,
    relay,
    async stop() {
      await relay.stop();
      await apns.stop();
      await issuer.stop();
    },
  };
}

/** A new person for each test, so relay limits and devices don't carry over. */
export function newUser(w: World, name = "ada"): string {
  const sub = `user_${name}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  w.issuer.consent = { user: { sub, email: `${name}@example.com` } };
  return sub;
}

export const envFor = (w: World) => ({ HOMERUN_RELAY_URL: w.relay.url, HOMERUN_OIDC_ISSUER: w.issuer.url, HOMERUN_OIDC_CLIENT_ID: w.issuer.clientId });

export interface LinkPrompt {
  request_id: string;
  name: string;
  platform: "ios" | "web";
  code: string;
  expires_at: number;
}

/**
 * The shell, as far as remote access goes: keeps what the runtime persists in a keychain (a Map
 * that outlives the runtime), hands it over after hello as the Rust shell does, opens the
 * browser (signing in as the issuer's current user when `browse` is "auto"), and records
 * notifications and link prompts.
 */
export async function shellFor(
  s: SocketRuntime,
  issuer: OidcIssuer,
  o: { browse?: "auto" | "manual"; keychain?: Map<string, string>; hand?: boolean; hang?: boolean } = {},
) {
  const keychain = o.keychain ?? new Map<string, string>();
  const opened: string[] = [];
  const statuses: AccountStatus[] = [];
  const devices: PairedDevice[][] = [];
  const prompts: LinkPrompt[] = [];
  const withdrawn: { request_id: string; reason: string }[] = [];
  const notes: { method: string; params: unknown }[] = [];
  const c = await RpcClient.connect(s.rt.config.socketPath);
  c.onRequest((method, params) => {
    const p = params as { name: string; value?: string };
    if (o.hang) return new Promise(() => {});
    if (method === "secrets.persist") keychain.set(p.name, p.value!);
    else if (method === "secrets.delete") keychain.delete(p.name);
    return method === "secrets.persist" ? { stored: true } : { deleted: true };
  });
  c.onNotification((method, params) => {
    notes.push({ method, params });
    if (method === "account.changed") statuses.push((params as { status: AccountStatus }).status);
    if (method === "devices.changed") devices.push((params as { devices: PairedDevice[] }).devices);
    if (method === "devices.link_requested") prompts.push(params as LinkPrompt);
    if (method === "devices.link_withdrawn") withdrawn.push(params as { request_id: string; reason: string });
    if (method !== "browser.open") return;
    const url = (params as { url: string }).url;
    opened.push(url);
    if ((o.browse ?? "auto") === "auto") void issuer.browse(url).then((cb) => fetch(cb)).catch(() => {});
  });
  await c.handshake("shell", { kind: "launch_token", token: LAUNCH_TOKEN });
  // In the Rust shell's order (`SECRET_NAMES`).
  const order = ["anthropic_api_key", "device_static_key", "refresh_token"] as const;
  if (o.hand !== false) for (const name of order) if (keychain.has(name)) await c.call("secrets.set", { name, value: keychain.get(name)! });
  const status = async () => (await c.call("account.status", {})).status;
  return { c, keychain, opened, statuses, devices, prompts, withdrawn, notes, status };
}

export type Shell = Awaited<ReturnType<typeof shellFor>>;

export const settled = (sh: { statuses: AccountStatus[] }, state: AccountStatus["state"], timeoutMs = 5000) =>
  until(() => sh.statuses.at(-1)?.state === state, timeoutMs, state);

export const relayState = (sh: Shell, state: AccountStatus["relay"]["state"], timeoutMs = 5000) =>
  until(() => sh.statuses.at(-1)?.relay.state === state, timeoutMs, `relay ${state}`);

/** A desktop: the runtime with its shell, signed in and connected to the relay. */
export async function desktop(w: World, o: { dir?: string; keychain?: Map<string, string>; signIn?: boolean; remote?: NonNullable<Parameters<typeof socketRuntime>[0]>["remote"] } = {}) {
  const srt = await socketRuntime({
    env: envFor(w),
    ...(o.dir ? { dir: o.dir } : {}),
    remote: { linkBackoff: { initialMs: 50, maxMs: 500 }, ...o.remote },
  });
  const sh = await shellFor(srt, w.issuer, { keychain: o.keychain });
  if (o.signIn !== false && (await sh.status()).state !== "signed_in") {
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
  }
  return { srt, sh, rt: srt.rt };
}

/** Waits until the desktop's relay link is up. */
export async function connected(sh: Shell, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await sh.status()).relay.state !== "connected") {
    if (Date.now() > deadline) throw new Error(`the relay link didn't connect: ${JSON.stringify((await sh.status()).relay)}`);
    await Bun.sleep(10);
  }
}

/** A phone (or browser) signed in as the issuer's current user, registered and connected. */
export async function phone(w: World, o: { kind?: "ios" | "web"; name?: string; store?: MemoryStore } = {}) {
  const account = await Account.create({
    issuer: w.issuer.url,
    clientId: w.issuer.clientId,
    allowInsecureLoopback: true,
    redirectUri: "http://127.0.0.1:53682/callback",
    browser: (url) => w.issuer.browse(url),
  });
  await account.signIn();
  const kind = o.kind ?? "ios";
  const client = await RemoteClient.create({
    relayUrl: w.relay.url,
    account,
    store: o.store ?? new MemoryStore(),
    kind,
    name: o.name ?? (kind === "web" ? "Chrome on Linux" : "Ada's iPhone"),
    reconnect: { initialMs: 50, maxMs: 500 },
  });
  await client.register();
  await client.connect();
  return { client, account };
}

/** Says hello on a live session as the paired device it is. */
export async function helloLive(live: RemoteLive, deviceId: string, role: "ios" | "web" = "ios", asDevice = deviceId) {
  return live.request("hello", {
    protocol: { min: 1, max: PROTOCOL_VERSION },
    role,
    auth: { kind: "paired_device", device_id: asDevice },
    client: { name: "reference-client", version: "0" },
    capabilities: [],
  });
}
