import XCTest
@testable import HomerunKit

/// A scripted issuer: discovery, the token endpoint and revocation.
final class FakeIssuer {
  let issuer = "https://issuer.example"
  var now: Int64 = 1_780_000_000_000
  var nonce = ""
  var refreshCount = 0
  var deadRefresh = false
  var revoked: [String] = []
  var requests: [String: [String: String]] = [:]

  func jwt(_ claims: JSON) -> String { "e30.\(Bytes.b64url(claims.data)).sig" }

  func idToken(sub: String = "user_1", nonce: String?) -> String {
    var c: [(String, JSON)] = [("iss", .string(issuer)), ("aud", .string("client_1")), ("sub", .string(sub)), ("exp", .int(now / 1000 + 600)), ("iat", .int(now / 1000)), ("email", .string("a@b.c"))]
    if let nonce { c.append(("nonce", .string(nonce))) }
    return jwt(.object(c))
  }

  lazy var http: HTTPClient = { [unowned self] req in
    let url = req.url!.absoluteString
    func reply(_ status: Int, _ j: JSON) -> (Data, HTTPURLResponse) {
      (j.data, HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    if url.hasSuffix("/.well-known/openid-configuration") {
      return reply(200, .object([("issuer", .string(issuer)), ("authorization_endpoint", .string("\(issuer)/authorize?provider=x")), ("token_endpoint", .string("\(issuer)/token")), ("revocation_endpoint", .string("\(issuer)/revoke"))]))
    }
    let form = Dictionary(uniqueKeysWithValues: String(data: req.httpBody!, encoding: .utf8)!.split(separator: "&").map {
      let kv = $0.split(separator: "=", maxSplits: 1)
      return (String(kv[0]), String(kv[1]).removingPercentEncoding!)
    })
    requests[url] = form
    if url.hasSuffix("/revoke") {
      revoked.append(form["token"]!)
      return reply(200, .object([]))
    }
    if form["grant_type"] == "authorization_code" {
      return reply(200, .object([("access_token", .string("at_0")), ("token_type", .string("Bearer")), ("expires_in", .int(300)), ("refresh_token", .string("rt_0")), ("id_token", .string(idToken(nonce: nonce)))]))
    }
    if deadRefresh { return reply(400, .object([("error", .string("invalid_grant"))])) }
    refreshCount += 1
    return reply(200, .object([("access_token", .string("at_\(refreshCount)")), ("token_type", .string("bearer")), ("expires_in", .int(300)), ("refresh_token", .string("rt_\(refreshCount)"))]))
  }
}

final class AccountTests: XCTestCase {
  let cfg = OidcConfig(issuer: "https://issuer.example", clientId: "client_1", redirectUri: "com.angilyu.homerun.ios:/auth/callback", authParams: ["provider": "authkit"])

  func testPKCEChallenge() {
    // S256: unpadded base64url of SHA-256 over the verifier's ASCII (computed independently).
    XCTAssertEqual(OidcClient.codeChallenge("dBjftJeZ4CVP-mJ92K9mGgdZgqnlrvX0uFNkdzPDY3U"), "cAOVWi8DGhapU4v_ksT27Y_XdbbfysGLad8rUVUX2tM")
  }

  func testSignInRefreshRotationAndSignOut() async throws {
    let fake = FakeIssuer()
    let store = MemorySecretStore()
    let owner = TokenOwner(store: store, http: fake.http, now: { fake.now })
    await owner.configure(cfg)
    let url = try await owner.begin()
    let q = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
    XCTAssertEqual(q["provider"], "authkit")
    XCTAssertEqual(q["code_challenge_method"], "S256")
    XCTAssertEqual(q["response_type"], "code")
    XCTAssertEqual(q["redirect_uri"], cfg.redirectUri)
    fake.nonce = q["nonce"]!

    // A callback with the wrong state is refused, and ends that attempt.
    var cb = URLComponents(string: cfg.redirectUri)!
    cb.queryItems = [URLQueryItem(name: "code", value: "c"), URLQueryItem(name: "state", value: "nope")]
    await XCTAssertThrowsAsync(try await owner.complete(callback: cb.url!))

    let url2 = try await owner.begin()
    let q2 = Dictionary(uniqueKeysWithValues: URLComponents(url: url2, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
    fake.nonce = q2["nonce"]!
    cb.queryItems = [URLQueryItem(name: "code", value: "c"), URLQueryItem(name: "state", value: q2["state"]!), URLQueryItem(name: "iss", value: fake.issuer)]
    let state = try await owner.complete(callback: cb.url!)
    XCTAssertEqual(state, .signedIn(subject: "user_1", email: "a@b.c"))
    XCTAssertEqual(fake.requests["\(fake.issuer)/token"]?["code_verifier"].map(OidcClient.codeChallenge), q2["code_challenge"])

    let at = try await owner.accessToken()
    XCTAssertEqual(at, "at_0")
    fake.now += 280_000
    let at1 = try await owner.accessToken()
    XCTAssertEqual(at1, "at_1")
    XCTAssertEqual(fake.requests["\(fake.issuer)/token"]?["refresh_token"], "rt_0")

    // A fresh owner (the app relaunched in the background) resumes from the Keychain.
    let relaunched = TokenOwner(store: store, http: fake.http, now: { fake.now })
    await relaunched.configure(cfg)
    let at2 = try await relaunched.accessToken()
    XCTAssertEqual(at2, "at_2")
    XCTAssertEqual(fake.requests["\(fake.issuer)/token"]?["refresh_token"], "rt_1")

    await relaunched.signOut()
    XCTAssertEqual(fake.revoked, ["rt_2"])
    let after = await relaunched.state
    XCTAssertEqual(after, .signedOut)
  }

  func testDeadRefreshTokenSignsOut() async throws {
    let fake = FakeIssuer()
    let store = MemorySecretStore()
    try store.set(TokenOwner.account, JSON.object([("refresh_token", .string("rt_x")), ("subject", .string("user_1"))]).data, afterFirstUnlock: true)
    let owner = TokenOwner(store: store, http: fake.http, now: { fake.now })
    await owner.configure(cfg)
    fake.deadRefresh = true
    do {
      _ = try await owner.accessToken()
      XCTFail("should have thrown")
    } catch let e as OidcError {
      XCTAssertEqual(e.code, "signed_out")
    }
    XCTAssertNil(try store.get(TokenOwner.account))
  }

  func testIdTokenChecks() async throws {
    let fake = FakeIssuer()
    let c = try await OidcClient.discover(cfg, http: fake.http, now: { fake.now })
    XCTAssertNoThrow(try c.validateIdToken(fake.idToken(nonce: "n"), nonce: "n"))
    XCTAssertThrowsError(try c.validateIdToken(fake.idToken(nonce: "n"), nonce: "m"))
    XCTAssertThrowsError(try c.validateIdToken(fake.jwt(.object([("iss", .string("https://evil")), ("aud", .string("client_1")), ("sub", .string("s")), ("exp", .int(fake.now / 1000 + 60)), ("iat", .int(0))])), nonce: nil))
    XCTAssertThrowsError(try c.validateIdToken(fake.jwt(.object([("iss", .string(fake.issuer)), ("aud", .string("other")), ("sub", .string("s")), ("exp", .int(fake.now / 1000 + 60)), ("iat", .int(0))])), nonce: nil))
    XCTAssertThrowsError(try c.validateIdToken(fake.jwt(.object([("iss", .string(fake.issuer)), ("aud", .string("client_1")), ("sub", .string("s")), ("exp", .int(fake.now / 1000 - 3600)), ("iat", .int(0))])), nonce: nil))
    var insecure = cfg
    insecure.issuer = "http://issuer.example"
    await XCTAssertThrowsAsync(try await OidcClient.discover(insecure, http: fake.http))
  }

  func testDeviceKeysWithoutSecureEnclave() throws {
    let store = MemorySecretStore()
    let id = "0e5a3c1d-7b2f-4d8e-9a61-3f0c2b7d9e10"
    let k = try DeviceKeys.create(deviceId: id, store: store, secureEnclave: false)
    let loaded = try XCTUnwrap(try DeviceKeys.load(deviceId: id, store: store))
    XCTAssertEqual(loaded.noise.publicKey, k.noise.publicKey)
    XCTAssertEqual(loaded.signing.publicKey, k.signing.publicKey)
    XCTAssertNil(try DeviceKeys.load(deviceId: "2d3e4f5a-0000-4000-8000-000000000000", store: store))
    try DeviceKeys.destroy(store: store)
    XCTAssertNil(try DeviceKeys.load(deviceId: id, store: store))
  }

  func testKeyWrapRoundTrip() throws {
    // The ECIES wrap, with a software P-256 key standing in for the Secure Enclave's.
    let recipient = P256Software()
    let blob = try DeviceKeys.wrap(Data("secret".utf8), to: recipient.key.publicKey)
    XCTAssertEqual(try recipient.unwrap(blob), Data("secret".utf8))
  }
}

import CryptoKit

struct P256Software {
  let key = P256.KeyAgreement.PrivateKey()
  func unwrap(_ blob: Data) throws -> Data {
    let ephPub = blob.prefix(65)
    let shared = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: ephPub))
    let sym = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephPub, sharedInfo: DeviceKeys.wrapInfo, outputByteCount: 32)
    return try AES.GCM.open(AES.GCM.SealedBox(combined: blob.dropFirst(65)), using: sym)
  }
}

func XCTAssertThrowsAsync<T>(_ body: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
  do {
    _ = try await body()
    XCTFail("expected an error", file: file, line: line)
  } catch {}
}
