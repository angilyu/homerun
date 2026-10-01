import Foundation

/// Sign-in (§10.3, §10.4) in Swift: the same standard OpenID Connect as `oidc.ts` (Authorization
/// Code with PKCE S256, `state`, `nonce`, refresh-token rotation, revocation), so the provider
/// stays swappable. It lives natively so a lock-screen answer can get an access token without
/// starting the app's JavaScript, and because Hermes has no WebCrypto for `oauth4webapi` (§18 row 119).
public struct OidcConfig: Equatable {
  public var issuer: String
  public var clientId: String
  public var redirectUri: String
  public var scope: String
  public var authParams: [String: String]
  /// Plain http, for a local test issuer on 127.0.0.1 or localhost only.
  public var allowInsecureLoopback: Bool

  public init(issuer: String, clientId: String, redirectUri: String, scope: String = "openid email offline_access", authParams: [String: String] = [:], allowInsecureLoopback: Bool = false) {
    self.issuer = issuer
    self.clientId = clientId
    self.redirectUri = redirectUri
    self.scope = scope
    self.authParams = authParams
    self.allowInsecureLoopback = allowInsecureLoopback
  }
}

public struct OidcError: Error, Equatable, CustomStringConvertible {
  public let message: String
  /// `invalid_grant` means the refresh token is dead: sign in again.
  public let code: String?
  public init(_ message: String, code: String? = nil) {
    self.message = message
    self.code = code
  }
  public var description: String { message }
}

public struct OidcTokens: Equatable {
  public var accessToken: String
  public var refreshToken: String?
  /// Milliseconds since the epoch.
  public var expiresAt: Int64
  public var subject: String
  public var email: String?
}

public struct PendingAuthorization: Equatable {
  public let url: URL
  public let state: String
  public let nonce: String
  public let verifier: String
}

public typealias HTTPClient = (URLRequest) async throws -> (Data, HTTPURLResponse)

public let urlSessionHTTP: HTTPClient = { req in
  let (data, res) = try await URLSession.shared.data(for: req)
  guard let http = res as? HTTPURLResponse else { throw OidcError("not an HTTP response") }
  return (data, http)
}

public final class OidcClient {
  public let config: OidcConfig
  public let issuer: String
  let authorizationEndpoint: URL
  let tokenEndpoint: URL
  let revocationEndpoint: URL?
  let http: HTTPClient
  let now: () -> Int64

  static func isLoopback(_ u: URL) -> Bool { ["127.0.0.1", "localhost", "::1", "[::1]"].contains(u.host ?? "") }

  static func checkURL(_ u: URL, _ cfg: OidcConfig) throws {
    if u.scheme == "https" { return }
    if u.scheme == "http" && cfg.allowInsecureLoopback && isLoopback(u) { return }
    throw OidcError("the issuer must use https")
  }

  public static func discover(_ cfg: OidcConfig, http: @escaping HTTPClient = urlSessionHTTP, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) async throws -> OidcClient {
    guard let issuer = URL(string: cfg.issuer) else { throw OidcError("bad issuer") }
    try checkURL(issuer, cfg)
    let base = cfg.issuer.hasSuffix("/") ? String(cfg.issuer.dropLast()) : cfg.issuer
    var req = URLRequest(url: URL(string: base + "/.well-known/openid-configuration")!)
    req.setValue("application/json", forHTTPHeaderField: "accept")
    let (data, res) = try await http(req)
    guard res.statusCode == 200, let j = try? JSON.parse(data) else { throw OidcError("discovery failed") }
    guard j["issuer"]?.string == cfg.issuer else { throw OidcError("the discovery document is for another issuer") }
    guard let az = j["authorization_endpoint"]?.string.flatMap(URL.init(string:)) else { throw OidcError("the issuer has no authorization endpoint") }
    guard let tk = j["token_endpoint"]?.string.flatMap(URL.init(string:)) else { throw OidcError("the issuer has no token endpoint") }
    try checkURL(az, cfg)
    try checkURL(tk, cfg)
    let rv = j["revocation_endpoint"]?.string.flatMap(URL.init(string:))
    if let rv { try checkURL(rv, cfg) }
    return OidcClient(config: cfg, issuer: cfg.issuer, authorizationEndpoint: az, tokenEndpoint: tk, revocationEndpoint: rv, http: http, now: now)
  }

  init(config: OidcConfig, issuer: String, authorizationEndpoint: URL, tokenEndpoint: URL, revocationEndpoint: URL?, http: @escaping HTTPClient, now: @escaping () -> Int64) {
    self.config = config
    self.issuer = issuer
    self.authorizationEndpoint = authorizationEndpoint
    self.tokenEndpoint = tokenEndpoint
    self.revocationEndpoint = revocationEndpoint
    self.http = http
    self.now = now
  }

  public static func codeChallenge(_ verifier: String) -> String { Bytes.b64url(Primitives.sha256(Data(verifier.utf8))) }

  public func begin() -> PendingAuthorization {
    let verifier = Bytes.b64url(Random.bytes(32))
    let state = Bytes.b64url(Random.bytes(32))
    let nonce = Bytes.b64url(Random.bytes(32))
    var c = URLComponents(url: authorizationEndpoint, resolvingAgainstBaseURL: false)!
    var items = (c.queryItems ?? []).filter { !["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state", "nonce"].contains($0.name) }
    items += [
      URLQueryItem(name: "client_id", value: config.clientId), URLQueryItem(name: "redirect_uri", value: config.redirectUri),
      URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: config.scope),
      URLQueryItem(name: "code_challenge", value: OidcClient.codeChallenge(verifier)), URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: nonce),
    ]
    for (k, v) in config.authParams.sorted(by: { $0.key < $1.key }) {
      items.removeAll { $0.name == k }
      items.append(URLQueryItem(name: k, value: v))
    }
    c.queryItems = items
    return PendingAuthorization(url: c.url!, state: state, nonce: nonce, verifier: verifier)
  }

  /// Checks the redirect against what `begin` kept and redeems the code.
  public func complete(_ pending: PendingAuthorization, callback: URL) async throws -> OidcTokens {
    let q = Dictionary((URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    guard q["state"] == pending.state else { throw OidcError("the sign-in response doesn't match this request") }
    if let iss = q["iss"], iss != issuer { throw OidcError("the sign-in response came from another issuer") }
    if let err = q["error"] { throw OidcError(q["error_description"] ?? err, code: err) }
    guard let code = q["code"], !code.isEmpty else { throw OidcError("no authorization code") }
    let r = try await token(["grant_type": "authorization_code", "code": code, "redirect_uri": config.redirectUri, "code_verifier": pending.verifier])
    guard let idToken = r["id_token"]?.string else { throw OidcError("no ID token") }
    let claims = try validateIdToken(idToken, nonce: pending.nonce)
    return try tokens(r, claims: claims, previous: nil)
  }

  public func refresh(_ refreshToken: String, previous: (subject: String, email: String?)?) async throws -> OidcTokens {
    let r = try await token(["grant_type": "refresh_token", "refresh_token": refreshToken])
    let claims = try r["id_token"]?.string.map { try validateIdToken($0, nonce: nil) }
    return try tokens(r, claims: claims, previous: previous)
  }

  public func revoke(_ refreshToken: String) async throws {
    guard let ep = revocationEndpoint else { return }
    let (data, res) = try await http(OidcClient.form(ep, ["token": refreshToken, "token_type_hint": "refresh_token", "client_id": config.clientId]))
    if res.statusCode != 200 { throw OidcClient.error(data, "revocation failed") }
  }

  static func form(_ url: URL, _ params: [String: String]) -> URLRequest {
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/x-www-form-urlencoded;charset=UTF-8", forHTTPHeaderField: "content-type")
    req.setValue("application/json", forHTTPHeaderField: "accept")
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    req.httpBody = Data(params.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
    return req
  }

  static func error(_ data: Data, _ fallback: String) -> OidcError {
    guard let j = try? JSON.parse(data), let e = j["error"]?.string else { return OidcError(fallback) }
    return OidcError(j["error_description"]?.string ?? e, code: e)
  }

  func token(_ params: [String: String]) async throws -> JSON {
    var p = params
    p["client_id"] = config.clientId
    let (data, res) = try await http(OidcClient.form(tokenEndpoint, p))
    guard res.statusCode == 200 else { throw OidcClient.error(data, "the token request failed") }
    guard let j = try? JSON.parse(data), j.object != nil else { throw OidcError("the token response isn't JSON") }
    guard let at = j["access_token"]?.string, !at.isEmpty else { throw OidcError("no access token") }
    guard j["token_type"]?.string?.lowercased() == "bearer" else { throw OidcError("unsupported token type") }
    return j
  }

  /// The ID token came straight from the token endpoint over TLS, so its signature isn't checked
  /// (OIDC Core §3.1.3.7); its claims are.
  func validateIdToken(_ jwt: String, nonce: String?) throws -> JSON {
    let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, let payload = try? Bytes.fromB64url(String(parts[1])), let c = try? JSON.parse(payload), c.object != nil else {
      throw OidcError("malformed ID token")
    }
    guard c["iss"]?.string == issuer else { throw OidcError("the ID token is from another issuer") }
    let audOk: Bool
    if let a = c["aud"]?.string { audOk = a == config.clientId } else { audOk = c["aud"]?.array?.contains(.string(config.clientId)) ?? false }
    guard audOk else { throw OidcError("the ID token is for another client") }
    let nowS = now() / 1000
    guard let exp = c["exp"]?.int, exp + 30 > nowS else { throw OidcError("the ID token has expired") }
    guard c["iat"]?.int != nil else { throw OidcError("the ID token has no issue time") }
    guard let sub = c["sub"]?.string, !sub.isEmpty else { throw OidcError("the ID token has no subject") }
    if let nonce, c["nonce"]?.string != nonce { throw OidcError("the ID token's nonce doesn't match") }
    return c
  }

  func tokens(_ r: JSON, claims: JSON?, previous: (subject: String, email: String?)?) throws -> OidcTokens {
    guard let subject = claims?["sub"]?.string ?? previous?.subject ?? OidcClient.subjectOf(r["access_token"]!.string!) else {
      throw OidcError("no subject in the tokens")
    }
    if let previous, subject != previous.subject { throw OidcError("the refreshed tokens are for a different account") }
    let expiresIn = r["expires_in"]?.int ?? 300
    return OidcTokens(accessToken: r["access_token"]!.string!, refreshToken: r["refresh_token"]?.string, expiresAt: now() + expiresIn * 1000, subject: subject, email: claims?["email"]?.string ?? previous?.email)
  }

  static func subjectOf(_ jwt: String) -> String? {
    let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count >= 2, let d = try? Bytes.fromB64url(String(parts[1])), let j = try? JSON.parse(d) else { return nil }
    return j["sub"]?.string
  }
}

/// The signed-in account, owned natively: the refresh token stays in the Keychain
/// (`AfterFirstUnlockThisDeviceOnly`), the access token in memory. The app's JavaScript asks it
/// for access tokens and never sees the refresh token. One refresh at a time.
public actor TokenOwner {
  static let account = "account"

  public enum State: Equatable {
    case signedOut
    case signedIn(subject: String, email: String?)
  }

  let store: SecretStore
  let http: HTTPClient
  let now: () -> Int64
  private var client: OidcClient?
  private var config: OidcConfig?
  private var tokens: OidcTokens?
  private var refreshing: Task<OidcTokens, Error>?
  private var pending: PendingAuthorization?

  public init(store: SecretStore, http: @escaping HTTPClient = urlSessionHTTP, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
    self.store = store
    self.http = http
    self.now = now
  }

  public func configure(_ cfg: OidcConfig) {
    if config != cfg { client = nil }
    config = cfg
  }

  func oidc() async throws -> OidcClient {
    if let client { return client }
    guard let config else { throw OidcError("sign-in isn't configured") }
    let c = try await OidcClient.discover(config, http: http, now: now)
    client = c
    return c
  }

  /// What's stored: the refresh token and who it belongs to.
  func saved() -> (refreshToken: String, subject: String, email: String?)? {
    guard let d = try? store.get(TokenOwner.account), let j = try? JSON.parse(d), let rt = j["refresh_token"]?.string, let sub = j["subject"]?.string else { return nil }
    return (rt, sub, j["email"]?.string)
  }

  func persist(_ t: OidcTokens?) throws {
    guard let t, let rt = t.refreshToken else {
      try store.delete(TokenOwner.account)
      return
    }
    var o: [(String, JSON)] = [("refresh_token", .string(rt)), ("subject", .string(t.subject))]
    if let e = t.email { o.append(("email", .string(e))) }
    try store.set(TokenOwner.account, JSON.object(o).data, afterFirstUnlock: true)
  }

  public var state: State {
    if let t = tokens { return .signedIn(subject: t.subject, email: t.email) }
    if let s = saved() { return .signedIn(subject: s.subject, email: s.email) }
    return .signedOut
  }

  /// The first half of a sign-in: the URL to open in `ASWebAuthenticationSession`.
  public func begin() async throws -> URL {
    let p = try await oidc().begin()
    pending = p
    return p.url
  }

  public func complete(callback: URL) async throws -> State {
    guard let p = pending else { throw OidcError("no sign-in in progress") }
    pending = nil
    let t = try await oidc().complete(p, callback: callback)
    tokens = t
    try persist(t)
    return state
  }

  public func cancelSignIn() { pending = nil }

  /// A valid access token, refreshed if it expires within `margin` milliseconds.
  public func accessToken(margin: Int64 = 60_000) async throws -> String {
    if let t = tokens, t.expiresAt - now() > margin { return t.accessToken }
    return try await refresh().accessToken
  }

  @discardableResult
  public func refresh() async throws -> OidcTokens {
    if let r = refreshing { return try await r.value }
    let task = Task { () throws -> OidcTokens in
      guard let s = saved() else { throw OidcError("signed out", code: "signed_out") }
      do {
        let next = try await oidc().refresh(s.refreshToken, previous: (s.subject, s.email))
        var t = next
        if t.refreshToken == nil { t.refreshToken = s.refreshToken }
        tokens = t
        try persist(t)
        return t
      } catch let e as OidcError where e.code == "invalid_grant" {
        tokens = nil
        try? persist(nil)
        throw OidcError("the session ended; sign in again", code: "signed_out")
      }
    }
    refreshing = task
    defer { refreshing = nil }
    return try await task.value
  }

  public func signOut() async {
    let rt = tokens?.refreshToken ?? saved()?.refreshToken
    tokens = nil
    pending = nil
    try? persist(nil)
    if let rt, let c = try? await oidc() { try? await c.revoke(rt) }
  }
}
