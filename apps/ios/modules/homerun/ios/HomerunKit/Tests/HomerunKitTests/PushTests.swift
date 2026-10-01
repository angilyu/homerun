import XCTest
@testable import HomerunKit

final class PushTests: XCTestCase {
  /// The extension reads the envelope out of exactly the APNs bodies the relay sends.
  func testAPNsPayloadVectors() throws {
    let v = try Vectors.load("apns-payload")
    for c in v["cases"]!.array! {
      let name = c["name"]!.string!
      let body = c["body"]!.string!
      XCTAssertLessThanOrEqual(Int64(body.utf8.count), v["max_bytes"]!.int!, name)
      let userInfo = try JSONSerialization.jsonObject(with: Data(body.utf8)) as! [AnyHashable: Any]
      let aps = userInfo["aps"] as! [String: Any]
      XCTAssertEqual(aps["mutable-content"] as? Int, 1, name)
      let alert = aps["alert"] as! [String: String]
      XCTAssertEqual(alert["title"], PushPresentation.genericTitle, name)
      XCTAssertEqual(alert["body"], PushPresentation.genericBody, name)
      if c["sealed"] == .bool(true) {
        XCTAssertEqual(PushOpener.envelope(userInfo: userInfo), c["envelope"]!, name)
      } else {
        XCTAssertNil(PushOpener.envelope(userInfo: userInfo), name)
      }
    }
  }

  func testSealedPushSchema() throws {
    let ok = try JSON.parse(#"{"type":"push","category":"input_request","title":"Allow?","body":"rm -rf build","request_id":"11111111-2222-4333-8444-555555555555","actions":[{"id":"allow","label":"Allow"},{"id":"deny","label":"Deny"}]}"#)
    let p = try XCTUnwrap(SealedPush(ok))
    XCTAssertEqual(p.actions.count, 2)
    XCTAssertFalse(p.withdrawn)
    XCTAssertNotEqual(PushPresentation.category(for: p.actions), "")
    XCTAssertEqual(PushPresentation.category(for: p.actions), PushPresentation.category(for: p.actions))
    XCTAssertNil(SealedPush(try JSON.parse(#"{"type":"push","category":"nope","title":"x","body":""}"#)))
    XCTAssertNil(SealedPush(try JSON.parse(#"{"type":"push","category":"run_finished","title":"","body":""}"#)))
    XCTAssertNil(SealedPush(try JSON.parse(#"{"type":"push","category":"run_finished","title":"x","body":"","withdrawn":false}"#)))
  }

  /// The extension's view of the "push" and "withdrawal" vectors, as the phone.
  func testPresentVectors() throws {
    let v = try Vectors.load("sealed")
    let devs = v["devices"]!
    let phoneKey = try SoftwareX25519(secret: hex(devs["phone"]!["x25519_secret"]))
    let desktop = devs["desktop"]!
    let state = try XCTUnwrap(RemoteState(json: .object([
      ("device", .object([("device_id", devs["phone"]!["device_id"]!)])),
      ("desktops", .object([(desktop["device_id"]!.string!, .object([("name", .string("Mac")), ("static_public_key", desktop["x25519_public"]!)]))])),
      ("seen", .object([])),
    ])))
    func present(_ name: String, key: DhKey? = nil, seen: Bool = false) throws -> (PushPresentation, String?) {
      let c = try XCTUnwrap(v["seal"]!.array!.first { $0["name"]?.string == name })
      let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Homerun"]], "hr": try JSONSerialization.jsonObject(with: c["envelope"]!.data)]
      let s = seen ? RemoteState(deviceId: state.deviceId, desktops: state.desktops, seen: [c["inner"]!["msg_id"]!.string!]) : state
      return PushOpener.present(userInfo: userInfo, state: s, key: key ?? phoneKey, now: c["inner"]!["created_at"]!.int! + 1000)
    }

    let (p, msgId) = try present("push")
    XCTAssertEqual(p.outcome, .show)
    XCTAssertEqual(p.title, "Approval needed")
    XCTAssertEqual(msgId, "pPjmEeWrf0NcYSXF75Aonw")
    XCTAssertEqual(p.userInfo["hr_request"], "4c3b2a19-0f8e-4d7c-9b6a-5f4e3d2c1b0a")
    XCTAssertEqual(p.userInfo["hr_desktop"], desktop["device_id"]!.string!)
    XCTAssertEqual(p.threadIdentifier, "\(desktop["device_id"]!.string!).3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d")
    XCTAssertEqual(p.categoryIdentifier, PushPresentation.category(for: p.actions))
    XCTAssertEqual(PushPresentation.actions(userInfo: p.userInfo), [SealedPush.Action(id: "allow", label: "Allow"), SealedPush.Action(id: "deny", label: "Deny")])
    XCTAssertEqual(LockScreenAnswer.response(actionId: "deny", actions: p.actions), .object([("type", .string("approval")), ("decision", .string("deny"))]))

    let (w, _) = try present("withdrawal")
    XCTAssertEqual(w.outcome, .withdraw(requestId: "4c3b2a19-0f8e-4d7c-9b6a-5f4e3d2c1b0a"))
    XCTAssertEqual(w.categoryIdentifier, "")

    // Anything that doesn't open is the generic text, never an error.
    XCTAssertEqual(try present("push", key: try SoftwareX25519(secret: hex(devs["other"]!["x25519_secret"]))).0, .generic)
    XCTAssertEqual(try present("push", seen: true).0.outcome, .generic)
    XCTAssertEqual(PushOpener.present(userInfo: ["aps": [:]], state: state, key: phoneKey, now: 0).0, .generic)
    XCTAssertEqual(PushOpener.present(userInfo: ["hr": "garbage"], state: state, key: phoneKey, now: 0).0, .generic)
  }
}
