# @homerun/relay

The relay lets a phone or browser reach the desktop from anywhere ([design §9.4](../../docs/design.md#94-relay-design)). It routes ciphertext between one account's devices, queues sealed messages for devices that are offline, and sends pushes through APNs. It never sees what a message says: live sessions and sealed messages are end-to-end encrypted by [`@homerun/protocol`](../../packages/protocol/README.md).

It runs on Cloudflare Workers with one Durable Object per account ([§18 rows 74–75](../../docs/design.md#18-decision-log)). **Milestone 9 builds and tests it locally only; nothing is deployed.** Deploying is the manual step [below](#deploying).

## Shape

- **`src/worker.ts`**: the Worker verifies the access token at the edge, as a JWT checked against the provider's JWKS. The keys are fetched once and cached, so no request calls the provider (`src/auth.ts`). It then forwards the request to the account's Durable Object (`idFromName(sub)`), which accepts WebSockets through the hibernation API.
- **`src/core/account.ts`**: all of the relay's logic, runtime-neutral: registration and device proofs, links, presence, live-session routing, the sealed-message queue, pairing offers and linking rendezvous, push and rate limits. It sees storage only through a small SQL interface (`src/core/sql.ts`).
- **`src/local.ts`**: a Bun adapter that runs the same core on `bun:sqlite` and `Bun.serve`. The tests and `bun run dev` use it, and so does the reference client's end-to-end suite.
- **`src/apns.ts`**: APNs over HTTP/2 with a token-based (`.p8`, ES256) provider JWT, using only `fetch` and WebCrypto.

### What it stores

Each account's Durable Object has its own SQLite tables ([§10.7](../../docs/design.md#107-what-the-server-stores)):

| Table | Holds |
|---|---|
| `meta` | The provider's subject (`sub`). No email: the provider has it |
| `devices` | Id, kind (`desktop`, `ios`, `web`), name, X25519 and Ed25519 public keys, created and last seen |
| `links` | Which remote device may reach which desktop, with the statement the desktop signed |
| `push_tokens` | APNs token and environment per iOS device |
| `queue` | Sealed envelopes waiting for an offline device, until they expire |
| `pushed`, `offers`, `rendezvous`, `rate` | Push dedupe ids, open QR offers, linking sessions and rate counters, all short-lived |

`DELETE /v1/account` drops all of it.

### Endpoints

Every request carries the provider's access token (`Authorization: Bearer`). Every request except registration also carries a device proof: a `homerun-device` header signing the method, path, body and time with the device's Ed25519 key.

| Endpoint | Does |
|---|---|
| `GET /v1/health` | Liveness; no token |
| `POST /v1/devices` | Registers this device's public keys |
| `GET /v1/devices` | The account's other devices, with presence and last seen |
| `GET /v1/connect` | The WebSocket. The token travels in the subprotocol and the device signs a challenge. Live-session frames, sealed messages, pairing and linking run over it |
| `POST /v1/sealed` | Sends a sealed message without a socket: how a lock-screen answer arrives |
| `POST` / `DELETE /v1/push-token` | Sets or removes an iOS device's APNs token |
| `DELETE /v1/account` | Deletes the account's devices, links, tokens and queue, then its user at the identity provider (202, `AccountDeleted`) |

The frames and bodies are defined in `packages/protocol/src/wire.ts`, and `vectors/relay-wire.json` pins them.

### iPhones and App Attest

A device that registers as `ios` must send an App Attest attestation of its keys ([§9.8](../../docs/design.md#98-the-ios-app-a-full-conversational-client), [§18 row 99](../../docs/design.md#18-decision-log)). The relay checks it against Apple's App Attest root and the app id `NMJBY8WL8T.com.angilyu.homerun.ios`. One that is missing or doesn't verify registers as `web`: no push token and no lock-screen answers. The role is settled at the first registration and kept when the device registers again. The desktop checks the same attestation itself before it gives the device an iPhone's authority, so this check only decides what the relay does (push), never what the desktop allows ([§13](../../docs/design.md#13-security-model)).

Production accepts only `appattest` (App Store and TestFlight builds). `APP_ATTEST_ALLOW_DEVELOP=1` also accepts `appattestdevelop`, from builds signed for development. Set it on a relay used with Xcode builds, together with a development desktop, which accepts them too. A production relay and a development desktop disagree about such a phone, and pairing it fails. `APP_ATTEST_TEST_ROOT` (DER, base64url) replaces Apple's root, for the workerd tests only.

### Deleting an account

`DELETE /v1/account` deletes everything the relay holds for the account, then the user at the identity provider, because the App Store requires that deleting an account in the app deletes it outright ([§10.9](../../docs/design.md#109-obligations-that-come-with-accounts), [§18 row 103](../../docs/design.md#18-decision-log)). `PROVIDER_ADMIN` says how:

- `workos`: `DELETE /user_management/users/{sub}` with the `WORKOS_API_KEY` secret. A 2xx or 404 means the user is gone. Anything else is tried again by the alarm, after a minute and then doubling up to every 6 hours, and the answer says `pending`. Until it succeeds, the account's tokens are refused, so nobody signs back into an account that is half deleted.
- `none` (the default when unset): the answer says `manual`, and the app tells the user to delete their sign-in in the provider's settings.

Another provider is another `ProviderAdmin` in `src/core/provider-admin.ts`. Afterwards the relay keeps a tombstone for 24 hours: the account id, when it was deleted, and whether the provider is done. Tokens issued before the deletion are refused meanwhile, so a device that missed it can't register into the empty account; one that connects is closed with 4410 (removed) and forgets the account. Then the tombstone goes too.

### Web pages

Only the web client's own pages may call the relay from a browser ([§9.9](../../docs/design.md#99-the-web-client), [§18 row 105](../../docs/design.md#18-decision-log)). `WEB_ORIGINS` lists their origins, comma-separated and exact: `https`, no path, no wildcard (`http` only on loopback, for a dev server). A request whose `Origin` isn't listed is refused with `403 forbidden` before its token is looked at, WebSocket upgrades included, and so is `Origin: null` (sandboxed frames, `file:` pages). Listed origins get a preflight answer and `Access-Control-Allow-Origin` echoing them exactly, never `*` and never credentials: the access token is a header, not a cookie. A request with no `Origin`, or with the relay's own, comes from a native client (the desktop, the iPhone app) and passes without CORS headers.

### Limits

From `src/config.ts`; the queue bounds are §9.4's.

| Limit | Default |
|---|---|
| Devices per account | 20 |
| Queue per recipient device | 100 messages or 1 MB, each until it expires |
| Sealed messages per account | 60 a minute |
| Linking rendezvous per account | 10 per 10 minutes |
| Device registrations per account | 30 an hour |
| Frames per connection | 50 a second, bursts of 200; persistent flooding closes the socket (4429) |
| Open QR offers per desktop | 3 |

Close codes: 4401 token expired, 4403 bad device proof, 4409 replaced by a newer connection, 4410 device removed, 4429 rate limited.

## Development

```sh
pnpm --filter @homerun/relay typecheck
pnpm --filter @homerun/relay test            # the core on Bun, with a fake clock
pnpm --filter @homerun/relay test:workerd    # the real Worker in workerd; needs Node 22+
```

Both suites run the same black-box scenarios (`test/scenarios.ts`) against a local OIDC issuer and a mock APNs from [`@homerun/testkit`](../../packages/testkit). The workerd suite also runs every protocol vector inside a Worker. Wrangler's local runtime hangs under Bun, so `scripts/workerd-host.mjs` starts it from Node ([§18 row 79](../../docs/design.md#18-decision-log)).

To run a relay on your machine:

```sh
OIDC_ISSUER=https://issuer.example OIDC_CLIENT_ID=client_... bun run dev   # port 8787
```

It also reads `OIDC_AUDIENCE`, `RELAY_PORT`, `RELAY_DATA_DIR`, `APP_ATTEST_ALLOW_DEVELOP`, `PROVIDER_ADMIN`, `WORKOS_API_KEY` and `WEB_ORIGINS` (add `http://127.0.0.1:5173` for the web client's dev server). Push is off unless `APNS_KEY_P8_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_TOPIC` are all set.

## Deploying

These are manual steps for when the accounts exist. None of them is needed to build or test milestone 9. Never commit a key: `scripts/check-no-secrets.sh` rejects `.p8`, `.pem` and `.dev.vars` files and PEM private keys.

### 1. WorkOS (identity)

1. Create a WorkOS account and a project, and enable **AuthKit** with the sign-in methods you want (email, Google, Sign in with Apple; [§10.4](../../docs/design.md#104-sign-in-flows)).
2. Add the desktop's redirect URI, `http://127.0.0.1/callback`. The desktop listens on a random loopback port (RFC 8252), so check that WorkOS accepts any port on a loopback redirect. If it requires one, register a fixed port and tell the desktop.
3. Note the **client id** and the **issuer URL** (AuthKit's domain, whose `/.well-known/openid-configuration` must resolve).
4. Look at one access token and note whether it carries an `aud`. If it does, that's `OIDC_AUDIENCE`. If not, the relay checks the `client_id` claim against `OIDC_CLIENT_ID`.

The relay uses only standard OIDC, so another provider is the same three values ([§18 row 76](../../docs/design.md#18-decision-log)).

### 2. Apple (push)

1. In the Apple Developer account, under **Certificates, Identifiers & Profiles → Keys**, create a key with **Apple Push Notifications service** enabled and download the `.p8`. It downloads only once.
2. Note its **Key ID** and your **Team ID**.
3. Keep the `.p8` out of the repository and pass it only to `wrangler secret put`.

The topic is the iOS app's bundle id, `com.angilyu.homerun.ios`. Real delivery to a phone is checked in milestone 10, with the iOS app ([§18 row 78](../../docs/design.md#18-decision-log)).

### 3. Cloudflare (the relay)

1. Create a Cloudflare account. Durable Objects with SQLite storage are on the Workers Free plan; pick Paid for production volume.
2. `pnpm --filter @homerun/relay exec wrangler login`.
3. In `wrangler.jsonc`, fill in `OIDC_ISSUER` and `OIDC_CLIENT_ID` (and `OIDC_AUDIENCE` if the tokens have one), and `WEB_ORIGINS` with the web client's origin once it is deployed. These are configuration, not secrets. Optionally add `"account_id"` and a `routes` entry for a custom domain such as `relay.homerun.app`.
4. Set the push secrets, pasting each value when asked:
   ```sh
   cd apps/relay
   pnpm exec wrangler secret put APNS_KEY_P8     # the whole .p8 file, including its BEGIN and END lines
   pnpm exec wrangler secret put APNS_KEY_ID
   pnpm exec wrangler secret put APNS_TEAM_ID
   pnpm exec wrangler secret put WORKOS_API_KEY  # WorkOS → API Keys: the secret key (sk_...), for account deletion
   ```
5. `pnpm exec wrangler deploy`, then check `https://<your-relay>/v1/health` returns `{"ok":true}`.
6. In the Cloudflare dashboard, add a rate-limiting rule by IP for the relay's hostname. The relay limits each account itself, but a request without a valid token is refused at the Worker before it reaches an account.
7. Build the desktop against it (below).

### 4. The desktop

A release build of the desktop has the relay and the identity provider baked in, and shows remote access as not configured without them. Pass them to the build:

```sh
export HOMERUND_RELAY_URL=https://relay.homerun.app      # your relay, https
export HOMERUND_OIDC_ISSUER=https://<your-authkit-domain>  # exactly as its discovery document says
export HOMERUND_OIDC_CLIENT_ID=client_...
scripts/macos/package.sh                                   # or apps/desktop/scripts/stage-sidecars.ts --release
```

None of them is a secret: the client id is public (a desktop app can't keep a secret, which is why it uses PKCE). Then sign in from **Settings → Remote access** and check the relay shows **Connected**. Pairing a phone needs the iOS app (milestone 10); until then the reference client in [`packages/remote`](../../packages/remote) can play the phone against a real relay.

To try it all on your machine without any account, run a development desktop against a local relay and issuer: `HOMERUN_RELAY_URL`, `HOMERUN_OIDC_ISSUER` and `HOMERUN_OIDC_CLIENT_ID` in its environment (development builds only, plain http on `127.0.0.1` allowed; [`apps/homerund`](../homerund/README.md#remote-access-9-10-milestone-9)).

`APNS_ENDPOINT` is a test-only override that points push at the mock. Don't set it in production; without it the relay uses Apple's production or sandbox host for each token's environment.
