# `@homerun/protocol`

The relay protocol of [`docs/design.md` §9.4–§9.7](../../docs/design.md#94-relay-design) and
[§10.5](../../docs/design.md#105-device-linking), as code and as plain-JSON test vectors. It is the
first half of milestone 9 ([§16](../../docs/design.md#16-build-plan)). The runtime (`homerund`),
the relay (`apps/relay`) and the reference client (`packages/remote`) all build on it, and so will
the M10 web and React Native clients. The iOS app's Notification Service Extension opens sealed
pushes in Swift on CryptoKit; it and the React Native app must pass the same vector files.

```ts
import { LiveInitiator, liveRespond, seal, openSealed, verifyAllVectors } from "@homerun/protocol";
```

The package exports TypeScript source (`./src/index.ts`) with no build step, like `@homerun/core`.

## Cryptography

Everything is built on the audited, dependency-free `@noble/*` libraries (Cure53 and Kudelski
audits). They are pure JavaScript, so the same code runs in Bun, Cloudflare Workers, browsers and
React Native with no WASM or native module. Nothing below a primitive is written here: the package
composes X25519, ChaCha20-Poly1305, SHA-256, HMAC/HKDF and Ed25519 from `@noble` into the
[Noise framework](https://noiseprotocol.org/noise.html) (revision 34). The Noise state machine in
`src/noise.ts` is checked byte for byte against the vendored
[cacophony](https://github.com/haskell-cryptography/cacophony) vectors.

| Use | Noise pattern | Suite |
| --- | --- | --- |
| Live session, phone or web ↔ desktop (§9.4) | `KK` | `Noise_KK_25519_ChaChaPoly_SHA256` |
| Sealed message: queued instruction, push, lock-screen answer (§9.4, §9.7) | `K` (one-way) | `Noise_K_25519_ChaChaPoly_SHA256` |
| QR pairing (§9.6) | `IKpsk1`, psk from the QR code | `Noise_IKpsk1_25519_ChaChaPoly_SHA256` |
| Remote linking with a matching code (§10.5) | `XX` plus commit/reveal nonces | `Noise_XX_25519_ChaChaPoly_SHA256` |

The suite is ChaChaPoly, not libsodium's XChaCha20-Poly1305: Noise fixes a 64-bit counter nonce, so
the extended nonce buys nothing, and ChaChaPoly/SHA-256 is what CryptoKit offers natively
(§18 row 71).

## Layout

```
src/
  bytes.ts        hex, base64url (strict, unpadded), utf8, concat, framed() (u16-length-prefixed parts)
  crypto.ts       the primitives, wrapped: X25519 (all-zero output rejected), ChaCha20-Poly1305, SHA-256, HKDF, Ed25519
  noise.ts        HandshakeState / CipherState for K, KK, XX and IKpsk1
  identity.ts     a device's X25519 and Ed25519 keys; generate, store, public view (§12, §9.6 step 1)
  frames.ts       fragmenting a message across Noise transport messages (flag byte: 0 last, 1 more)
  live.ts         live sessions (KK), JSON-RPC messages in, relay frames out
  sealed.ts       sealed envelopes (K) and openSealed(): every check of §9.4 in one place
  statement.ts    the desktop-signed link statement the relay routes by
  pairing.ts      the QR URL, psk and offer tag, and the IKpsk1 exchange
  linking.ts      the XX exchange with a commit/reveal six-digit code (§10.5)
  apns.ts         the APNs payload: the sealed envelope, or the generic alert when it doesn't fit 4 KB
  wire.ts         relay HTTP bodies, WebSocket frames, close codes, device proofs
  oidc.ts         Authorization Code + PKCE, refresh and revocation over oauth4webapi (§10.4)
  vectors/        builders, the verifier and fixtures for the vector files
scripts/
  gen-vectors.ts  writes vectors/*.json; --check fails on drift (CI runs it)
vectors/          the test vectors (below)
```

## Sealed-message checks

`openSealed()` returns `{ ok: true, header, inner }` or `{ ok: false, reason }`. It checks, in
order: the envelope's shape and version; its size (512 KiB); that it is addressed to us; that the
sender is paired with us; the Noise `K` handshake against the sender's pinned key, with the header
as the prologue so it is authenticated; that the header and the inner message agree (sender, id,
kind, expiry); expiry with the 5-minute skew allowance; that the lifetime isn't longer than the kind
allows (instruction 72 h, push 24 h, answer 1 h); and the caller's seen-set. The caller records the
`msg_id` as seen in the same transaction as the message's effect.

## Test vectors

`vectors/` holds plain JSON so every client can use it: the TypeScript clients here, and in M10
the React Native app and the Swift notification extension. Test keys only; they are published on purpose.

| File | What it pins |
| --- | --- |
| `noise-cacophony.json` | Vendored cacophony entries for the four patterns: our Noise matches the reference |
| `sealed.json` | Byte-exact sealing (fixed ephemerals), then 25 open cases: the successes and every reject reason (tampering, wrong key, wrong recipient, unpaired sender, expired, from the future, too long a lifetime, replayed, lying sender, truncated) |
| `live.json` | A full KK transcript with fragmented messages in both directions, and rejected first messages |
| `pairing.json` | The QR URL, psk, offer tag and IKpsk1 transcript; a first message made with the wrong code; invalid URLs |
| `linking.json` | The XX + commit/reveal transcript, the commitment, the six-digit codes, and a reveal that doesn't match |
| `link-statement.json` | Canonical statement bytes and signatures; statements that must not verify |
| `apns-payload.json` | The APNs body for a sealed push, and the generic fallback when it doesn't fit |
| `relay-wire.json` | Device-proof bytes and signatures; client and server frames that must parse or be rejected |
| `encoding.json` | base64url and `framed()` edge cases |

Every file has a `$comment` and a `devices` block with the keys (secrets in hex, public keys in
base64url). Fields ending in `_ephemeral` or `_nonce` are the fixed randomness a vector needs;
hex is used for secrets and raw bytes, base64url for anything that goes on the wire.

To check an implementation, reproduce each byte-exact output from the inputs in the file, and for
each negative case, reject it. `src/vectors/verify.ts` is the reference checker: it uses only what
the files contain, and `verifyAllVectors()` runs in any JavaScript runtime (the relay runs it
inside workerd). Regenerate with `pnpm --filter @homerun/protocol vectors` after a deliberate
protocol change; CI runs `vectors:check`, so a drift fails the build.

### For the Swift notification extension (M10)

CryptoKit has everything: `Curve25519.KeyAgreement` (X25519), `ChaChaPoly` (note that CryptoKit's
nonce is the 12-byte Noise nonce: four zero bytes then the little-endian counter), `SHA256`,
`HMAC<SHA256>` for Noise's HKDF, `HKDF<SHA256>` for the pairing psk, and `Curve25519.Signing`
(Ed25519). Ed25519 signatures here are deterministic (RFC 8032), so a Swift signer that randomises
signatures verifies the vectors but won't reproduce them; compare by verifying, not by bytes.
