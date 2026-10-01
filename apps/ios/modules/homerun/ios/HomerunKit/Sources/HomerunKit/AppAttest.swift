import Foundation
#if os(iOS)
import DeviceCheck
#endif

/// App Attest (§9.8, §13, §18 row 84): the phone attests its device keys and approval key to the
/// desktop, which verifies the attestation itself; the relay's check is only advisory.
public enum AppAttest {
  public static var isSupported: Bool {
    #if os(iOS)
    return DCAppAttestService.shared.isSupported
    #else
    return false
    #endif
  }

  /// `{key_id, object, approval_key?}` for these keys, or nil when App Attest isn't available
  /// (the simulator, an old phone): the desktop then links the phone as a browser. Every call
  /// makes a new App Attest key (a key attests once), so each desktop pins its own; the app keeps
  /// which `key_id` each desktop pinned, for `assertRenewal`.
  public static func attest(deviceId: String, staticKey: String, signingKey: String, approvalKey: String?) async throws -> JSON? {
    #if os(iOS)
    let svc = DCAppAttestService.shared
    guard svc.isSupported else { return nil }
    let hash = try Approval.attestationClientDataHash(deviceId: deviceId, staticKey: staticKey, signingKey: signingKey, approvalKey: approvalKey)
    // A fresh App Attest key for each attestation: a key attests only once.
    let keyId = try await svc.generateKey()
    let object = try await svc.attestKey(keyId, clientDataHash: hash)
    guard let raw = Data(base64Encoded: keyId) else { throw ProtocolError.invalid("bad App Attest key id") }
    var o: [(String, JSON)] = [("key_id", .string(Bytes.b64url(raw))), ("object", .string(Bytes.b64url(object)))]
    if let approvalKey { o.append(("approval_key", .string(approvalKey))) }
    return .object(o)
    #else
    return nil
    #endif
  }

  /// An assertion by the App Attest key a desktop pinned (`keyId`, base64url as in `attest`)
  /// that vouches for a new approval key (base64url).
  public static func assertRenewal(keyId: String, deviceId: String, approvalKey: String) async throws -> String? {
    #if os(iOS)
    guard DCAppAttestService.shared.isSupported else { return nil }
    let keyId = try Bytes.fromB64url(keyId).base64EncodedString()
    let hash = try Approval.renewalClientDataHash(deviceId: deviceId, approvalKey: approvalKey)
    return Bytes.b64url(try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: hash))
    #else
    return nil
    #endif
  }
}
