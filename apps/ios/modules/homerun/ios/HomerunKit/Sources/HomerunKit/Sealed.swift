import Foundation

/// Sealed messages (§9.4): one-way Noise_K from the sender's pinned static key to the
/// recipient's, a port of `packages/protocol/src/sealed.ts` and `frames.ts`. The prologue binds
/// the whole clear header; every field is repeated, authenticated, inside.
public enum Sealed {
  public static let label = "homerun/sealed/v1"
  public static let version: Int64 = 1
  public static let maxBytes = 512 * 1024
  public static let clockSkewMs: Int64 = 5 * 60 * 1000
  public static let maxChunk = Noise.maxMessage - Primitives.tagLen - 1
  static let maxCiphertextChars = (maxBytes * 4 + 2) / 3

  public enum Kind: String, CaseIterable {
    case instruction, push, answer

    public var maxLifetimeMs: Int64 {
      switch self {
      case .instruction: return 72 * 60 * 60 * 1000
      case .push: return 24 * 60 * 60 * 1000
      case .answer: return 60 * 60 * 1000
      }
    }

    public var defaultLifetimeMs: Int64 {
      switch self {
      case .instruction: return 12 * 60 * 60 * 1000
      case .push: return 24 * 60 * 60 * 1000
      case .answer: return 60 * 60 * 1000
      }
    }
  }

  public enum RejectReason: String, CaseIterable {
    case malformed, unsupported_version, too_large, wrong_recipient, unknown_sender, decrypt_failed
    case sender_mismatch, header_mismatch, expired, from_future, lifetime_too_long, replayed
  }

  public struct Header: Equatable {
    public var kind: Kind
    public var msgId: String
    public var toDeviceId: String
    public var fromDeviceId: String
    public var expiresAt: Int64
    public var collapseId: String?

    public init(kind: Kind, msgId: String, toDeviceId: String, fromDeviceId: String, expiresAt: Int64, collapseId: String? = nil) {
      self.kind = kind
      self.msgId = msgId
      self.toDeviceId = toDeviceId
      self.fromDeviceId = fromDeviceId
      self.expiresAt = expiresAt
      self.collapseId = collapseId
    }

    public var json: JSON {
      var o: [(String, JSON)] = [
        ("v", .int(Sealed.version)), ("mode", .string("sealed")), ("kind", .string(kind.rawValue)), ("msg_id", .string(msgId)),
        ("to_device_id", .string(toDeviceId)), ("from_device_id", .string(fromDeviceId)), ("expires_at", .int(expiresAt)),
      ]
      if let collapseId { o.append(("collapse_id", .string(collapseId))) }
      return .object(o)
    }

    /// The header schema, strictly: no other keys.
    init?(strict j: JSON) {
      let allowed: Set<String> = ["v", "mode", "kind", "msg_id", "to_device_id", "from_device_id", "expires_at", "collapse_id"]
      guard j.object != nil, Set(j.keys).isSubset(of: allowed),
        j["v"]?.int == Sealed.version, j["mode"]?.string == "sealed",
        let kind = j["kind"]?.string.flatMap(Kind.init(rawValue:)),
        let msgId = j["msg_id"]?.string, Ids.isMsgId(msgId),
        let to = j["to_device_id"]?.string, Ids.isUUID(to),
        let from = j["from_device_id"]?.string, Ids.isUUID(from),
        let exp = j["expires_at"]?.int, Ids.isTimestamp(exp)
      else { return nil }
      var collapse: String?
      if let c = j["collapse_id"] {
        guard let s = c.string, Ids.isB64url(s, length: 22) else { return nil }
        collapse = s
      }
      self.init(kind: kind, msgId: msgId, toDeviceId: to, fromDeviceId: from, expiresAt: exp, collapseId: collapse)
    }

    public var prologue: Data {
      var parts: [FramedPart] = [.string(Sealed.label), .string(String(Sealed.version)), "sealed", .string(kind.rawValue), .string(msgId), .string(toDeviceId), .string(fromDeviceId), .string(String(expiresAt))]
      // Appended only when present, so headers without one keep their M9 prologue.
      if let collapseId { parts.append(.string(collapseId)) }
      return (try? Bytes.framed(parts)) ?? Data()
    }
  }

  public struct Envelope: Equatable {
    public var header: Header
    public var ciphertext: String
    public var json: JSON { .object([("header", header.json), ("ciphertext", .string(ciphertext))]) }
  }

  public enum OpenResult: Equatable {
    case ok(header: Header, inner: JSON)
    case rejected(RejectReason)
  }

  /// Seals arbitrary bytes under a header without checking they agree: for `seal` and vectors.
  public static func sealRaw(header: Header, plaintext: Data, sender: DhKey, recipientStatic: Data, ephemeral: DhKey? = nil, maxChunk: Int? = nil) throws -> Envelope {
    let hs = try HandshakeState(pattern: .K, initiator: true, prologue: header.prologue, s: sender, rs: recipientStatic, e: ephemeral)
    let first = try hs.writeMessage()
    let t = try hs.split()
    var messages = [first]
    let chunk = maxChunk ?? Sealed.maxChunk
    let pt = [UInt8](plaintext)
    var off = 0
    repeat {
      let end = min(off + chunk, pt.count)
      let piece = Data(pt[off..<end])
      off = end
      let last = off >= pt.count
      messages.append(try t.send!.encrypt(ad: Data(), plaintext: Data([last ? 0 : 1]) + piece))
    } while off < pt.count
    var bytes = Data()
    for m in messages {
      bytes.append(UInt8(m.count >> 8))
      bytes.append(UInt8(m.count & 0xff))
      bytes.append(m)
    }
    guard bytes.count <= maxBytes else { throw ProtocolError.noise("sealed message too large") }
    return Envelope(header: header, ciphertext: Bytes.b64url(bytes))
  }

  /// Seals `body` from this device to another, with a fresh msg_id and the kind's default lifetime.
  public static func seal(body: JSON, from: String, to: String, sender: DhKey, recipientStatic: Data, now: Int64, lifetimeMs: Int64? = nil, collapseId: String? = nil) throws -> Envelope {
    guard let kind = body["type"]?.string.flatMap(Kind.init(rawValue:)) else { throw ProtocolError.invalid("unknown body type") }
    if collapseId != nil && kind != .push { throw ProtocolError.noise("only pushes carry a collapse id") }
    let msgId = Bytes.b64url(Random.bytes(16))
    let expiresAt = now + (lifetimeMs ?? kind.defaultLifetimeMs)
    let inner = JSON.object([
      ("v", .int(version)), ("msg_id", .string(msgId)), ("sender_device_id", .string(from)),
      ("created_at", .int(now)), ("expires_at", .int(expiresAt)), ("body", body),
    ])
    guard validInner(inner) else { throw ProtocolError.invalid("not a valid sealed message") }
    let header = Header(kind: kind, msgId: msgId, toDeviceId: to, fromDeviceId: from, expiresAt: expiresAt, collapseId: collapseId)
    return try sealRaw(header: header, plaintext: inner.data, sender: sender, recipientStatic: recipientStatic)
  }

  /// Opens a sealed message and applies every check of §9.4, in the TypeScript's order.
  public static func open(_ raw: JSON, myDeviceId: String, myKey: DhKey, senderStatic: (String) -> Data?, now: Int64, seen: (String) -> Bool = { _ in false }) -> OpenResult {
    if let v = raw["header"]?["v"], v != .int(version) { return .rejected(.unsupported_version) }
    guard raw.object != nil, Set(raw.keys) == ["header", "ciphertext"] || Set(raw.keys).isSubset(of: ["header", "ciphertext"]),
      let hj = raw["header"], let header = Header(strict: hj),
      let ct = raw["ciphertext"]?.string, !ct.isEmpty, ct.utf8.allSatisfy(Ids.isB64urlChar)
    else { return .rejected(.malformed) }
    if ct.utf16.count > maxCiphertextChars { return .rejected(.too_large) }
    if header.toDeviceId != myDeviceId { return .rejected(.wrong_recipient) }
    guard let rs = senderStatic(header.fromDeviceId) else { return .rejected(.unknown_sender) }
    if now > header.expiresAt + clockSkewMs { return .rejected(.expired) }

    let plaintext: Data
    switch decrypt(header: header, ciphertext: ct, key: myKey, senderStatic: rs) {
    case .success(let p): plaintext = p
    case .failure(let r): return .rejected(r.reason)
    }

    guard let inner = try? JSON.parse(plaintext), inner.object != nil else { return .rejected(.malformed) }
    if inner["v"] != .int(version) { return .rejected(.unsupported_version) }
    guard validInner(inner) else { return .rejected(.malformed) }
    let sender = inner["sender_device_id"]!.string!
    let msgId = inner["msg_id"]!.string!
    let createdAt = inner["created_at"]!.int!
    let expiresAt = inner["expires_at"]!.int!
    let kind = Kind(rawValue: inner["body"]!["type"]!.string!)!
    if sender != header.fromDeviceId { return .rejected(.sender_mismatch) }
    if msgId != header.msgId || expiresAt != header.expiresAt || kind != header.kind || (header.collapseId != nil && header.kind != .push) {
      return .rejected(.header_mismatch)
    }
    if now > expiresAt + clockSkewMs { return .rejected(.expired) }
    if createdAt > now + clockSkewMs { return .rejected(.from_future) }
    if expiresAt - createdAt > kind.maxLifetimeMs { return .rejected(.lifetime_too_long) }
    if seen(msgId) { return .rejected(.replayed) }
    return .ok(header: header, inner: inner)
  }

  struct Rejection: Error { let reason: RejectReason }

  /// The framed Noise messages to the plaintext bytes.
  static func decrypt(header: Header, ciphertext ct: String, key: DhKey, senderStatic rs: Data) -> Result<Data, Rejection> {
    func no(_ r: RejectReason) -> Result<Data, Rejection> { .failure(Rejection(reason: r)) }
    guard let bytes = try? Bytes.fromB64url(ct) else { return no(.malformed) }
    if bytes.count > maxBytes { return no(.too_large) }
    let b = [UInt8](bytes)
    var messages: [Data] = []
    var off = 0
    while off < b.count {
      guard off + 2 <= b.count else { return no(.malformed) }
      let len = Int(b[off]) << 8 | Int(b[off + 1])
      guard off + 2 + len <= b.count else { return no(.malformed) }
      messages.append(Data(b[(off + 2)..<(off + 2 + len)]))
      off += 2 + len
    }
    if messages.count < 2 { return no(.malformed) }
    do {
      let hs = try HandshakeState(pattern: .K, initiator: false, prologue: header.prologue, s: key, rs: rs)
      if try hs.readMessage(messages[0]).count != 0 { return no(.malformed) }
      let recv = try hs.split().recv!
      var parts = Data()
      for (i, m) in messages.dropFirst().enumerated() {
        let pt = try recv.decrypt(ad: Data(), ciphertext: m)
        guard let flag = pt.first, flag == 0 || flag == 1 else { throw ProtocolError.noise("malformed fragment") }
        parts += pt.dropFirst()
        if parts.count > maxBytes { throw ProtocolError.noise("message too large") }
        if flag == 0 {
          if i != messages.count - 2 { return no(.malformed) }
          return .success(parts)
        }
      }
    } catch {
      return no(.decrypt_failed)
    }
    return no(.malformed)
  }

  /// `SealedInner` from `@homerun/core`: the fields this side reads, and every body's shape.
  static func validInner(_ j: JSON) -> Bool {
    guard j["v"] == .int(version),
      let msgId = j["msg_id"]?.string, Ids.isMsgId(msgId),
      let sender = j["sender_device_id"]?.string, Ids.isUUID(sender),
      let created = j["created_at"]?.int, Ids.isTimestamp(created),
      let expires = j["expires_at"]?.int, Ids.isTimestamp(expires), expires > created,
      let body = j["body"], body.object != nil
    else { return false }
    switch body["type"]?.string {
    case "instruction":
      guard let thread = body["thread_id"], thread == .null || (thread.string.map(Ids.isUUID) ?? false),
        let cm = body["client_msg_id"]?.string, Ids.isUUID(cm),
        let text = body["text"]?.string, (1...100_000).contains(text.utf16.count)
      else { return false }
      if let task = body["task_id"], !(task.string.map(Ids.isUUID) ?? false) { return false }
      return true
    case "push":
      return SealedPush(body) != nil
    case "answer":
      guard let rid = body["request_id"]?.string, Ids.isUUID(rid), body["via"]?.string == "notification",
        let type = body["response"]?["type"]?.string, type == "approval" || type == "question"
      else { return false }
      return true
    default:
      return false
    }
  }
}

/// Identifier formats from `@homerun/core`.
public enum Ids {
  public static func isUUID(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard b.count == 36 else { return false }
    for (i, c) in b.enumerated() {
      if i == 8 || i == 13 || i == 18 || i == 23 {
        if c != 45 { return false }
      } else if !((48...57).contains(c) || (97...102).contains(c)) {
        return false
      }
    }
    return true
  }

  static func isB64urlChar(_ c: UInt8) -> Bool {
    (65...90).contains(c) || (97...122).contains(c) || (48...57).contains(c) || c == 45 || c == 95
  }

  public static func isB64url(_ s: String, length: Int) -> Bool {
    s.utf8.count == length && s.utf8.allSatisfy(isB64urlChar)
  }

  public static func isMsgId(_ s: String) -> Bool { isB64url(s, length: 22) }

  static func isTimestamp(_ n: Int64) -> Bool { n >= 0 && n <= 9_007_199_254_740_991 }
}
