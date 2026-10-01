import CryptoKit
import Foundation
import LocalAuthentication

/// Approval proofs (§9.8, §13): a Secure Enclave P-256 key that signs only after Face ID, pinned
/// by the desktop when it verified this phone's App Attest attestation.
public enum Approval {
  public static let label = "homerun-approval-v1"
  public static let renewLabel = "homerun-se-rekey-v1"
  public static let attestLabel = "homerun-app-attest-v1"
  public static let teamId = "NMJBY8WL8T"
  public static let bundleId = "com.angilyu.homerun.ios"

  public static func message(deviceId: String, desktopId: String, requestId: String, decision: String, expiresAt: Int64) throws -> Data {
    try Bytes.framed([.string(label), .string(deviceId), .string(desktopId), .string(requestId), .string(decision), .string(String(expiresAt))])
  }

  public static func renewalClientDataHash(deviceId: String, approvalKey: String) throws -> Data {
    Primitives.sha256(try Bytes.framed([.string(renewLabel), .string(deviceId), .bytes(try Bytes.fromB64url(approvalKey))]))
  }

  public static func attestationClientDataHash(deviceId: String, staticKey: String, signingKey: String, approvalKey: String?) throws -> Data {
    let ak = try approvalKey.map(Bytes.fromB64url) ?? Data()
    return Primitives.sha256(try Bytes.framed([.string(attestLabel), .string(deviceId), .bytes(try Bytes.fromB64url(staticKey)), .bytes(try Bytes.fromB64url(signingKey)), .bytes(ak)]))
  }

  public static let proofMaxMs: Int64 = 5 * 60 * 1000
  public static let clockSkewMs: Int64 = 5 * 60 * 1000

  public enum Check: String { case ok, malformed, signature, expired, too_long }

  /// `checkApprovalProof`: what the runtime does with a proof, for the vectors.
  public static func check(signature: String, expiresAt: Int64, deviceId: String, desktopId: String, requestId: String, decision: String, approvalKey: String, now: Int64, requestExpiresAt: Int64?) -> Check {
    if expiresAt + clockSkewMs < now { return .expired }
    if expiresAt > now + proofMaxMs + clockSkewMs { return .too_long }
    if let r = requestExpiresAt, expiresAt > r { return .too_long }
    guard let sig = try? Bytes.fromB64url(signature), let key = try? Bytes.fromB64url(approvalKey),
      let msg = try? message(deviceId: deviceId, desktopId: desktopId, requestId: requestId, decision: decision, expiresAt: expiresAt)
    else { return .malformed }
    guard let pub = try? P256.Signing.PublicKey(x963Representation: key), let s = try? P256.Signing.ECDSASignature(derRepresentation: sig) else { return .signature }
    return pub.isValidSignature(s, for: msg) ? .ok : .signature
  }

  /// Checks a DER signature against a 65-byte uncompressed key, as the runtime does.
  public static func verify(signature: String, message: Data, approvalKey: String) -> Bool {
    guard let sig = try? Bytes.fromB64url(signature), let key = try? Bytes.fromB64url(approvalKey),
      let pub = try? P256.Signing.PublicKey(x963Representation: key),
      let s = try? P256.Signing.ECDSASignature(derRepresentation: sig)
    else { return false }
    return pub.isValidSignature(s, for: message)
  }
}

/// The approval key itself, in the Secure Enclave with `.biometryCurrentSet`: enrolling a new
/// face or finger invalidates it, and the phone must renew it with an App Attest assertion.
public enum ApprovalKey {
  static let account = "approval-key"

  /// The public key (x963, base64url), or nil if there is none.
  public static func publicKey(store: SecretStore) -> String? {
    guard SecureEnclave.isAvailable, let rep = try? store.get(account),
      let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: rep)
    else { return nil }
    return Bytes.b64url(key.publicKey.x963Representation)
  }

  /// A new key, replacing any; nil when the phone has no Secure Enclave or no biometry enrolled.
  public static func create(store: SecretStore) throws -> String? {
    guard SecureEnclave.isAvailable else { return nil }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error) else {
      return nil
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
      return nil
    }
    try store.set(account, key.dataRepresentation, afterFirstUnlock: false)
    return Bytes.b64url(key.publicKey.x963Representation)
  }

  public static func destroy(store: SecretStore) throws { try store.delete(account) }

  /// Face ID, then a DER signature (base64url). Nil when the user cancels; throws when the key
  /// is gone or invalidated by a biometry change.
  public static func sign(_ message: Data, reason: String, store: SecretStore) async throws -> String? {
    guard let rep = try store.get(account) else { throw ProtocolError.invalid("no approval key") }
    let ctx = LAContext()
    ctx.localizedReason = reason
    do {
      _ = try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    } catch let e as LAError where [.userCancel, .appCancel, .systemCancel, .userFallback].contains(e.code) {
      return nil
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: rep, authenticationContext: ctx)
    return Bytes.b64url(try key.signature(for: message).derRepresentation)
  }
}
