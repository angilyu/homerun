import XCTest
@testable import HomerunKit

final class ApprovalTests: XCTestCase {
  func testMessageVectors() throws {
    let v = try Vectors.load("approval")
    XCTAssertEqual(v["app_id"]?.string, "\(Approval.teamId).\(Approval.bundleId)")
    for m in v["message"]!.array! {
      let b = try Approval.message(deviceId: m["device_id"]!.string!, desktopId: m["desktop_id"]!.string!, requestId: m["request_id"]!.string!, decision: m["decision"]!.string!, expiresAt: m["expires_at"]!.int!)
      XCTAssertEqual(Bytes.hex(b), m["hex"]!.string!)
    }
  }

  func testVerifyVectors() throws {
    let v = try Vectors.load("approval")
    XCTAssertEqual(v["max_lifetime_ms"]?.int, Approval.proofMaxMs)
    XCTAssertEqual(v["clock_skew_ms"]?.int, Approval.clockSkewMs)
    for c in v["verify"]!.array! {
      let r = Approval.check(
        signature: c["proof"]!["signature"]!.string!, expiresAt: c["proof"]!["expires_at"]!.int!, deviceId: c["device_id"]!.string!, desktopId: c["desktop_id"]!.string!,
        requestId: c["request_id"]!.string!, decision: c["decision"]!.string!, approvalKey: c["approval_key"]!.string!, now: c["now"]!.int!, requestExpiresAt: c["request_expires_at"]?.int)
      XCTAssertEqual(r.rawValue, c["expect"]!.string!, c["name"]!.string!)
    }
  }

  func testRenewalHash() throws {
    let r = try Vectors.load("approval")["renewal"]!
    XCTAssertEqual(Bytes.hex(try Approval.renewalClientDataHash(deviceId: r["device_id"]!.string!, approvalKey: r["approval_key"]!.string!)), r["client_data_hash"]!.string!)
  }

  func testAttestationClientDataHash() throws {
    let v = try Vectors.load("app-attest")
    XCTAssertEqual(v["app_id"]?.string, "\(Approval.teamId).\(Approval.bundleId)")
    for c in v["client_data_hash"]!.array! {
      let id = c["identity"]!
      let h = try Approval.attestationClientDataHash(deviceId: id["device_id"]!.string!, staticKey: id["static_public_key"]!.string!, signingKey: id["signing_public_key"]!.string!, approvalKey: c["approval_key"]?.string)
      XCTAssertEqual(Bytes.hex(h), c["hex"]!.string!, c["name"]!.string!)
    }
  }
}
