import { fromB64url, fromHex, framed, toB64url, toHex, utf8 } from "../bytes";
import { x25519Key } from "../crypto";
import { buildApnsPayload } from "../apns";
import { LinkInitiator, LinkResponder, sasCommit, sasCode } from "../linking";
import { LiveInitiator, livePrologue, liveRespond } from "../live";
import { decodePairingUrl, encodePairingUrl, offerTag, pairingPsk, PairInitiator, PairResponder } from "../pairing";
import { openSealed, seal, sealRaw } from "../sealed";
import { linkStatementBytes, signLinkStatement, verifyLinkStatement } from "../statement";
import { ClientFrame, challengeBytes, requestBytes, ServerFrame, signChallenge, signRequest, verifySignature } from "../wire";
import { attestationClientDataHash, IOS_APP_ID, verifyAssertion, verifyAttestation } from "../app-attest";
import { identityOf, type VectorDeviceKeys } from "./fixtures";
import { type CacophonyVector, verifyCacophony } from "./cacophony";

/**
 * Checks this implementation against the vector files using only what the files contain (keys,
 * ephemerals, nonces, clocks), so the same files can check another implementation. Every case
 * yields a result; nothing throws.
 */

export interface CaseResult {
  file: string;
  name: string;
  ok: boolean;
  error?: string;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const idOf = (k: VectorDeviceKeys) => identityOf(k, fromHex);
const eph = (hex: string) => x25519Key(fromHex(hex));

async function run(file: string, name: string, f: () => Promise<void | string> | void | string): Promise<CaseResult> {
  try {
    const err = await f();
    return err ? { file, name, ok: false, error: err } : { file, name, ok: true };
  } catch (e) {
    return { file, name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function expectThrow(f: () => unknown): Promise<string | undefined> {
  try {
    await f();
  } catch {
    return undefined;
  }
  return "expected a failure";
}

export async function verifySealedVectors(v: Json): Promise<CaseResult[]> {
  const F = "sealed.json";
  const out: CaseResult[] = [];
  const devices = v.devices as Record<string, VectorDeviceKeys>;
  const byId = new Map(Object.values(devices).map((d) => [d.device_id, d]));
  for (const c of v.seal as Json[]) {
    out.push(
      await run(F, `seal: ${c.name}`, async () => {
        const sender = idOf(devices[c.sender]!);
        const common = { sender: sender.noise, recipientStatic: fromB64url(c.recipient_static), e: eph(c.ephemeral_secret) };
        const env = c.inner
          ? await seal({ ...common, inner: c.inner, to: c.to_device_id, maxChunk: c.max_chunk ?? undefined })
          : await sealRaw({ ...common, header: c.header, plaintext: utf8(c.plaintext) });
        return eq(env, c.envelope) ? undefined : "envelope differs";
      }),
    );
  }
  for (const c of v.open as Json[]) {
    out.push(
      await run(F, `open: ${c.name}`, async () => {
        const me = idOf(devices[c.recipient]!);
        const r = await openSealed(c.envelope, {
          me,
          senderStatic: (d) => (c.pinned[d] ? fromB64url(c.pinned[d]) : null),
          now: c.now,
          seen: (m) => (c.seen as string[]).includes(m),
        });
        const got = r.ok ? { ok: true, inner: r.inner } : { ok: false, reason: r.reason };
        return eq(got, c.expect) ? undefined : `expected ${JSON.stringify(c.expect).slice(0, 80)}, got ${JSON.stringify(got).slice(0, 80)}`;
      }),
    );
  }
  void byId;
  return out;
}

export async function verifyLiveVectors(v: Json): Promise<CaseResult[]> {
  const F = "live.json";
  const out: CaseResult[] = [];
  const phone = idOf(v.devices.initiator);
  const desktop = idOf(v.devices.responder);
  const common = { initiatorId: phone.deviceId, responderId: desktop.deviceId, sessionId: v.session_id, maxChunk: v.max_chunk };
  out.push(await run(F, "prologue", async () => (toHex(livePrologue(phone.deviceId, desktop.deviceId, v.session_id)) === v.prologue ? undefined : "prologue differs")));
  out.push(
    await run(F, "transcript", async () => {
      const init = new LiveInitiator({ ...common, me: phone.noise, peer: desktop.noise.publicKey, e: eph(v.initiator_ephemeral) });
      const m1 = await init.start();
      if (toB64url(m1) !== v.messages[0].data) return "message 1 differs";
      const { reply, session: d } = await liveRespond({ ...common, me: desktop.noise, peer: phone.noise.publicKey, e: eph(v.responder_ephemeral) }, fromB64url(v.messages[0].data));
      if (toB64url(reply) !== v.messages[1].data) return "message 2 differs";
      const p = await init.finish(reply);
      if (toHex(p.handshakeHash) !== v.handshake_hash || toHex(d.handshakeHash) !== v.handshake_hash) return "handshake hash differs";
      for (const [i, m] of (v.messages as Json[]).slice(2).entries()) {
        const [tx, rx] = m.from === "initiator" ? [p, d] : [d, p];
        const frames = tx.encrypt(JSON.parse(m.plaintext)).map(toB64url);
        if (!eq(frames, m.frames)) return `message ${i + 3}: frames differ`;
        let got = null;
        for (const f of m.frames as string[]) got = rx.decrypt(fromB64url(f));
        if (!eq(got, JSON.parse(m.plaintext))) return `message ${i + 3}: plaintext differs`;
      }
    }),
  );
  for (const r of v.reject as Json[]) {
    out.push(
      await run(F, `reject: ${r.name}`, async () =>
        expectThrow(() => liveRespond({ ...common, me: desktop.noise, peer: phone.noise.publicKey }, fromB64url(r.data))),
      ),
    );
  }
  return out;
}

export async function verifyStatementVectors(v: Json): Promise<CaseResult[]> {
  const F = "link-statement.json";
  const out: CaseResult[] = [];
  const desktop = idOf(v.devices.desktop);
  for (const c of v.sign as Json[]) {
    out.push(
      await run(F, `sign: ${c.name}`, async () => {
        if (toHex(linkStatementBytes(c.body)) !== c.bytes) return "bytes differ";
        return eq(await signLinkStatement(c.body, desktop.signing), c.statement) ? undefined : "signature differs";
      }),
    );
  }
  for (const c of v.verify as Json[]) {
    out.push(await run(F, `verify: ${c.name}`, async () => ((verifyLinkStatement(c.statement, c.signer) !== null) === c.valid ? undefined : `expected valid=${c.valid}`)));
  }
  return out;
}

export async function verifyPairingVectors(v: Json): Promise<CaseResult[]> {
  const F = "pairing.json";
  const out: CaseResult[] = [];
  const phone = idOf(v.devices.phone);
  const desktop = idOf(v.devices.desktop);
  out.push(await run(F, "url", async () => (encodePairingUrl(v.qr) === v.url && eq(decodePairingUrl(v.url), v.qr) ? undefined : "url differs")));
  out.push(await run(F, "psk", async () => (toHex(pairingPsk(v.qr.pairing_code, desktop.deviceId)) === v.psk ? undefined : "psk differs")));
  out.push(await run(F, "offer tag", async () => (offerTag(v.qr.pairing_code) === v.offer_tag ? undefined : "offer tag differs")));
  out.push(
    await run(F, "transcript", async () => {
      const init = new PairInitiator({ qr: v.qr, me: phone.noise, hello: v.hello, sessionId: v.session_id, e: eph(v.initiator_ephemeral) });
      const m1 = await init.start();
      if (toB64url(m1) !== v.message1) return "message 1 differs";
      const resp = new PairResponder({ desktopId: desktop.deviceId, deviceId: phone.deviceId, sessionId: v.session_id, code: v.qr.pairing_code, me: desktop.noise, e: eph(v.responder_ephemeral) });
      const { hello, remoteStatic } = await resp.read(m1);
      if (!eq(hello, v.hello) || toB64url(remoteStatic) !== v.devices.phone.x25519_public) return "hello differs";
      const m2 = await resp.reply(v.welcome);
      if (toB64url(m2) !== v.message2) return "message 2 differs";
      return eq(await init.finish(m2), v.welcome) ? undefined : "welcome differs";
    }),
  );
  for (const r of v.reject_message1 as Json[]) {
    out.push(
      await run(F, `reject: ${r.name}`, async () =>
        expectThrow(() =>
          new PairResponder({ desktopId: desktop.deviceId, deviceId: phone.deviceId, sessionId: v.session_id, code: v.qr.pairing_code, me: desktop.noise }).read(fromB64url(r.data)),
        ),
      ),
    );
  }
  for (const [i, u] of (v.urls as Json[]).entries()) {
    out.push(await run(F, `url ${i}`, async () => ((decodePairingUrl(u.url) !== null) === u.valid ? undefined : `expected valid=${u.valid}`)));
  }
  return out;
}

export async function verifyLinkingVectors(v: Json): Promise<CaseResult[]> {
  const F = "linking.json";
  const out: CaseResult[] = [];
  const phone = idOf(v.devices.phone);
  const desktop = idOf(v.devices.desktop);
  out.push(await run(F, "commit", async () => (toB64url(sasCommit(fromHex(v.phone_nonce))) === v.commit ? undefined : "commit differs")));
  for (const [i, c] of (v.codes as Json[]).entries()) {
    out.push(await run(F, `code ${i}`, async () => (sasCode(fromHex(c.handshake_hash), fromHex(c.phone_nonce), fromHex(c.desktop_nonce)) === c.code ? undefined : "code differs")));
  }
  out.push(
    await run(F, "transcript", async () => {
      const m = (v.messages as string[]).map(fromB64url);
      const p = new LinkInitiator({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: v.session_id, me: phone.noise, info: v.phone_info, e: eph(v.initiator_ephemeral), nonce: fromHex(v.phone_nonce) });
      const d = new LinkResponder({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: v.session_id, me: desktop.noise, info: v.desktop_info, e: eph(v.responder_ephemeral), nonce: fromHex(v.desktop_nonce) });
      const steps: [string, () => Uint8Array | Promise<Uint8Array>][] = [
        ["xx 1", () => p.start()],
        ["xx 2", () => d.accept(m[0]!)],
        ["xx 3", () => p.answer(m[1]!)],
        ["nonce", () => d.commit(m[2]!)],
        ["reveal", () => p.reveal(m[3]!)],
      ];
      for (const [i, [label, f]] of steps.entries()) if (toB64url(await f()) !== v.messages[i]) return `${label} differs`;
      if (d.verify(m[4]!) !== v.code || p.code !== v.code) return "code differs";
      if (toB64url(d.linked(v.statement)) !== v.messages[5]) return "linked message differs";
      const r = p.result(m[5]!);
      return "linked" in r && eq(r.linked, v.statement) ? undefined : "result differs";
    }),
  );
  out.push(
    await run(F, "reject: reveal that doesn't match the commitment", async () => {
      const m = (v.messages as string[]).map(fromB64url);
      const d = new LinkResponder({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: v.session_id, me: desktop.noise, info: v.desktop_info, e: eph(v.responder_ephemeral), nonce: fromHex(v.desktop_nonce) });
      await d.accept(m[0]!);
      await d.commit(m[2]!);
      // A reveal of a different nonce, sealed in the right session by a fresh initiator run.
      const p = new LinkInitiator({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: v.session_id, me: phone.noise, info: v.phone_info, e: eph(v.initiator_ephemeral), nonce: fromHex(v.desktop_nonce) });
      await p.start();
      await p.answer(m[1]!);
      return expectThrow(() => d.verify(p.reveal(m[3]!)));
    }),
  );
  return out;
}

export async function verifyApnsVectors(v: Json): Promise<CaseResult[]> {
  const F = "apns-payload.json";
  return Promise.all(
    (v.cases as Json[]).map((c) =>
    run(F, c.name, async () => {
      const r = buildApnsPayload(c.envelope, v.max_bytes);
      if (utf8(r.body).length > v.max_bytes) return "payload too big";
      return r.body === c.body && r.sealed === c.sealed && r.expiration === c.expiration ? undefined : "payload differs";
    }),
    ),
  );
}

export async function verifyWireVectors(v: Json): Promise<CaseResult[]> {
  const F = "relay-wire.json";
  const out: CaseResult[] = [];
  const phone = idOf(v.devices.phone);
  out.push(
    await run(F, "challenge", async () => {
      const c = v.challenge;
      if (toHex(challengeBytes(c.nonce, c.device_id)) !== c.bytes) return "bytes differ";
      if ((await signChallenge(phone.signing, c.nonce, c.device_id)) !== c.signature) return "signature differs";
      return verifySignature(c.signature, fromHex(c.bytes), v.devices.phone.ed25519_public) ? undefined : "does not verify";
    }),
  );
  out.push(
    await run(F, "request", async () => {
      const r = v.request;
      if (toHex(requestBytes(r.device_id, r.ts, r.method, r.path, utf8(r.body))) !== r.bytes) return "bytes differ";
      return (await signRequest(phone.signing, r.device_id, r.ts, r.method, r.path, utf8(r.body))) === r.header ? undefined : "header differs";
    }),
  );
  for (const [i, c] of (v.client_frames as Json[]).entries()) {
    out.push(await run(F, `client frame ${i}`, async () => (ClientFrame.safeParse(c.frame).success === c.valid ? undefined : `expected valid=${c.valid}`)));
  }
  for (const [i, c] of (v.server_frames as Json[]).entries()) {
    out.push(await run(F, `server frame ${i}`, async () => (ServerFrame.safeParse(c.frame).success === c.valid ? undefined : `expected valid=${c.valid}`)));
  }
  return out;
}

export async function verifyEncodingVectors(v: Json): Promise<CaseResult[]> {
  const F = "encoding.json";
  const out: CaseResult[] = [];
  for (const c of v.base64url as Json[]) {
    out.push(
      await run(F, `base64url ${JSON.stringify(c.b64url)}`, async () => {
        if (c.hex === null) return expectThrow(() => fromB64url(c.b64url));
        if (toHex(fromB64url(c.b64url)) !== c.hex) return "decode differs";
        return toB64url(fromHex(c.hex)) === c.b64url ? undefined : "encode differs";
      }),
    );
  }
  for (const c of v.framed as Json[]) out.push(await run(F, "framed", async () => (toHex(framed(...(c.parts as string[]))) === c.hex ? undefined : "differs")));
  return out;
}

export async function verifyAppAttestVectors(v: Json): Promise<CaseResult[]> {
  const F = "app-attest.json";
  const out: CaseResult[] = [];
  for (const c of v.client_data_hash as Json[]) {
    out.push(await run(F, `client data hash: ${c.name}`, () => (toHex(attestationClientDataHash(c.identity, c.approval_key ?? undefined)) === c.hex ? undefined : "differs")));
  }
  const roots = [fromB64url(v.root)];
  for (const c of v.attestation as Json[]) {
    out.push(
      await run(F, `attestation: ${c.name}`, () => {
        const r = verifyAttestation(c.attestation, c.identity, { appId: v.app_id, allowDevelopment: c.allow_development, roots }, v.now);
        if (r.ok !== c.valid) return `expected valid=${c.valid}${r.ok ? "" : ` (${r.reason})`}`;
        if (r.ok && toB64url(r.credentialPublicKey) !== c.credential_public_key) return "credential key differs";
      }),
    );
  }
  for (const c of v.assertion as Json[]) {
    out.push(
      await run(F, `assertion: ${c.name}`, () => {
        const r = verifyAssertion(fromB64url(c.assertion), fromHex(c.client_data_hash), fromB64url(c.credential_public_key), c.last_counter, { appId: v.app_id ?? IOS_APP_ID });
        if (r.ok !== c.valid) return `expected valid=${c.valid}`;
        if (r.ok && r.counter !== c.counter) return "counter differs";
      }),
    );
  }
  return out;
}

export async function verifyCacophonyVectors(v: Json): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of v.vectors as CacophonyVector[]) {
    const r = await verifyCacophony(c);
    out.push({ file: "noise-cacophony.json", name: c.protocol_name, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  return out;
}

export const VERIFIERS: Record<string, (v: Json) => Promise<CaseResult[]>> = {
  "noise-cacophony.json": verifyCacophonyVectors,
  "sealed.json": verifySealedVectors,
  "live.json": verifyLiveVectors,
  "pairing.json": verifyPairingVectors,
  "linking.json": verifyLinkingVectors,
  "link-statement.json": verifyStatementVectors,
  "apns-payload.json": verifyApnsVectors,
  "relay-wire.json": verifyWireVectors,
  "encoding.json": verifyEncodingVectors,
  "app-attest.json": verifyAppAttestVectors,
};

/** Runs every verifier over the given files (name → parsed JSON). Missing files fail. */
export async function verifyAllVectors(files: Record<string, unknown>): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const [name, verify] of Object.entries(VERIFIERS)) {
    const v = files[name];
    if (v === undefined) out.push({ file: name, name: "(file)", ok: false, error: "missing" });
    else out.push(...(await verify(v)));
  }
  return out;
}
