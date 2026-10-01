import XCTest
@testable import HomerunKit

final class SealedTests: XCTestCase {
  struct Device {
    let id: String
    let noise: SoftwareX25519
    let signing: SoftwareEd25519
  }

  func devices(_ v: JSON) throws -> [String: Device] {
    var out: [String: Device] = [:]
    for (name, d) in v["devices"]!.object! {
      let noise = try SoftwareX25519(secret: hex(d["x25519_secret"]))
      XCTAssertEqual(Bytes.b64url(noise.publicKey), d["x25519_public"]!.string!)
      let signing = try SoftwareEd25519(secret: hex(d["ed25519_secret"]))
      XCTAssertEqual(Bytes.b64url(signing.publicKey), d["ed25519_public"]!.string!)
      out[name] = Device(id: d["device_id"]!.string!, noise: noise, signing: signing)
    }
    return out
  }

  func header(_ j: JSON) throws -> Sealed.Header { try XCTUnwrap(Sealed.Header(strict: j)) }

  /// The same plaintext, ephemeral key and chunk size give the TypeScript's exact ciphertext.
  func testSealVectors() throws {
    let v = try Vectors.load("sealed")
    let devs = try devices(v)
    let cases = v["seal"]!.array!
    XCTAssertFalse(cases.isEmpty)
    for c in cases {
      let name = c["name"]!.string!
      let sender = devs[c["sender"]!.string!]!
      let env = c["envelope"]!
      let h = try header(env["header"]!)
      // Found by its key: one case seals to a key that isn't the addressee's.
      let recipient = devs.values.first { Bytes.b64url($0.noise.publicKey) == c["recipient_static"]!.string! }!
      // The exact bytes the TypeScript sealed: JSON key order is the sender's.
      guard case .success(let plaintext) = Sealed.decrypt(header: h, ciphertext: env["ciphertext"]!.string!, key: recipient.noise, senderStatic: sender.noise.publicKey) else {
        return XCTFail("\(name): didn't decrypt")
      }
      if let raw = c["plaintext"]?.string {
        // Sealed raw, for the open vectors: a UTF-8 string, JSON or not.
        XCTAssertEqual(plaintext, Data(raw.utf8), name)
      } else {
        XCTAssertEqual(try JSON.parse(plaintext), c["inner"]!, name)
      }
      XCTAssertEqual(Bytes.b64url(recipient.noise.publicKey), c["recipient_static"]!.string!, name)
      let resealed = try Sealed.sealRaw(
        header: h, plaintext: plaintext, sender: sender.noise, recipientStatic: recipient.noise.publicKey,
        ephemeral: try SoftwareX25519(secret: hex(c["ephemeral_secret"])), maxChunk: c["max_chunk"]?.int.map(Int.init))
      XCTAssertEqual(resealed.ciphertext, env["ciphertext"]!.string!, name)
      XCTAssertEqual(resealed.json, env, name)
    }
  }

  func testOpenVectors() throws {
    let v = try Vectors.load("sealed")
    let devs = try devices(v)
    let cases = v["open"]!.array!
    XCTAssertGreaterThanOrEqual(cases.count, 30)
    for c in cases {
      let name = c["name"]!.string!
      let me = devs[c["recipient"]!.string!]!
      var pinned: [String: Data] = [:]
      for (id, k) in c["pinned"]!.object! { pinned[id] = try Bytes.fromB64url(k.string!) }
      let seen = Set(c["seen"]!.array!.compactMap(\.string))
      let r = Sealed.open(c["envelope"]!, myDeviceId: me.id, myKey: me.noise, senderStatic: { pinned[$0] }, now: c["now"]!.int!, seen: { seen.contains($0) })
      let expect = c["expect"]!
      if expect["ok"] == .bool(true) {
        guard case .ok(_, let inner) = r else { return XCTFail("\(name): \(r)") }
        XCTAssertEqual(inner, expect["inner"]!, name)
      } else {
        XCTAssertEqual(r, .rejected(Sealed.RejectReason(rawValue: expect["reason"]!.string!)!), name)
      }
    }
  }

  func testSealOpenRoundTripAndWithdrawal() throws {
    let desk = SoftwareX25519(), phone = SoftwareX25519()
    let deskId = "5b1f6a2e-3c4d-4e8f-8a7b-1c2d3e4f5a6b", phoneId = "0e5a3c1d-7b2f-4d8e-9a61-3f0c2b7d9e10"
    let rid = "11111111-2222-4333-8444-555555555555"
    let body = JSON.object([("type", .string("push")), ("category", .string("input_request")), ("title", .string("Answered")), ("body", .string("")), ("request_id", .string(rid)), ("withdrawn", .bool(true))])
    let now: Int64 = 1_780_000_000_000
    let env = try Sealed.seal(body: body, from: deskId, to: phoneId, sender: desk, recipientStatic: phone.publicKey, now: now, collapseId: Bytes.b64url(Data(count: 16)))
    let state = RemoteState(json: .object([("device", .object([("device_id", .string(phoneId))])), ("desktops", .object([(deskId, .object([("name", .string("Mac")), ("static_public_key", .string(Bytes.b64url(desk.publicKey)))]))])), ("seen", .object([]))]))!
    let userInfo: [AnyHashable: Any] = ["aps": ["mutable-content": 1], "hr": try JSONSerialization.jsonObject(with: env.json.data)]
    let (p, msgId) = PushOpener.present(userInfo: userInfo, state: state, key: phone, now: now + 1000)
    XCTAssertEqual(p.outcome, .withdraw(requestId: rid))
    XCTAssertEqual(msgId, env.header.msgId)
    XCTAssertEqual(p.categoryIdentifier, "")
    // Not ours, or tampered: the generic text.
    XCTAssertEqual(PushOpener.present(userInfo: userInfo, state: state, key: SoftwareX25519(), now: now).0, .generic)
    XCTAssertEqual(PushOpener.present(userInfo: ["aps": [:]], state: state, key: phone, now: now).0, .generic)
    XCTAssertThrowsError(try Sealed.seal(body: .object([("type", .string("answer"))]), from: phoneId, to: deskId, sender: phone, recipientStatic: desk.publicKey, now: now))
  }
}
