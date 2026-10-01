import { fromHex, toHex } from "../bytes";
import { x25519Key } from "../crypto";
import { HandshakeState, type PatternName, PATTERNS, protocolName, type CipherState } from "../noise";

/** One entry of the cacophony vector format (noise_wiki "Test vectors"). */
export interface CacophonyVector {
  protocol_name: string;
  init_prologue: string;
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  init_psks?: string[];
  resp_prologue: string;
  resp_static?: string;
  resp_ephemeral?: string;
  resp_remote_static?: string;
  resp_psks?: string[];
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

export type VectorResult = { ok: true } | { ok: false; error: string };

/** Replays a cacophony transcript with both sides and compares every byte. */
export async function verifyCacophony(v: CacophonyVector): Promise<VectorResult> {
  const pattern = (Object.keys(PATTERNS) as PatternName[]).find((p) => protocolName(p) === v.protocol_name);
  if (!pattern) return { ok: false, error: `unsupported protocol ${v.protocol_name}` };
  const key = (hex?: string) => (hex ? x25519Key(fromHex(hex)) : undefined);
  const psk = (list?: string[]) => (list && list.length > 0 ? fromHex(list[0]!) : undefined);
  try {
    const init = new HandshakeState({
      pattern,
      initiator: true,
      prologue: fromHex(v.init_prologue),
      s: key(v.init_static),
      e: key(v.init_ephemeral),
      rs: v.init_remote_static ? fromHex(v.init_remote_static) : undefined,
      psk: psk(v.init_psks),
    });
    const resp = new HandshakeState({
      pattern,
      initiator: false,
      prologue: fromHex(v.resp_prologue),
      s: key(v.resp_static),
      e: key(v.resp_ephemeral),
      rs: v.resp_remote_static ? fromHex(v.resp_remote_static) : undefined,
      psk: psk(v.resp_psks),
    });
    const oneWay = PATTERNS[pattern].oneWay;
    let initT: { send: CipherState | null; recv: CipherState | null } | undefined;
    let respT: { send: CipherState | null; recv: CipherState | null } | undefined;
    for (const [i, m] of v.messages.entries()) {
      const fromInit = oneWay || i % 2 === 0;
      const payload = fromHex(m.payload);
      let ct: Uint8Array;
      let pt: Uint8Array;
      if (!init.finished) {
        const [w, r] = fromInit ? [init, resp] : [resp, init];
        ct = await w.writeMessage(payload);
        pt = await r.readMessage(ct);
        if (init.finished && resp.finished) {
          const a = init.split();
          const b = resp.split();
          if (toHex(a.handshakeHash) !== v.handshake_hash || toHex(b.handshakeHash) !== v.handshake_hash) {
            return { ok: false, error: "handshake hash differs" };
          }
          initT = a;
          respT = b;
        }
      } else {
        const [w, r] = fromInit ? [initT!, respT!] : [respT!, initT!];
        ct = w.send!.encryptWithAd(new Uint8Array(0), payload);
        pt = r.recv!.decryptWithAd(new Uint8Array(0), ct);
      }
      if (toHex(ct) !== m.ciphertext) return { ok: false, error: `message ${i}: ciphertext differs` };
      if (toHex(pt) !== m.payload) return { ok: false, error: `message ${i}: payload differs` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
