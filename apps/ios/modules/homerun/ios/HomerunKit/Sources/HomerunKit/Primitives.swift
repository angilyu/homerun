import CryptoKit
import Foundation

/// The suite 25519_ChaChaPoly_SHA256 (§9.4, §18 row 71) over CryptoKit, matching `crypto.ts`.
public enum Primitives {
  public static let dhLen = 32
  public static let hashLen = 32
  public static let tagLen = 16

  public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

  public static func hmacSha256(key: Data, _ data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  /// Noise's HKDF (§4.3): HMAC-SHA256 chained from the chaining key, 2 or 3 outputs.
  public static func noiseHkdf(chainingKey: Data, ikm: Data, outputs: Int) -> [Data] {
    let tempKey = hmacSha256(key: chainingKey, ikm)
    var out: [Data] = []
    var prev = Data()
    for i in 1...outputs {
      prev = hmacSha256(key: tempKey, prev + Data([UInt8(i)]))
      out.append(prev)
    }
    return out
  }

  /// Noise's ChaChaPoly nonce: 32 zero bits, then the counter as u64 little-endian.
  static func nonce(_ n: UInt64) throws -> ChaChaPoly.Nonce {
    var bytes = Data(count: 4)
    withUnsafeBytes(of: n.littleEndian) { bytes.append(contentsOf: $0) }
    return try ChaChaPoly.Nonce(data: bytes)
  }

  /// Ciphertext with its tag appended.
  public static func encrypt(key: Data, nonce n: UInt64, ad: Data, plaintext: Data) throws -> Data {
    let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: nonce(n), authenticating: ad)
    // Fresh, zero-based bytes: `box.ciphertext` is a slice of the box's storage.
    var out = Data(capacity: box.ciphertext.count + tagLen)
    out.append(contentsOf: box.ciphertext)
    out.append(contentsOf: box.tag)
    return out
  }

  public static func decrypt(key: Data, nonce n: UInt64, ad: Data, ciphertext: Data) throws -> Data {
    guard ciphertext.count >= tagLen else { throw ProtocolError.crypto("ciphertext too short") }
    let ct = ciphertext.prefix(ciphertext.count - tagLen)
    let tag = ciphertext.suffix(tagLen)
    do {
      let box = try ChaChaPoly.SealedBox(nonce: nonce(n), ciphertext: ct, tag: tag)
      return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
    } catch {
      throw ProtocolError.crypto("decryption failed")
    }
  }
}

/// An X25519 key that can do Diffie-Hellman; its secret may live anywhere (here, or in the Keychain).
public protocol DhKey {
  var publicKey: Data { get }
  func dh(_ theirPublic: Data) throws -> Data
}

public struct SoftwareX25519: DhKey {
  public let key: Curve25519.KeyAgreement.PrivateKey

  public init() { key = Curve25519.KeyAgreement.PrivateKey() }
  public init(secret: Data) throws {
    guard secret.count == 32 else { throw ProtocolError.crypto("bad X25519 key length") }
    key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
  }

  public var publicKey: Data { key.publicKey.rawRepresentation }
  public var secret: Data { key.rawRepresentation }

  public func dh(_ theirPublic: Data) throws -> Data {
    guard theirPublic.count == Primitives.dhLen else { throw ProtocolError.crypto("invalid public key") }
    let shared: SharedSecret
    do {
      shared = try key.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirPublic))
    } catch {
      throw ProtocolError.crypto("invalid public key")
    }
    let out = shared.withUnsafeBytes { Data($0) }
    // A low-order point gives all zeros: refuse it, as the TypeScript does.
    if out.count != Primitives.dhLen || out.allSatisfy({ $0 == 0 }) { throw ProtocolError.crypto("invalid public key") }
    return out
  }
}

/// An Ed25519 key that signs this device's relay requests (§12).
public protocol SigningKey {
  var publicKey: Data { get }
  func sign(_ message: Data) throws -> Data
}

public struct SoftwareEd25519: SigningKey {
  public let key: Curve25519.Signing.PrivateKey

  public init() { key = Curve25519.Signing.PrivateKey() }
  public init(secret: Data) throws {
    guard secret.count == 32 else { throw ProtocolError.crypto("bad signing key length") }
    key = try Curve25519.Signing.PrivateKey(rawRepresentation: secret)
  }

  public var publicKey: Data { key.publicKey.rawRepresentation }
  public var secret: Data { key.rawRepresentation }
  public func sign(_ message: Data) throws -> Data { try key.signature(for: message) }

  public static func verify(publicKey: Data, signature: Data, message: Data) -> Bool {
    guard let k = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
    return k.isValidSignature(signature, for: message)
  }
}
