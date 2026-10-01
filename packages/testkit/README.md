# `@homerun/testkit`

Test-only servers for milestone 9 ([`docs/design.md` §16](../../docs/design.md#16-build-plan)).
Nothing here ships. Keys are generated per run and never written to disk.

- **`OidcIssuer`**: a local OpenID Connect issuer standing in for WorkOS AuthKit, so no test needs
  a real account. Standard endpoints only: discovery, JWKS, authorize, token (authorization code
  with PKCE S256; refresh with rotation and reuse detection) and revocation (RFC 7009).
  - Consent is scripted (`issuer.consent = { user }` or `"deny"`).
  - `browse(url)` plays the system browser and returns the loopback redirect.
  - `mint()` makes access tokens directly, including broken ones: expired, foreign key, wrong
    issuer or audience.
  - `rotateKeys()` exercises the relay's JWKS refetch.
  - `down` and `failNextToken` make it fail on demand.
  - A management API like WorkOS's: `DELETE /user_management/users/{id}` with `adminKey` deletes
    the user and ends its refresh tokens, as the relay does on account deletion. `failAdmin`
    scripts its failures.
- **`ApnsMock`**: Apple's provider API (`POST /3/device/<token>`) over plain HTTP/1.1.
  - It checks the ES256 provider token (kid, team, age), topic, push type, device token and the
    4 KB payload limit, and answers with APNs's statuses and reasons.
  - `script()` and `unregister()` produce 429, 410 and the other failures.
  - `p8` is the key in the form the relay is configured with.

Both serve a Web-standard handler over `node:http` on 127.0.0.1, so they run under Bun and Node.

```ts
const issuer = await OidcIssuer.start();
const oidc = await OidcClient.discover({ issuer: issuer.url, clientId: issuer.clientId, allowInsecureLoopback: true });
const pending = await oidc.begin("http://127.0.0.1:53123/callback");
const tokens = await oidc.complete(pending, await issuer.browse(pending.url));
```
