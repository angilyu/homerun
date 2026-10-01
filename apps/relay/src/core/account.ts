import { CLOCK_SKEW_MS, type DeviceId } from "@homerun/core";
import {
  type AccountDeleted,
  type AppAttestPolicy,
  attestedRole,
  buildApnsPayload,
  challengeBytes,
  CLOSE,
  ClientFrame,
  type DeviceKind,
  type LinkedDevice,
  PAIR_OFFER_TTL_MS,
  LINK_ATTEMPT_TTL_MS,
  parseDeviceProof,
  PostSealed,
  PushTokenBody,
  RegisterDevice,
  RELAY_PATHS,
  REQUEST_SKEW_MS,
  requestBytes,
  type RelayErrorCode,
  SEALED_MAX_LIFETIME_MS,
  type SealedEnvelope,
  type ServerFrame,
  toB64url,
  utf8,
  verifyLinkStatement,
  verifyAttestation,
  verifySignature,
} from "@homerun/protocol";
import type { VerifiedToken } from "../auth";
import type { PushSender } from "../apns";
import type { RelayLimits } from "../config";
import type { ProviderAdmin } from "./provider-admin";
import { migrate, one, type Sql } from "./sql";

/**
 * One account's relay (§9.4): devices and their links, routing live frames and sealed messages
 * only between linked devices, the per-device queue, presence, pairing and linking rendezvous,
 * rate limits and expiry. Platform-neutral: the Durable Object and the Bun adapter supply a
 * `RelayHost`. All state is in SQL or on the socket, so a hibernated object resumes exactly.
 * The relay sees routing metadata only; everything end to end is Noise ciphertext.
 */

export interface SocketState {
  cid: string;
  phase: "challenge" | "ready";
  nonce: string;
  deviceId: string | null;
  tokenExp: number;
  connectedAt: number;
  lastSeenWrite: number;
}

export interface RelaySocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  state(): SocketState | null;
  setState(s: SocketState): void;
}

export interface RelayHost {
  sql: Sql;
  sockets(): RelaySocket[];
  /** Schedules `alarm()` at `at`, replacing any earlier schedule; null cancels. */
  setAlarm(at: number | null): void;
  now(): number;
  verifyToken(token: string): Promise<VerifiedToken>;
  push: PushSender | null;
  limits: RelayLimits;
  /**
   * Whose App Attest attestations make a device an iPhone here (§9.8, §18 row 99): only an
   * attested iPhone gets pushes and answers from the lock screen. The desktop checks the same
   * attestation for itself, so a relay that lies about it gains nothing (§13).
   */
  appAttest: AppAttestPolicy;
  /** Deletes the user at the identity provider when the account is deleted (§10.9); null: by hand. */
  providerAdmin: ProviderAdmin | null;
  /** Deletes every row of this account (account deletion). */
  wipe(): void;
  log?(event: string, fields?: Record<string, unknown>): void;
}

interface DeviceRow {
  device_id: string;
  kind: DeviceKind;
  name: string;
  static_public_key: string;
  signing_public_key: string;
  created_at: number;
  last_seen_at: number | null;
}

class RelayFailure extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: RelayErrorCode, message: string): never {
  throw new RelayFailure(code, message);
}

const HTTP_STATUS: Record<RelayErrorCode, number> = {
  unauthenticated: 401,
  token_expired: 401,
  device_proof_invalid: 401,
  device_unknown: 404,
  device_key_mismatch: 409,
  not_linked: 403,
  forbidden: 403,
  invalid: 400,
  too_large: 413,
  queue_full: 429,
  rate_limited: 429,
  too_many_devices: 409,
  offer_unknown: 404,
  not_found: 404,
  internal: 502,
};

export function errorResponse(code: RelayErrorCode, message: string): Response {
  return new Response(JSON.stringify({ error: code, message: message.slice(0, 500) }), {
    status: HTTP_STATUS[code],
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const randomId = () => toB64url(crypto.getRandomValues(new Uint8Array(16)));

/** Which kinds of sealed message may go from which kind of device to which (§9.4, §9.7). */
const SEALED_ROUTES: Record<SealedEnvelope["header"]["kind"], { from: DeviceKind[]; to: DeviceKind[] }> = {
  instruction: { from: ["ios", "web"], to: ["desktop"] },
  answer: { from: ["ios"], to: ["desktop"] },
  push: { from: ["desktop"], to: ["ios"] },
};

/**
 * After an account is deleted, the relay keeps a tombstone this long: its id, when, and whether
 * the provider's user is deleted yet. Tokens issued before the deletion are refused meanwhile,
 * so a device that hasn't heard can't register again into an empty account. No access token
 * lives this long (WorkOS's live 5 minutes).
 */
export const TOMBSTONE_MS = 24 * 3_600_000;

/** When to try the provider again after the `n`th failure: a minute, doubling, at most 6 h. */
export const providerRetryDelay = (n: number) => Math.min(60_000 * 2 ** (n - 1), 6 * 3_600_000);

type Binding = "ok" | "other" | "deleted";

export class AccountRelay {
  private buckets = new Map<string, { tokens: number; at: number; dropped: number }>();

  constructor(private readonly host: RelayHost) {
    migrate(host.sql);
  }

  private get sql() {
    return this.host.sql;
  }
  private get limits() {
    return this.host.limits;
  }

  /**
   * The account this storage belongs to, bound on first use. `other` if it belongs to another;
   * `deleted` if the account was deleted after `auth` was issued (`iat` is whole seconds, so a
   * token from the second of the deletion counts as before), or its user at the provider isn't
   * deleted yet.
   */
  bind(auth: VerifiedToken): Binding {
    const row = one(this.sql.all<{ v: string }>(`SELECT v FROM meta WHERE k = 'account'`));
    if (row && row.v !== auth.sub) return "other";
    const deletedAt = this.meta("deleted_at");
    if (deletedAt !== null && (this.meta("provider_pending") !== null || auth.iat <= Number(deletedAt))) return "deleted";
    if (!row) this.sql.run(`INSERT INTO meta (k, v) VALUES ('account', ?), ('created_at', ?)`, auth.sub, String(this.host.now()));
    return "ok";
  }

  private meta(k: string): string | null {
    return one(this.sql.all<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k))?.v ?? null;
  }

  private setMeta(k: string, v: string | number): void {
    this.sql.run(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  private account(): string {
    return one(this.sql.all<{ v: string }>(`SELECT v FROM meta WHERE k = 'account'`))?.v ?? "";
  }

  // ------------------------------------------------------------------ HTTP

  async http(req: Request, auth: VerifiedToken): Promise<Response> {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    try {
      const bound = this.bind(auth);
      if (bound === "other") return errorResponse("forbidden", "wrong account");
      if (bound === "deleted") return errorResponse("unauthenticated", "the account was deleted");
      const P = RELAY_PATHS;
      switch (`${req.method} ${url.pathname}`) {
        case `POST ${P.devices}`:
          return this.register(req, url, body);
        case `GET ${P.devices}`: {
          const me = this.proof(req, url, body);
          return okJson({ devices: this.devicesFor(me.device_id, true) });
        }
        case `POST ${P.sealed}`: {
          const me = this.proof(req, url, body);
          const parsed = PostSealed.safeParse(parseJson(body));
          if (!parsed.success) return errorResponse("invalid", "not a sealed envelope");
          const r = await this.routeSealed(parsed.data.envelope, me, body.length);
          return okJson({ msg_id: parsed.data.envelope.header.msg_id, status: r }, 202);
        }
        case `POST ${P.pushToken}`: {
          const me = this.proof(req, url, body);
          if (me.kind !== "ios") return errorResponse("forbidden", "only an iOS device has a push token");
          const parsed = PushTokenBody.safeParse(parseJson(body));
          if (!parsed.success) return errorResponse("invalid", "not a push token");
          this.sql.run(
            `INSERT INTO push_tokens (device_id, token, environment, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (device_id) DO UPDATE SET token = excluded.token, environment = excluded.environment, updated_at = excluded.updated_at`,
            me.device_id,
            parsed.data.token,
            parsed.data.environment,
            this.host.now(),
          );
          return new Response(null, { status: 204 });
        }
        case `DELETE ${P.pushToken}`: {
          const me = this.proof(req, url, body);
          this.sql.run(`DELETE FROM push_tokens WHERE device_id = ?`, me.device_id);
          return new Response(null, { status: 204 });
        }
        case `DELETE ${P.account}`: {
          this.proof(req, url, body);
          return okJson(await this.deleteAccount(auth.sub), 202);
        }
        default:
          return errorResponse("not_found", "no such endpoint");
      }
    } catch (e) {
      if (e instanceof RelayFailure) return errorResponse(e.code, e.message);
      this.host.log?.("http_error", { error: String(e) });
      return errorResponse("internal", "internal error");
    }
  }

  /** Checks the `homerun-device` header: a signature by a registered device's key (or `key`). */
  private proof(req: Request, url: URL, body: Uint8Array, key?: { deviceId: string; signing: string }): DeviceRow {
    const p = parseDeviceProof(req.headers.get("homerun-device"));
    if (!p) fail("device_proof_invalid", "missing device proof");
    const proof = p!;
    if (Math.abs(this.host.now() - proof.ts) > REQUEST_SKEW_MS) fail("device_proof_invalid", "device proof timestamp out of range");
    const row = this.device(proof.deviceId);
    let signing: string;
    if (key) {
      if (key.deviceId !== proof.deviceId) fail("device_proof_invalid", "device proof is for another device");
      signing = key.signing;
    } else {
      if (!row) fail("device_unknown", "device not registered");
      signing = row!.signing_public_key;
    }
    if (!verifySignature(proof.signature, requestBytes(proof.deviceId, proof.ts, req.method, url.pathname, body), signing)) {
      fail("device_proof_invalid", "device proof does not verify");
    }
    return row as DeviceRow;
  }

  private register(req: Request, url: URL, body: Uint8Array): Response {
    const parsed = RegisterDevice.safeParse(parseJson(body));
    if (!parsed.success) return errorResponse("invalid", "not a device registration");
    const { device, name } = parsed.data;
    this.proof(req, url, body, { deviceId: device.device_id, signing: device.signing_public_key });
    const existing = this.device(device.device_id);
    if (existing) {
      // The role was settled at the first registration; an iPhone doesn't re-attest to keep it,
      // and one registered as a browser stays one (a new attestation doesn't upgrade it).
      const sameKind = existing.kind === device.kind || (existing.kind === "web" && device.kind === "ios");
      if (
        !sameKind ||
        existing.static_public_key !== device.static_public_key ||
        existing.signing_public_key !== device.signing_public_key
      ) {
        return errorResponse("device_key_mismatch", "this device id is registered with other keys");
      }
      this.sql.run(`UPDATE devices SET name = ? WHERE device_id = ?`, name, device.device_id);
    } else {
      const n = one(this.sql.all<{ n: number }>(`SELECT count(*) AS n FROM devices`))!.n;
      if (n >= this.limits.maxDevices) return errorResponse("too_many_devices", `at most ${this.limits.maxDevices} devices per account`);
      if (!this.rate("register", this.limits.registrationsPerHour, 60 * 60 * 1000)) return errorResponse("rate_limited", "too many registrations");
      const kind = this.attestedKind(device, parsed.data.attestation);
      this.sql.run(
        `INSERT INTO devices (device_id, kind, name, static_public_key, signing_public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        device.device_id,
        kind,
        name,
        device.static_public_key,
        device.signing_public_key,
        this.host.now(),
      );
    }
    return okJson({ device: this.linkedView(this.device(device.device_id)!, null) });
  }

  /** An iPhone without an attestation of these keys that verifies registers as a browser. */
  private attestedKind(device: RegisterDevice["device"], attestation: RegisterDevice["attestation"]): DeviceKind {
    if (device.kind !== "ios") return device.kind;
    if (!attestation) return "web";
    const r = verifyAttestation(attestation, device, this.host.appAttest, this.host.now());
    if (!r.ok) this.host.log?.("attestation_rejected", { reason: r.reason });
    return attestedRole("ios", r);
  }

  /**
   * Deletes everything the relay holds for the account (§10.7), then its user at the identity
   * provider (§10.9). If the provider fails, the alarm tries again until it works, and the
   * account's tokens are refused meanwhile.
   */
  private async deleteAccount(sub: string): Promise<AccountDeleted> {
    for (const s of this.host.sockets()) s.close(CLOSE.DEVICE_REMOVED, "account deleted");
    this.buckets.clear();
    this.host.setAlarm(null);
    this.host.wipe();
    migrate(this.sql);
    // The tombstone is written before the provider is called, so nothing registers meanwhile.
    this.setMeta("account", sub);
    this.setMeta("deleted_at", this.host.now());
    if (!this.host.providerAdmin) {
      this.host.log?.("account_deleted", { provider: "manual" });
      this.schedule();
      return { provider: "manual" };
    }
    this.setMeta("provider_pending", sub);
    this.setMeta("provider_attempts", 0);
    const done = await this.deleteAtProvider(sub);
    this.host.log?.("account_deleted", { provider: done ? "deleted" : "pending" });
    this.schedule();
    return { provider: done ? "deleted" : "pending" };
  }

  /** One attempt at the provider. True once the user is gone; otherwise schedules the next. */
  private async deleteAtProvider(sub: string): Promise<boolean> {
    try {
      await this.host.providerAdmin!.deleteUser(sub);
      this.sql.run(`DELETE FROM meta WHERE k IN ('provider_pending', 'provider_attempts', 'provider_next_at')`);
      return true;
    } catch (e) {
      const n = Number(this.meta("provider_attempts") ?? 0) + 1;
      this.setMeta("provider_attempts", n);
      this.setMeta("provider_next_at", this.host.now() + providerRetryDelay(n));
      this.host.log?.("provider_delete_failed", { attempt: n, status: (e as { status?: number | null }).status ?? null });
      return false;
    }
  }

  // ------------------------------------------------------------------ WebSocket

  open(ws: RelaySocket, auth: VerifiedToken): void {
    const bound = this.bind(auth);
    if (bound !== "ok") {
      // A device that missed the deletion hears it now, and forgets the account.
      if (bound === "deleted") ws.close(CLOSE.DEVICE_REMOVED, "account deleted");
      else ws.close(CLOSE.PROTOCOL_ERROR, "wrong account");
      return;
    }
    const now = this.host.now();
    const state: SocketState = { cid: randomId(), phase: "challenge", nonce: randomId(), deviceId: null, tokenExp: auth.exp, connectedAt: now, lastSeenWrite: 0 };
    ws.setState(state);
    this.send(ws, { type: "challenge", nonce: state.nonce });
    this.schedule();
  }

  async message(ws: RelaySocket, text: string): Promise<void> {
    const st = ws.state();
    if (!st) return;
    const now = this.host.now();
    if (now > st.tokenExp + 60_000) {
      ws.close(CLOSE.TOKEN_EXPIRED, "token expired");
      return;
    }
    if (!this.admit(ws, st)) return;
    const parsed = ClientFrame.safeParse(parseJsonText(text));
    if (!parsed.success) {
      if (st.phase === "challenge") ws.close(CLOSE.PROTOCOL_ERROR, "expected auth");
      else this.error(ws, "invalid", "malformed frame");
      return;
    }
    const f = parsed.data;
    if (st.phase === "challenge") {
      if (f.type !== "auth") {
        ws.close(CLOSE.PROTOCOL_ERROR, "expected auth");
        return;
      }
      this.authenticate(ws, st, f.device_id, f.signature);
      return;
    }
    const me = this.device(st.deviceId!);
    if (!me) {
      ws.close(CLOSE.DEVICE_REMOVED, "device removed");
      return;
    }
    this.touch(ws, st, now);
    try {
      await this.frame(ws, st, me, f);
    } catch (e) {
      if (e instanceof RelayFailure) this.error(ws, e.code, e.message, refOf(f));
      else {
        this.host.log?.("frame_error", { error: String(e) });
        this.error(ws, "internal", "internal error", refOf(f));
      }
    }
  }

  closed(ws: RelaySocket): void {
    const st = ws.state();
    if (!st) return;
    this.buckets.delete(st.cid);
    if (st.phase !== "ready" || !st.deviceId) return;
    const now = this.host.now();
    const stillHere = this.socketOf(st.deviceId, ws);
    if (stillHere) return;
    this.sql.run(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`, now, st.deviceId);
    this.presence(st.deviceId, false, now);
  }

  private authenticate(ws: RelaySocket, st: SocketState, deviceId: string, signature: string): void {
    const d = this.device(deviceId);
    if (!d || !verifySignature(signature, challengeBytes(st.nonce, deviceId), d.signing_public_key)) {
      this.send(ws, { type: "error", code: d ? "device_proof_invalid" : "device_unknown", message: "authentication failed" });
      ws.close(CLOSE.DEVICE_PROOF_INVALID, "authentication failed");
      return;
    }
    const old = this.socketOf(deviceId, ws);
    if (old) old.close(CLOSE.REPLACED, "replaced by a newer connection");
    const now = this.host.now();
    ws.setState({ ...st, phase: "ready", deviceId, lastSeenWrite: now });
    this.sql.run(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`, now, deviceId);
    this.send(ws, { type: "ready", device_id: deviceId as DeviceId, links: this.devicesFor(deviceId, false), token_expires_at: st.tokenExp });
    this.presence(deviceId, true, now);
    for (const q of this.sql.all<{ id: string; envelope: string }>(
      `SELECT id, envelope FROM queue WHERE to_device_id = ? AND expires_at > ? ORDER BY created_at, rowid`,
      deviceId,
      now,
    )) {
      ws.send(`{"type":"sealed","id":${JSON.stringify(q.id)},"envelope":${q.envelope}}`);
    }
    this.schedule();
  }

  private async frame(ws: RelaySocket, st: SocketState, me: DeviceRow, f: ClientFrame): Promise<void> {
    const now = this.host.now();
    switch (f.type) {
      case "auth":
        return fail("invalid", "already authenticated");
      case "ping":
        return this.send(ws, { type: "pong" });
      case "reauth": {
        const t = await this.host.verifyToken(f.token).catch((e: { code?: RelayErrorCode; message?: string }) =>
          fail(e.code === "token_expired" ? "token_expired" : "unauthenticated", e.message ?? "token rejected"),
        );
        if (t.sub !== this.account()) return fail("unauthenticated", "the token is for another account");
        const cur = ws.state();
        if (cur) ws.setState({ ...cur, tokenExp: t.exp });
        this.send(ws, { type: "reauthed", token_expires_at: t.exp });
        return this.schedule();
      }
      case "live": {
        this.requireLink(me.device_id, f.to);
        const peer = this.socketOf(f.to);
        if (!peer) return this.send(ws, { type: "live_close", from: f.to, session: f.session });
        return this.send(peer, { type: "live", from: me.device_id as DeviceId, session: f.session, data: f.data });
      }
      case "live_close": {
        this.requireLink(me.device_id, f.to);
        const peer = this.socketOf(f.to);
        if (peer) this.send(peer, { type: "live_close", from: me.device_id as DeviceId, session: f.session });
        return;
      }
      case "sealed": {
        const status = await this.routeSealed(f.envelope, me, utf8(JSON.stringify(f.envelope)).length);
        return this.send(ws, { type: "receipt", msg_id: f.envelope.header.msg_id, to: f.envelope.header.to_device_id, status });
      }
      case "ack": {
        const row = one(
          this.sql.all<{ from_device_id: string; msg_id: string }>(
            `DELETE FROM queue WHERE id = ? AND to_device_id = ? RETURNING from_device_id, msg_id`,
            f.id,
            me.device_id,
          ),
        );
        if (!row) return;
        const sender = this.socketOf(row.from_device_id);
        if (sender) this.send(sender, { type: "receipt", msg_id: row.msg_id, to: me.device_id as DeviceId, status: "delivered" });
        return this.schedule();
      }
      case "pair_open": {
        if (me.kind !== "desktop") return fail("forbidden", "only a desktop offers pairing");
        if (f.expires_at <= now || f.expires_at > now + PAIR_OFFER_TTL_MS + CLOCK_SKEW_MS) return fail("invalid", "offer expiry out of range");
        this.sql.run(`DELETE FROM offers WHERE expires_at <= ?`, now);
        const n = one(this.sql.all<{ n: number }>(`SELECT count(*) AS n FROM offers WHERE desktop_device_id = ? AND offer != ?`, me.device_id, f.offer))!.n;
        if (n >= this.limits.offersPerDesktop) return fail("rate_limited", "too many open pairing offers");
        this.sql.run(
          `INSERT INTO offers (offer, desktop_device_id, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (offer) DO UPDATE SET expires_at = excluded.expires_at WHERE desktop_device_id = excluded.desktop_device_id`,
          f.offer,
          me.device_id,
          f.expires_at,
        );
        return this.schedule();
      }
      case "pair_close":
        this.sql.run(`DELETE FROM offers WHERE offer = ? AND desktop_device_id = ?`, f.offer, me.device_id);
        return;
      case "rendezvous":
        return this.rendezvous(me, f, now);
      case "rendezvous_close": {
        const r = one(this.sql.all<{ initiator: string; responder: string }>(`SELECT initiator, responder FROM rendezvous WHERE session = ?`, f.session));
        if (!r || ![r.initiator, r.responder].includes(me.device_id) || ![r.initiator, r.responder].includes(f.to)) return;
        this.sql.run(`DELETE FROM rendezvous WHERE session = ?`, f.session);
        const peer = this.socketOf(f.to);
        if (peer) this.send(peer, { type: "rendezvous_close", from: me.device_id as DeviceId, session: f.session });
        return;
      }
      case "link_add":
        return this.linkAdd(me, f.statement, f.offer, now);
      case "link_remove":
        return this.linkRemove(me, f.device_id);
    }
  }

  private rendezvous(me: DeviceRow, f: Extract<ClientFrame, { type: "rendezvous" }>, now: number): void {
    const r = one(
      this.sql.all<{ kind: string; initiator: string; responder: string; expires_at: number }>(
        `SELECT kind, initiator, responder, expires_at FROM rendezvous WHERE session = ?`,
        f.session,
      ),
    );
    let first = false;
    if (r) {
      const ends = [r.initiator, r.responder];
      if (r.kind !== f.kind || r.expires_at <= now || !ends.includes(me.device_id) || !ends.includes(f.to) || f.to === me.device_id) {
        return fail("forbidden", "not part of this session");
      }
    } else {
      if (me.kind === "desktop") return fail("forbidden", "a desktop answers pairing and linking; it doesn't start them");
      const target = this.device(f.to);
      if (!target || target.kind !== "desktop") return fail("device_unknown", "no such desktop in this account");
      if (f.kind === "pair") {
        const offer = f.offer
          ? one(this.sql.all(`SELECT 1 FROM offers WHERE offer = ? AND desktop_device_id = ? AND expires_at > ?`, f.offer, f.to, now))
          : null;
        if (!offer) return fail("offer_unknown", "the desktop has no such pairing offer open");
      }
      if (!this.rate("rendezvous", this.limits.rendezvousPerTenMinutes, 10 * 60 * 1000)) return fail("rate_limited", "too many pairing or linking attempts");
      const ttl = f.kind === "pair" ? PAIR_OFFER_TTL_MS : LINK_ATTEMPT_TTL_MS;
      this.sql.run(
        `INSERT INTO rendezvous (session, kind, initiator, responder, expires_at) VALUES (?, ?, ?, ?, ?)`,
        f.session,
        f.kind,
        me.device_id,
        f.to,
        now + ttl,
      );
      first = true;
      this.schedule();
    }
    const peer = this.socketOf(f.to);
    if (!peer) return fail("not_found", "the other device is offline");
    this.send(peer, {
      type: "rendezvous",
      kind: f.kind,
      from: me.device_id as DeviceId,
      session: f.session,
      data: f.data,
      ...(first ? { device: { kind: me.kind, name: me.name } } : {}),
    });
  }

  private linkAdd(me: DeviceRow, raw: unknown, offer: string | undefined, now: number): void {
    if (me.kind !== "desktop") return fail("forbidden", "only a desktop signs links");
    const s = verifyLinkStatement(raw, me.signing_public_key);
    if (!s) return fail("invalid", "the link statement does not verify");
    if (s.desktop_device_id !== me.device_id || s.desktop_static_public_key !== me.static_public_key) return fail("invalid", "the statement is for another desktop");
    if (s.account !== this.account()) return fail("invalid", "the statement is for another account");
    const d = this.device(s.device_id);
    if (!d) return fail("device_unknown", "the linked device is not registered");
    if (d.kind !== s.platform || d.static_public_key !== s.device_static_public_key || d.signing_public_key !== s.device_signing_public_key) {
      return fail("invalid", "the statement doesn't match the device's registration");
    }
    this.sql.tx(() => {
      this.sql.run(
        `INSERT INTO links (desktop_device_id, device_id, statement, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (desktop_device_id, device_id) DO UPDATE SET statement = excluded.statement`,
        me.device_id,
        d.device_id,
        JSON.stringify(s),
        now,
      );
      if (offer) this.sql.run(`DELETE FROM offers WHERE offer = ? AND desktop_device_id = ?`, offer, me.device_id);
    });
    this.sendLinks(me.device_id);
    this.sendLinks(d.device_id);
  }

  private linkRemove(me: DeviceRow, other: string): void {
    const [desktop, device] = me.kind === "desktop" ? [me.device_id, other] : [other, me.device_id];
    const exists = one(this.sql.all(`SELECT 1 FROM links WHERE desktop_device_id = ? AND device_id = ?`, desktop, device));
    if (!exists) return fail("not_linked", "these devices are not linked");
    let removed = false;
    this.sql.tx(() => {
      this.sql.run(`DELETE FROM links WHERE desktop_device_id = ? AND device_id = ?`, desktop, device);
      this.sql.run(
        `DELETE FROM queue WHERE (to_device_id = ? AND from_device_id = ?) OR (to_device_id = ? AND from_device_id = ?)`,
        desktop,
        device,
        device,
        desktop,
      );
      // A phone or browser linked to nothing has no reason to hold a relay credential (§9.6 step 5).
      const left = one(this.sql.all<{ n: number }>(`SELECT count(*) AS n FROM links WHERE device_id = ?`, device))!.n;
      if (left === 0) {
        this.sql.run(`DELETE FROM devices WHERE device_id = ?`, device);
        this.sql.run(`DELETE FROM push_tokens WHERE device_id = ?`, device);
        this.sql.run(`DELETE FROM queue WHERE to_device_id = ? OR from_device_id = ?`, device, device);
        removed = true;
      }
    });
    this.sendLinks(desktop);
    if (removed) this.socketOf(device)?.close(CLOSE.DEVICE_REMOVED, "unpaired");
    else this.sendLinks(device);
    this.schedule();
  }

  // ------------------------------------------------------------------ sealed routing

  private async routeSealed(env: SealedEnvelope, from: DeviceRow, bytes: number): Promise<"queued" | "pushed"> {
    const h = env.header;
    const now = this.host.now();
    if (h.from_device_id !== from.device_id) fail("forbidden", "the envelope names another sender");
    const to = this.device(h.to_device_id);
    if (!to) fail("device_unknown", "no such recipient");
    this.requireLink(from.device_id, h.to_device_id);
    const route = SEALED_ROUTES[h.kind];
    if (!route.from.includes(from.kind) || !route.to.includes(to!.kind)) fail("forbidden", `a ${from.kind} can't send a ${h.kind} to a ${to!.kind}`);
    if (bytes > this.limits.sealedMaxBytes) fail("too_large", "sealed message too large");
    if (h.expires_at + CLOCK_SKEW_MS <= now) fail("invalid", "already expired");
    if (h.expires_at > now + SEALED_MAX_LIFETIME_MS[h.kind] + CLOCK_SKEW_MS) fail("invalid", "expiry too far in the future");

    if (h.kind === "push") {
      if (one(this.sql.all(`SELECT 1 FROM pushed WHERE to_device_id = ? AND msg_id = ?`, h.to_device_id, h.msg_id))) return "pushed";
      if (!this.rate("sealed", this.limits.sealedPerMinute, 60_000)) fail("rate_limited", "too many messages");
      return this.push(env, to!);
    }

    if (one(this.sql.all(`SELECT 1 FROM queue WHERE to_device_id = ? AND msg_id = ?`, h.to_device_id, h.msg_id))) return "queued";
    if (!this.rate("sealed", this.limits.sealedPerMinute, 60_000)) fail("rate_limited", "too many messages");
    this.enqueue(env, from.device_id);
    return "queued";
  }

  /** Queues `env` for its recipient, within the queue bounds, and delivers it if they're online. */
  private enqueue(env: SealedEnvelope, fromDeviceId: string): void {
    const h = env.header;
    const now = this.host.now();
    const envelope = JSON.stringify(env);
    const size = utf8(envelope).length;
    const q = one(
      this.sql.all<{ n: number; b: number }>(`SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM queue WHERE to_device_id = ? AND expires_at > ?`, h.to_device_id, now),
    )!;
    if (q.n + 1 > this.limits.queueMaxMessages || q.b + size > this.limits.queueMaxBytes) fail("queue_full", "the recipient's queue is full");
    const id = randomId();
    this.sql.run(
      `INSERT INTO queue (id, msg_id, to_device_id, from_device_id, kind, envelope, bytes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      h.msg_id,
      h.to_device_id,
      fromDeviceId,
      h.kind,
      envelope,
      size,
      h.expires_at + CLOCK_SKEW_MS,
      now,
    );
    const peer = this.socketOf(h.to_device_id);
    if (peer) peer.send(`{"type":"sealed","id":${JSON.stringify(id)},"envelope":${envelope}}`);
    this.schedule();
  }

  private async push(env: SealedEnvelope, to: DeviceRow): Promise<"pushed"> {
    const t = one(this.sql.all<{ token: string; environment: "sandbox" | "production" }>(`SELECT token, environment FROM push_tokens WHERE device_id = ?`, to.device_id));
    if (!t) fail("not_found", "the device has no push token");
    if (!this.host.push) fail("internal", "push is not configured");
    const payload = buildApnsPayload(env);
    // Too big for APNs: the notification says something generic and the app fetches the
    // message itself when it next connects (§9.7).
    if (!payload.sealed) this.enqueue(env, env.header.from_device_id);
    const r = await this.host.push!.send(t.token, t.environment, payload, { collapseId: env.header.collapse_id });
    if (!r.ok) {
      if (r.unregistered) this.sql.run(`DELETE FROM push_tokens WHERE device_id = ? AND token = ?`, to.device_id, t.token);
      this.host.log?.("apns_failed", { status: r.status, reason: r.reason });
      return fail(r.unregistered ? "not_found" : "internal", `APNs: ${r.reason}`);
    }
    this.sql.run(
      `INSERT OR IGNORE INTO pushed (to_device_id, msg_id, expires_at) VALUES (?, ?, ?)`,
      to.device_id,
      env.header.msg_id,
      env.header.expires_at + CLOCK_SKEW_MS,
    );
    this.schedule();
    return "pushed";
  }

  // ------------------------------------------------------------------ alarm

  async alarm(): Promise<void> {
    const now = this.host.now();
    const expired = this.sql.all<{ msg_id: string; to_device_id: string; from_device_id: string }>(
      `DELETE FROM queue WHERE expires_at <= ? RETURNING msg_id, to_device_id, from_device_id`,
      now,
    );
    for (const e of expired) {
      const s = this.socketOf(e.from_device_id);
      if (s) this.send(s, { type: "receipt", msg_id: e.msg_id, to: e.to_device_id as DeviceId, status: "expired" });
    }
    this.sql.run(`DELETE FROM pushed WHERE expires_at <= ?`, now);
    this.sql.run(`DELETE FROM offers WHERE expires_at <= ?`, now);
    this.sql.run(`DELETE FROM rendezvous WHERE expires_at <= ?`, now);
    for (const ws of this.host.sockets()) {
      const st = ws.state();
      if (!st) continue;
      if (now > st.tokenExp + 60_000) ws.close(CLOSE.TOKEN_EXPIRED, "token expired");
      else if (st.phase === "challenge" && now > st.connectedAt + this.limits.challengeTimeoutMs) ws.close(CLOSE.PROTOCOL_ERROR, "no auth");
    }
    await this.tombstone(now);
    this.schedule();
  }

  /** Retries the provider, and drops the tombstone once it's done and old enough. */
  private async tombstone(now: number): Promise<void> {
    const deletedAt = this.meta("deleted_at");
    if (deletedAt === null) return;
    const pending = this.meta("provider_pending");
    if (pending !== null) {
      if (!this.host.providerAdmin) {
        // The relay no longer deletes users at the provider; the user does it by hand.
        this.sql.run(`DELETE FROM meta WHERE k IN ('provider_pending', 'provider_attempts', 'provider_next_at')`);
        this.host.log?.("account_deleted", { provider: "manual" });
      } else {
        if (Number(this.meta("provider_next_at") ?? 0) > now) return;
        if (!(await this.deleteAtProvider(pending))) return;
        this.host.log?.("account_deleted", { provider: "deleted" });
      }
    }
    if (now < Number(deletedAt) + TOMBSTONE_MS) return;
    const devices = one(this.sql.all<{ n: number }>(`SELECT count(*) AS n FROM devices`))?.n ?? 0;
    if (devices === 0) {
      this.host.wipe();
      migrate(this.sql);
    } else {
      // Signed in again since (the provider's user wasn't deleted): only the tombstone goes.
      this.sql.run(`DELETE FROM meta WHERE k = 'deleted_at'`);
    }
  }

  /** Sets the alarm to the next thing that expires. */
  private schedule(): void {
    const next = one(
      this.sql.all<{ t: number | null }>(
        `SELECT min(t) AS t FROM (
           SELECT min(expires_at) AS t FROM queue UNION ALL SELECT min(expires_at) FROM pushed
           UNION ALL SELECT min(expires_at) FROM offers UNION ALL SELECT min(expires_at) FROM rendezvous)`,
      ),
    )?.t;
    let at = next ?? null;
    const deletedAt = this.meta("deleted_at");
    if (deletedAt !== null) {
      const pending = this.meta("provider_pending") !== null && this.host.providerAdmin;
      const t = pending ? Number(this.meta("provider_next_at") ?? 0) : Number(deletedAt) + TOMBSTONE_MS;
      at = at === null ? t : Math.min(at, t);
    }
    for (const ws of this.host.sockets()) {
      const st = ws.state();
      if (!st) continue;
      const t = st.phase === "challenge" ? Math.min(st.tokenExp + 60_001, st.connectedAt + this.limits.challengeTimeoutMs + 1) : st.tokenExp + 60_001;
      at = at === null ? t : Math.min(at, t);
    }
    this.host.setAlarm(at);
  }

  // ------------------------------------------------------------------ helpers

  private device(id: string): DeviceRow | null {
    return one(this.sql.all<DeviceRow>(`SELECT * FROM devices WHERE device_id = ?`, id));
  }

  private linked(a: string, b: string): boolean {
    return !!one(
      this.sql.all(
        `SELECT 1 FROM links WHERE (desktop_device_id = ? AND device_id = ?) OR (desktop_device_id = ? AND device_id = ?)`,
        a,
        b,
        b,
        a,
      ),
    );
  }

  private requireLink(a: string, b: string): void {
    if (!this.linked(a, b)) fail("not_linked", "these devices are not linked");
  }

  private socketOf(deviceId: string, except?: RelaySocket): RelaySocket | null {
    // By connection id: a hibernated object hands back new wrappers for the same sockets.
    const skip = except?.state()?.cid;
    for (const s of this.host.sockets()) {
      const st = s.state();
      if (skip !== undefined && st?.cid === skip) continue;
      if (st?.phase === "ready" && st.deviceId === deviceId) return s;
    }
    return null;
  }

  private linkedView(d: DeviceRow, linkedAt: number | null): LinkedDevice {
    return {
      device_id: d.device_id as DeviceId,
      kind: d.kind,
      name: d.name,
      static_public_key: d.static_public_key,
      signing_public_key: d.signing_public_key,
      online: this.socketOf(d.device_id) !== null,
      last_seen_at: d.last_seen_at,
      linked_at: linkedAt,
    };
  }

  /** The devices linked with `id`; with `all`, every device of the account (linking by code). */
  private devicesFor(id: string, all: boolean): LinkedDevice[] {
    const rows = this.sql.all<DeviceRow & { linked_at: number | null }>(
      `SELECT d.*, l.created_at AS linked_at FROM devices d
       LEFT JOIN links l ON (l.desktop_device_id = ? AND l.device_id = d.device_id) OR (l.device_id = ? AND l.desktop_device_id = d.device_id)
       WHERE d.device_id != ? ${all ? "" : "AND l.created_at IS NOT NULL"}
       ORDER BY d.created_at, d.device_id`,
      id,
      id,
      id,
    );
    return rows.map((r) => this.linkedView(r, r.linked_at));
  }

  private sendLinks(deviceId: string): void {
    const s = this.socketOf(deviceId);
    if (s) this.send(s, { type: "links", links: this.devicesFor(deviceId, false) });
  }

  private presence(deviceId: string, online: boolean, at: number): void {
    const frame: ServerFrame = { type: "presence", device_id: deviceId as DeviceId, online, last_seen_at: at };
    for (const peer of this.devicesFor(deviceId, false)) {
      const s = this.socketOf(peer.device_id);
      if (s) this.send(s, frame);
    }
  }

  /** Writes `last_seen_at` at most every few minutes while a device stays connected. */
  private touch(ws: RelaySocket, st: SocketState, now: number): void {
    if (now - st.lastSeenWrite < this.limits.lastSeenWriteMs) return;
    this.sql.run(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`, now, st.deviceId);
    ws.setState({ ...st, lastSeenWrite: now });
  }

  /** Per-connection token bucket; closes a connection that keeps flooding. */
  private admit(ws: RelaySocket, st: SocketState): boolean {
    const now = this.host.now();
    const b = this.buckets.get(st.cid) ?? { tokens: this.limits.frameBurst, at: now, dropped: 0 };
    b.tokens = Math.min(this.limits.frameBurst, b.tokens + ((now - b.at) / 1000) * this.limits.framesPerSecond);
    b.at = now;
    this.buckets.set(st.cid, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    b.dropped++;
    if (b.dropped > this.limits.maxDroppedFrames) ws.close(CLOSE.RATE_LIMITED, "too many frames");
    else this.error(ws, "rate_limited", "slow down");
    return false;
  }

  /** A fixed-window counter per account. */
  private rate(key: string, limit: number, windowMs: number): boolean {
    const now = this.host.now();
    const r = one(this.sql.all<{ window_start: number; n: number }>(`SELECT window_start, n FROM rate WHERE k = ?`, key));
    if (!r || now - r.window_start >= windowMs) {
      this.sql.run(`INSERT INTO rate (k, window_start, n) VALUES (?, ?, 1) ON CONFLICT (k) DO UPDATE SET window_start = excluded.window_start, n = 1`, key, now);
      return true;
    }
    if (r.n >= limit) return false;
    this.sql.run(`UPDATE rate SET n = n + 1 WHERE k = ?`, key);
    return true;
  }

  private send(ws: RelaySocket, f: ServerFrame): void {
    ws.send(JSON.stringify(f));
  }

  private error(ws: RelaySocket, code: RelayErrorCode, message: string, ref?: string): void {
    this.send(ws, { type: "error", code, message, ...(ref ? { ref } : {}) });
  }
}

function parseJson(body: Uint8Array): unknown {
  return parseJsonText(new TextDecoder().decode(body));
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What an error frame refers to: the session or message it was about. */
function refOf(f: ClientFrame): string | undefined {
  switch (f.type) {
    case "live":
    case "live_close":
    case "rendezvous":
    case "rendezvous_close":
      return f.session;
    case "sealed":
      return f.envelope.header.msg_id;
    case "ack":
      return f.id;
    case "pair_open":
    case "pair_close":
      return f.offer;
    case "link_remove":
      return f.device_id;
    default:
      return undefined;
  }
}
