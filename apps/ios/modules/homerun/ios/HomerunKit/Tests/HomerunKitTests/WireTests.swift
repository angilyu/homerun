import XCTest
@testable import HomerunKit

final class WireTests: XCTestCase {
  func testRelayWireVectors() throws {
    let v = try Vectors.load("relay-wire")
    let phone = v["devices"]!["phone"]!
    let key = try SoftwareEd25519(secret: hex(phone["ed25519_secret"]))
    let pub = key.publicKey
    XCTAssertEqual(Bytes.b64url(pub), phone["ed25519_public"]!.string!)

    let ch = v["challenge"]!
    let cb = try Wire.challengeBytes(nonce: ch["nonce"]!.string!, deviceId: ch["device_id"]!.string!)
    XCTAssertEqual(Bytes.hex(cb), ch["bytes"]!.string!)
    XCTAssertTrue(SoftwareEd25519.verify(publicKey: pub, signature: try Bytes.fromB64url(ch["signature"]!.string!), message: cb))

    let r = v["request"]!
    let body = Data(r["body"]!.string!.utf8)
    let rb = try Wire.requestBytes(deviceId: r["device_id"]!.string!, ts: r["ts"]!.int!, method: r["method"]!.string!, path: r["path"]!.string!, body: body)
    XCTAssertEqual(Bytes.hex(rb), r["bytes"]!.string!)
    // Ed25519 in CryptoKit is randomized: check the vector's signature, and that ours verifies.
    let header = r["header"]!.string!
    let parts = header.split(separator: ".")
    XCTAssertEqual(String(parts[0]), r["device_id"]!.string!)
    XCTAssertEqual(String(parts[1]), String(r["ts"]!.int!))
    XCTAssertTrue(SoftwareEd25519.verify(publicKey: pub, signature: try Bytes.fromB64url(String(parts[2])), message: rb))
    let ours = try Wire.signRequest(key: key, deviceId: r["device_id"]!.string!, ts: r["ts"]!.int!, method: r["method"]!.string!, path: r["path"]!.string!, body: body)
    XCTAssertTrue(ours.hasPrefix("\(parts[0]).\(parts[1])."))
    XCTAssertTrue(SoftwareEd25519.verify(publicKey: pub, signature: try Bytes.fromB64url(String(ours.split(separator: ".")[2])), message: rb))
    XCTAssertEqual(ours.split(separator: ".")[2].count, 86)
  }

  func testLockScreenAnswer() throws {
    let desk = SoftwareX25519(), phone = SoftwareX25519(), signing = SoftwareEd25519()
    let deskId = "5b1f6a2e-3c4d-4e8f-8a7b-1c2d3e4f5a6b", phoneId = "0e5a3c1d-7b2f-4d8e-9a61-3f0c2b7d9e10"
    let rid = "11111111-2222-4333-8444-555555555555"
    let actions = [SealedPush.Action(id: "option:0", label: "Ship it"), SealedPush.Action(id: "option:1", label: "Wait")]
    XCTAssertNil(LockScreenAnswer.response(actionId: "option:2", actions: actions))
    let resp = try XCTUnwrap(LockScreenAnswer.response(actionId: "option:1", actions: actions))
    XCTAssertEqual(resp.serialized, #"{"type":"question","answers":[{"selected":["Wait"]}]}"#)
    XCTAssertEqual(LockScreenAnswer.response(actionId: "deny", actions: [.init(id: "allow", label: "Allow"), .init(id: "deny", label: "Deny")])?.serialized, #"{"type":"approval","decision":"deny"}"#)

    let now: Int64 = 1_780_000_000_000
    let env = try LockScreenAnswer.seal(requestId: rid, response: resp, myDeviceId: phoneId, desktopId: deskId, key: phone, desktopStatic: desk.publicKey, now: now)
    XCTAssertEqual(env.header.expiresAt, now + 60 * 60 * 1000)
    guard case .ok(_, let inner) = Sealed.open(env.json, myDeviceId: deskId, myKey: desk, senderStatic: { $0 == phoneId ? phone.publicKey : nil }, now: now) else { return XCTFail() }
    XCTAssertEqual(inner["body"]?["via"], .string("notification"))
    XCTAssertEqual(inner["body"]?["response"], resp)

    let req = try LockScreenAnswer.request(envelope: env, relay: URL(string: "https://relay.example/")!, token: "tok", deviceId: phoneId, key: signing, now: now)
    XCTAssertEqual(req.url?.absoluteString, "https://relay.example/v1/sealed")
    XCTAssertEqual(req.httpMethod, "POST")
    XCTAssertEqual(req.value(forHTTPHeaderField: "authorization"), "Bearer tok")
    let proof = req.value(forHTTPHeaderField: "homerun-device")!.split(separator: ".")
    let rb = try Wire.requestBytes(deviceId: phoneId, ts: now, method: "POST", path: "/v1/sealed", body: req.httpBody!)
    XCTAssertTrue(SoftwareEd25519.verify(publicKey: signing.publicKey, signature: try Bytes.fromB64url(String(proof[2])), message: rb))
    XCTAssertEqual(try JSON.parse(req.httpBody!)["envelope"], env.json)
  }
}
