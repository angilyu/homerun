# `@homerun/web`

The web client of [`docs/design.md` §9.9](../../docs/design.md#99-the-web-client), milestone 10a:
the desktop app's views ([`apps/desktop`](../desktop/README.md)) rendered in a browser over the
relay, with a browser's reduced authority. It runs no agent. It is a remote for a desktop, like
the iPhone app, and doubles as the front door: sign in, download the desktop app, link this
browser. The output is static files for Cloudflare Pages.

## What a browser may do

The runtime enforces all of this, whatever the page does (§9.9, `packages/core`'s caller
allowlists). The views hide the same things so nobody is offered a button that will fail.

- Read history, chat, steer and stop runs, and answer questions.
- Approve only `read`-class calls. Everything else, and *"Did this happen?"*, says
  *Approve on your phone or Mac*. A run the browser started or steered is `web_read_only`
  until it ends.
- Not create, edit or archive tasks, pause schedules, edit monitor state, or create grants.
  Those would act with full authority at a task's next scheduled fire.

## Layout

```
src/
  main.tsx        the entry: createApp({ shell: null, role: "web" }) inside the session
  session.ts      WebSession: sign-in by redirect, this browser's device, linking, unlinking,
                  signing out and account deletion, one tab at a time
  storage.ts      IndexedDB: the device's keys, its pairings, and the sealed refresh token
  ui.tsx          the front door (sign in, link this browser, pick a computer) and the
                  This browser section of Settings
  config.ts       the relay and identity provider, fixed at build time
  device-name.ts  "Chrome on macOS", the name the desktop's link prompt shows
  jitless.ts      Zod without its `new Function` probe (below)
  web.css         the front door's styles, on top of the desktop's stylesheet
scripts/build.ts  the build, the CSP and the other security headers
test/unit/        storage, the session against the real runtime, the build
test/e2e/         Playwright in Chrome against the real runtime, relay and issuer
```

## Sign-in, keys and storage

- **Sign-in** is OpenID Connect Authorization Code with PKCE, `state` and `nonce`, by
  full-page redirect to the provider and back to `/auth/callback` (§10.4). The PKCE verifier
  stays in `sessionStorage` only until the callback. The browser exchanges the code at the
  provider's token endpoint itself, which needs the provider to allow this origin (CORS).
- **This browser is a device** (§12): an X25519 key for Noise and an Ed25519 key for the
  relay, made with WebCrypto as **non-extractable** keys and stored as `CryptoKey` objects in
  IndexedDB (`homerun`, store `keys`). The page can use them, but not read them out. A browser
  without WebCrypto X25519 and Ed25519 is told it can't run Homerun; there is no fallback to
  raw keys.
- **The refresh token** is kept in IndexedDB (store `vault`), encrypted with AES-GCM under a
  non-extractable key in the same database (§18 row 111). That protects a copied profile, not
  a malicious page, which could use the token while it is open. Access tokens stay in memory.
- **Chat history** is never stored. It is fetched again on each visit (§18 row 106).
- **Linking** uses the six-digit code (§10.5): pick a computer, and the page shows the code
  the desktop's native prompt shows. It registers as `web`, so it never gets pushes.
- **One tab at a time** (§18 row 110). A second tab says Homerun is open in another tab, with
  **Use here**.
- **Someone else signing in** deletes this browser's keys and pairings first, and so does
  unlinking its last computer (§18 row 112).

Settings → *This browser* lists the linked computers (open, unlink), signs out, and deletes
the account, which deletes the user at the identity provider too (§10.9, §18 row 103).

## Build

```sh
HOMERUN_RELAY_URL=https://relay.example \
HOMERUN_OIDC_ISSUER=https://auth.example \
HOMERUN_OIDC_CLIENT_ID=client_... \
HOMERUN_OIDC_AUTH_PARAMS='{"provider":"authkit"}' \
pnpm --filter @homerun/web build            # into apps/web/dist
```

The build fetches the issuer's discovery document once, because the CSP names exactly the
origins the page talks to. Every URL must be `https`; `--dev` also allows `http` on
`127.0.0.1`, for the local relay and issuer, and leaves out HSTS. `--out <dir>` writes
somewhere else.

`dist/` is `index.html`, hashed files under `/assets/`, `_redirects` (the callback route) and
`_headers`, which Pages applies to every response.

## Security headers

From `scripts/build.ts` (§18 row 104):

- `Content-Security-Policy`: `default-src 'none'`; scripts, styles, fonts and the manifest
  only from this origin, and no inline script or style; images from this origin and `data:`;
  `connect-src` only this origin, the relay (https and wss) and the provider's token, JWKS and
  revocation origins; `form-action 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`,
  `object-src 'none'`; `require-trusted-types-for 'script'` with `trusted-types 'none'`, so
  no string reaches an HTML or script sink; `upgrade-insecure-requests`.
- `Strict-Transport-Security` (two years, subdomains), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy:
  same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy` that
  denies the camera, microphone, location, sensors, payment and USB.
- `Cache-Control: no-cache` on the page, `no-store` on `/auth/*`, and a year, immutable, on
  the hashed assets.

Zod would otherwise probe `new Function("")` to decide whether to compile its parsers. The
probe always fails under this policy, and each failure is reported as a violation, so
`jitless.ts` turns it off before anything parses. The end-to-end tests fail on any violation.

There is no service worker: nothing outlives a deploy, and nothing else on the origin can see
the page's requests.

## If the host is compromised

A browser loads the page from the host each time, so whoever controls the host, or the Pages
project, could serve different JavaScript (§9.9). The CSP doesn't help against that: the new
page brings its own headers. What bounds it:

- The device keys can be used only while a tab is open, and never exported.
- The page has the web role. Every run it starts or steers is `web_read_only`: anything that
  writes, runs a command or uses the network waits for an approval only the desktop or the
  iPhone app can give. It can't edit tasks, schedules, grants or monitors, and only the
  desktop can relax that policy.
- The desktop lists the browser with when it was last seen; unlinking it there ends its
  access at the relay at once.
- The relay answers browsers only from the origins in its `WEB_ORIGINS` (§18 row 105), so a
  page on any other origin can't call it from a browser at all.

## Deploying

By hand, to Cloudflare Pages, with the `wrangler` the relay already pins. The project name
`homerun-web` gives `https://homerun-web.pages.dev`; a custom domain is only configuration.
These are [manual checks](../desktop/README.md#manual-checks) 33–36.

1. In WorkOS, add the redirect URI `https://homerun-web.pages.dev/auth/callback` and allow the
   origin `https://homerun-web.pages.dev` for the public client (CORS).
2. Build with the production relay and issuer (above).
3. `pnpm --filter @homerun/relay exec wrangler pages project create homerun-web --production-branch main`, once.
4. `pnpm --filter @homerun/relay exec wrangler pages deploy ../web/dist --project-name homerun-web --branch main`.
5. Add `https://homerun-web.pages.dev` to the relay's `WEB_ORIGINS` in `apps/relay/wrangler.jsonc` and
   `wrangler deploy` the relay ([`apps/relay`](../relay/README.md#deploying)).

## Tests

```sh
pnpm --filter @homerun/web typecheck
pnpm --filter @homerun/web test           # storage, the session and the build, about a second
pnpm --filter @homerun/web test:e2e       # Playwright; HOMERUN_E2E_CHANNEL=chrome uses your Chrome
```

The unit tests run the session against the real runtime, the relay's Bun adapter and the local
issuer (`apps/homerund/test/remote/harness.ts`, `startWorld({ webOrigins })`). The end-to-end
server (`test/e2e/server.ts`) builds the page in development mode and serves it with the
`_headers` and `_redirects` Pages would apply, next to the same world; it starts a desktop with
a task and answers its link prompt for the test. The tests sign in by redirect, link by code,
chat, steer and stop, answer a question, see an approval that waits for a phone or Mac, check
that the private and secret keys are non-extractable, reload, unlink, sign out and delete the
account, with no CSP or Trusted Types violation. CI runs them as jobs `web` and `web-e2e`
(§18 row 113).
