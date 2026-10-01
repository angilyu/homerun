import CryptoKit
import Foundation

/// Where secrets are kept: the shared Keychain on a phone, memory in tests.
public protocol SecretStore {
  func set(_ account: String, _ data: Data, afterFirstUnlock: Bool) throws
  func get(_ account: String) throws -> Data?
  func delete(_ account: String) throws
}

extension Keychain: SecretStore {}

public final class MemorySecretStore: SecretStore {
  private var items: [String: Data] = [:]
  public init() {}
  public func set(_ account: String, _ data: Data, afterFirstUnlock: Bool) throws { items[account] = data }
  public func get(_ account: String) throws -> Data? { items[account] }
  public func delete(_ account: String) throws { items[account] = nil }
}

/// This device's X25519 and Ed25519 keys (§12). Noise and the relay's Ed25519 aren't Secure
/// Enclave curves, so the raw keys live in the shared Keychain (`AfterFirstUnlockThisDeviceOnly`,
/// so the extension can open pushes on a locked phone), wrapped under a Secure Enclave P-256
/// key where the phone has one: a copied Keychain blob is useless off this device (§9.8).
public final class DeviceKeys {
  static let account = "device-keys"
  static let wrapAccount = "device-keys-wrap"
  static let wrapInfo = Data("homerun-device-keys-wrap-v1".utf8)

  public let deviceId: String
  public let noise: SoftwareX25519
  public let signing: SoftwareEd25519

  init(deviceId: String, noise: SoftwareX25519, signing: SoftwareEd25519) {
    self.deviceId = deviceId
    self.noise = noise
    self.signing = signing
  }

  /// New keys for `deviceId`, replacing any.
  public static func create(deviceId: String, store: SecretStore, secureEnclave: Bool = SecureEnclave.isAvailable) throws -> DeviceKeys {
    let keys = DeviceKeys(deviceId: deviceId, noise: SoftwareX25519(), signing: SoftwareEd25519())
    let plain = JSON.object([
      ("device_id", .string(deviceId)), ("x25519", .string(Bytes.b64url(keys.noise.secret))), ("ed25519", .string(Bytes.b64url(keys.signing.secret))),
    ]).data
    var blob: Data
    if secureEnclave {
      let wrapKey = try newWrapKey()
      try store.set(wrapAccount, wrapKey.dataRepresentation, afterFirstUnlock: true)
      blob = Data([1]) + (try wrap(plain, to: wrapKey.publicKey))
    } else {
      try store.delete(wrapAccount)
      blob = Data([0]) + plain
    }
    try store.set(account, blob, afterFirstUnlock: true)
    return keys
  }

  /// This device's keys, or nil if they're gone or belong to another device id.
  public static func load(deviceId: String?, store: SecretStore) throws -> DeviceKeys? {
    guard let blob = try store.get(account), let tag = blob.first else { return nil }
    var plain: Data
    switch tag {
    case 0:
      plain = blob.dropFirst()
    case 1:
      guard let rep = try store.get(wrapAccount) else { return nil }
      let wrapKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: rep)
      plain = try unwrap(Data(blob.dropFirst()), with: wrapKey)
    default:
      return nil
    }
    let j = try JSON.parse(plain)
    guard let id = j["device_id"]?.string, deviceId == nil || id == deviceId,
      let x = j["x25519"]?.string, let ed = j["ed25519"]?.string
    else { return nil }
    return DeviceKeys(deviceId: id, noise: try SoftwareX25519(secret: try Bytes.fromB64url(x)), signing: try SoftwareEd25519(secret: try Bytes.fromB64url(ed)))
  }

  public static func destroy(store: SecretStore) throws {
    try store.delete(account)
    try store.delete(wrapAccount)
  }

  static func newWrapKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
      throw error!.takeRetainedValue() as Error
    }
    return try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
  }

  /// ECIES: an ephemeral P-256 agreement with the wrapping key, HKDF-SHA256, then AES-GCM.
  static func wrap(_ plain: Data, to recipient: P256.KeyAgreement.PublicKey) throws -> Data {
    let eph = P256.KeyAgreement.PrivateKey()
    let shared = try eph.sharedSecretFromKeyAgreement(with: recipient)
    let ephPub = eph.publicKey.x963Representation
    let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephPub, sharedInfo: wrapInfo, outputByteCount: 32)
    return ephPub + (try AES.GCM.seal(plain, using: key).combined!)
  }

  static func unwrap(_ blob: Data, with key: SecureEnclave.P256.KeyAgreement.PrivateKey) throws -> Data {
    guard blob.count > 65 else { throw ProtocolError.crypto("bad wrapped key") }
    let ephPub = blob.prefix(65)
    let shared = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: ephPub))
    let sym = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephPub, sharedInfo: wrapInfo, outputByteCount: 32)
    return try AES.GCM.open(AES.GCM.SealedBox(combined: blob.dropFirst(65)), using: sym)
  }
}
