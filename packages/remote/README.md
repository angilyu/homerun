# `@homerun/remote`

The reference remote client for milestone 9 ([`docs/design.md` §9 and §10](../../docs/design.md#9-remote-access--reaching-the-desktop-from-anywhere)).
It has no UI and is platform-neutral: it uses only `fetch`, `WebSocket` and crypto randomness.
It plays the phone and the browser in the relay's end-to-end tests. Milestone 10's web and iOS
clients build on it: they supply a browser for sign-in, a `RemoteStore`, and the UI.

- **`Account`** signs in with OIDC Authorization Code + PKCE (§10.4) through a `browser` the app
  supplies. It refreshes access tokens one at a time before they expire, and passes each rotated
  refresh token to `onRefreshToken` to persist. `signOut()` revokes the refresh token.
- **`RelayConnection`** is one device's link to the relay:
  - HTTPS calls signed with the device key (`homerun-device`).
  - A WebSocket that answers the relay's challenge and re-authenticates before the token expires.
  - Reconnects with jittered backoff. It gives up only when the device is removed (4410),
    replaced (4409) or refused (4403).
  - Doesn't offer permessage-deflate: frames are mostly ciphertext, a reauth frame's token
    shouldn't share a compression context, and Bun's client fails some of workerd's compressed
    frames. `homerund` uses this same class for the desktop's link.
- **`RemoteClient`** does what the app does:
  - `register()` and `connect()`.
  - `pair(qrUrl)` pairs by QR code with Noise IKpsk1 (§9.6).
  - `linkByCode(desktopId, onCode)` links by matching code with Noise XX and commit/reveal (§10.5).
  - Every link statement is checked against the keys learned inside Noise before the desktop is
    pinned.
  - `openLive(desktopId)` opens a live session: Noise KK, then JSON-RPC (§9.3).
  - `sendInstruction()` sends sealed instructions for an offline desktop (§9.4). They go over the
    socket, or by HTTPS when not connected. `waitDelivered(msgId)` resolves once the desktop has
    taken it, even if that receipt came first.
  - `openPush()` opens a push as the iOS Notification Service Extension would, or falls back to the
    generic text (§9.7).
  - `answerFromLockScreen()` answers by HTTPS POST. It works only for a push that offers actions.
  - `unpair()` and `deleteAccount()`.
  - Sealed messages from the relay's queue are opened, checked against the seen-set and acked.
- **`MemoryStore`** holds the device keys, pinned desktops and the seen-set. Real clients keep
  these in the Keychain or IndexedDB.

The desktop decides what a remote may do (§5.2, §13). A refused call comes back as an ordinary
JSON-RPC error on the live session. It can also be a sealed answer the desktop drops, such as a
destructive approval sent from a lock screen.

## Tests

`bun test` runs the client against the relay's Bun adapter (`@homerun/relay/local`), the
testkit's OIDC issuer and APNs mock, and a scripted desktop
([`test/fake-desktop.ts`](test/fake-desktop.ts)) built on the protocol's responder APIs. The
scripted desktop keeps these tests fast and independent of the runtime. The same client
against the real runtime is `homerund`'s remote suite
([`apps/homerund/test/remote`](../../apps/homerund/test/remote)), which CI runs as
`remote-e2e`.

The tests cover:

- **Sign-in:** PKCE sign-in, and refresh after revocation.
- **Connection:** both WebSocket auth forms, reconnect after a relay restart, and re-authenticating
  before token expiry.
- **Pairing and linking:** QR pairing, a wrong code, and code linking, both matched and declined.
- **Live sessions:** JSON-RPC with fragmented replies, errors and notifications, and an offline
  desktop.
- **Sealed messages and push:**
  - Instructions to an online desktop and to an offline one.
  - Push to APNs and back, a lock-screen answer applied once and a replay refused, the generic
    fallback through the queue, and web clients refused pushes.
- **Unpairing and account deletion:** unpairing from either side, keeping a second desktop, and
  deleting the account.
