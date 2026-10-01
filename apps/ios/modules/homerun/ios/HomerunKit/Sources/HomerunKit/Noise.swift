import Foundation

/// The Noise Protocol Framework, revision 34, for Homerun's four patterns with
/// 25519_ChaChaPoly_SHA256: a port of `packages/protocol/src/noise.ts`, checked against the same
/// cacophony transcripts.
public enum Noise {
  public static let maxMessage = 65535

  public enum Pattern: String {
    case K, KK, IKpsk1, XX

    enum Token { case e, s, ee, es, se, ss, psk }

    var initiatorPre: Bool { self == .K || self == .KK }
    var responderPre: Bool { self != .XX }
    var oneWay: Bool { self == .K }
    var messages: [[Token]] {
      switch self {
      case .K: return [[.e, .es, .ss]]
      case .KK: return [[.e, .es, .ss], [.e, .ee, .se]]
      case .IKpsk1: return [[.e, .es, .s, .ss, .psk], [.e, .ee, .se]]
      case .XX: return [[.e], [.e, .ee, .s, .es], [.s, .se]]
      }
    }

    public var protocolName: String { "Noise_\(rawValue)_25519_ChaChaPoly_SHA256" }
  }
}

public final class CipherState {
  private var k: Data?
  private(set) public var nonce: UInt64 = 0

  init() {}

  func initializeKey(_ key: Data?) {
    k = key
    nonce = 0
  }

  var hasKey: Bool { k != nil }

  public func encrypt(ad: Data, plaintext: Data) throws -> Data {
    guard let k else { return plaintext }
    guard nonce < UInt64.max else { throw ProtocolError.noise("nonce exhausted") }
    let out = try Primitives.encrypt(key: k, nonce: nonce, ad: ad, plaintext: plaintext)
    nonce += 1
    return out
  }

  /// The nonce advances only on success, so a forged message can't desynchronise us.
  public func decrypt(ad: Data, ciphertext: Data) throws -> Data {
    guard let k else { return ciphertext }
    guard nonce < UInt64.max else { throw ProtocolError.noise("nonce exhausted") }
    let out = try Primitives.decrypt(key: k, nonce: nonce, ad: ad, ciphertext: ciphertext)
    nonce += 1
    return out
  }
}

final class SymmetricState {
  var ck: Data
  var h: Data
  let cipher = CipherState()

  init(name: String) {
    let n = Data(name.utf8)
    if n.count <= Primitives.hashLen {
      h = n + Data(count: Primitives.hashLen - n.count)
    } else {
      h = Primitives.sha256(n)
    }
    ck = h
  }

  func mixKey(_ ikm: Data) {
    let o = Primitives.noiseHkdf(chainingKey: ck, ikm: ikm, outputs: 2)
    ck = o[0]
    cipher.initializeKey(o[1])
  }

  func mixHash(_ data: Data) { h = Primitives.sha256(h + data) }

  func mixKeyAndHash(_ ikm: Data) {
    let o = Primitives.noiseHkdf(chainingKey: ck, ikm: ikm, outputs: 3)
    ck = o[0]
    mixHash(o[1])
    cipher.initializeKey(o[2])
  }

  func encryptAndHash(_ p: Data) throws -> Data {
    let c = try cipher.encrypt(ad: h, plaintext: p)
    mixHash(c)
    return c
  }

  func decryptAndHash(_ c: Data) throws -> Data {
    let p = try cipher.decrypt(ad: h, ciphertext: c)
    mixHash(c)
    return p
  }

  func split() -> (CipherState, CipherState) {
    let o = Primitives.noiseHkdf(chainingKey: ck, ikm: Data(), outputs: 2)
    let c1 = CipherState(), c2 = CipherState()
    c1.initializeKey(o[0])
    c2.initializeKey(o[1])
    return (c1, c2)
  }
}

public struct TransportPair {
  /// Encrypts what we send; nil for the responder of a one-way pattern.
  public let send: CipherState?
  /// Decrypts what we receive; nil for the initiator of a one-way pattern.
  public let recv: CipherState?
  public let handshakeHash: Data
  public let remoteStatic: Data
}

public final class HandshakeState {
  private let ss: SymmetricState
  private let pattern: Noise.Pattern
  public let initiator: Bool
  private let s: DhKey?
  private var e: DhKey?
  private var rs: Data?
  private var re: Data?
  private let psk: Data?
  private let hasPsk: Bool
  private var index = 0
  private var failed = false

  public init(pattern: Noise.Pattern, initiator: Bool, prologue: Data, s: DhKey? = nil, rs: Data? = nil, psk: Data? = nil, e: DhKey? = nil) throws {
    self.pattern = pattern
    self.initiator = initiator
    self.s = s
    self.e = e
    self.rs = rs
    self.psk = psk
    hasPsk = pattern.messages.contains { $0.contains(.psk) }
    if hasPsk && psk?.count != 32 { throw ProtocolError.noise("psk required (32 bytes)") }
    if !hasPsk && psk != nil { throw ProtocolError.noise("pattern has no psk") }
    let sends = pattern.messages.enumerated().contains { i, m in (i % 2 == 0) == initiator && m.contains(.s) }
    let needS = (initiator ? pattern.initiatorPre : pattern.responderPre) || sends
    if needS && s == nil { throw ProtocolError.noise("static key required") }
    let needRs = initiator ? pattern.responderPre : pattern.initiatorPre
    if needRs && rs?.count != Primitives.dhLen { throw ProtocolError.noise("remote static key required") }
    if !needRs && rs != nil { throw ProtocolError.noise("pattern does not take a remote static key in advance") }

    ss = SymmetricState(name: pattern.protocolName)
    ss.mixHash(prologue)
    if pattern.initiatorPre { ss.mixHash(initiator ? s!.publicKey : rs!) }
    if pattern.responderPre { ss.mixHash(initiator ? rs! : s!.publicKey) }
  }

  public var finished: Bool { index >= pattern.messages.count }
  public var myTurn: Bool { !finished && (index % 2 == 0) == initiator }
  public var handshakeHash: Data { ss.h }
  public var remoteStatic: Data? { rs }

  private func dh(_ ours: DhKey?, _ theirs: Data?) throws -> Data {
    guard let ours, let theirs else { throw ProtocolError.noise("missing key for DH") }
    return try ours.dh(theirs)
  }

  private func tokenDh(_ t: Noise.Pattern.Token) throws -> Data {
    switch t {
    case .ee: return try dh(e, re)
    case .ss: return try dh(s, rs)
    case .es: return initiator ? try dh(e, rs) : try dh(s, re)
    case .se: return initiator ? try dh(s, re) : try dh(e, rs)
    default: throw ProtocolError.noise("not a DH token")
    }
  }

  private func guardState() throws {
    if failed { throw ProtocolError.noise("handshake already failed") }
    if finished { throw ProtocolError.noise("handshake already finished") }
  }

  public func writeMessage(_ payload: Data = Data()) throws -> Data {
    try guardState()
    guard myTurn else { throw ProtocolError.noise("not our turn") }
    do {
      var out = Data()
      for t in pattern.messages[index] {
        switch t {
        case .e:
          if e == nil { e = SoftwareX25519() }
          let pub = e!.publicKey
          out += pub
          ss.mixHash(pub)
          if hasPsk { ss.mixKey(pub) }
        case .s:
          out += try ss.encryptAndHash(s!.publicKey)
        case .psk:
          ss.mixKeyAndHash(psk!)
        default:
          ss.mixKey(try tokenDh(t))
        }
      }
      out += try ss.encryptAndHash(payload)
      if out.count > Noise.maxMessage { throw ProtocolError.noise("message too long") }
      index += 1
      return out
    } catch {
      failed = true
      throw error
    }
  }

  public func readMessage(_ message: Data) throws -> Data {
    try guardState()
    guard !myTurn else { throw ProtocolError.noise("not their turn") }
    if message.count > Noise.maxMessage { throw ProtocolError.noise("message too long") }
    let m = [UInt8](message)
    var off = 0
    func take(_ n: Int) throws -> Data {
      guard off + n <= m.count else { throw ProtocolError.noise("message too short") }
      defer { off += n }
      return Data(m[off..<(off + n)])
    }
    do {
      for t in pattern.messages[index] {
        switch t {
        case .e:
          re = try take(Primitives.dhLen)
          ss.mixHash(re!)
          if hasPsk { ss.mixKey(re!) }
        case .s:
          let len = ss.cipher.hasKey ? Primitives.dhLen + Primitives.tagLen : Primitives.dhLen
          rs = try ss.decryptAndHash(try take(len))
        case .psk:
          ss.mixKeyAndHash(psk!)
        default:
          ss.mixKey(try tokenDh(t))
        }
      }
      let rest = Data(m[off...])
      if ss.cipher.hasKey && rest.count < Primitives.tagLen { throw ProtocolError.noise("message too short") }
      let payload = try ss.decryptAndHash(rest)
      index += 1
      return payload
    } catch let ProtocolError.crypto(msg) {
      failed = true
      throw ProtocolError.noise("handshake failed: \(msg)")
    } catch {
      failed = true
      throw error
    }
  }

  /// After the last message: the transport keys (§5.2 Split).
  public func split() throws -> TransportPair {
    guard finished, !failed else { throw ProtocolError.noise("handshake not finished") }
    guard let remote = rs else { throw ProtocolError.noise("no remote static key") }
    let (c1, c2) = ss.split()
    if pattern.oneWay {
      return initiator
        ? TransportPair(send: c1, recv: nil, handshakeHash: ss.h, remoteStatic: remote)
        : TransportPair(send: nil, recv: c1, handshakeHash: ss.h, remoteStatic: remote)
    }
    return initiator
      ? TransportPair(send: c1, recv: c2, handshakeHash: ss.h, remoteStatic: remote)
      : TransportPair(send: c2, recv: c1, handshakeHash: ss.h, remoteStatic: remote)
  }
}
