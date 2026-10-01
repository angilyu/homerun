import Foundation

/// Encodings shared with `packages/protocol/src/bytes.ts`, byte for byte.
public enum Bytes {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
  private static let reverse: [UInt8: UInt32] = {
    var m: [UInt8: UInt32] = [:]
    for (i, c) in alphabet.enumerated() { m[c] = UInt32(i) }
    return m
  }()

  /// Base64url without padding.
  public static func b64url(_ data: Data) -> String {
    var out = [UInt8]()
    out.reserveCapacity((data.count * 4 + 2) / 3)
    var acc: UInt32 = 0
    var bits = 0
    for b in data {
      acc = (acc << 8) | UInt32(b)
      bits += 8
      while bits >= 6 {
        bits -= 6
        out.append(alphabet[Int((acc >> UInt32(bits)) & 63)])
      }
      acc &= (1 << UInt32(bits)) - 1
    }
    if bits > 0 { out.append(alphabet[Int((acc << UInt32(6 - bits)) & 63)]) }
    return String(decoding: out, as: UTF8.self)
  }

  /// Strict base64url: no padding, no other characters, canonical trailing bits.
  public static func fromB64url(_ s: String) throws -> Data {
    let chars = Array(s.utf8)
    if chars.count % 4 == 1 { throw ProtocolError.encoding("invalid base64url length") }
    var out = Data()
    out.reserveCapacity(chars.count * 3 / 4)
    var acc: UInt32 = 0
    var bits = 0
    for c in chars {
      guard let v = reverse[c] else { throw ProtocolError.encoding("invalid base64url character") }
      acc = (acc << 6) | v
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((acc >> UInt32(bits)) & 0xff))
        acc &= (1 << UInt32(bits)) - 1
      }
    }
    if bits > 0 && acc != 0 { throw ProtocolError.encoding("non-canonical base64url") }
    return out
  }

  public static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  public static func fromHex(_ s: String) throws -> Data {
    let chars = Array(s.utf8)
    guard chars.count % 2 == 0 else { throw ProtocolError.encoding("odd hex length") }
    var out = Data(capacity: chars.count / 2)
    var i = 0
    while i < chars.count {
      guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { throw ProtocolError.encoding("invalid hex") }
      out.append(hi << 4 | lo)
      i += 2
    }
    return out
  }

  private static func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case 48...57: return c - 48
    case 97...102: return c - 87
    case 65...70: return c - 55
    default: return nil
    }
  }

  /// Each part as a u16 big-endian length and its bytes (strings as UTF-8): unambiguous concatenation.
  public static func framed(_ parts: [FramedPart]) throws -> Data {
    var out = Data()
    for p in parts {
      let b = p.bytes
      guard b.count <= 0xffff else { throw ProtocolError.encoding("field too long") }
      out.append(UInt8(b.count >> 8))
      out.append(UInt8(b.count & 0xff))
      out.append(b)
    }
    return out
  }

  public static func utf8(_ s: String) -> Data { Data(s.utf8) }

  /// Strict UTF-8: nil for invalid sequences rather than replacement characters.
  public static func fromUtf8(_ d: Data) -> String? { String(data: d, encoding: .utf8) }

  public static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for (x, y) in zip(a, b) { diff |= x ^ y }
    return diff == 0
  }
}

public enum FramedPart: ExpressibleByStringLiteral {
  case string(String)
  case bytes(Data)

  public init(stringLiteral value: String) { self = .string(value) }

  var bytes: Data {
    switch self {
    case .string(let s): return Data(s.utf8)
    case .bytes(let d): return d
    }
  }
}

public enum ProtocolError: Error, Equatable {
  case encoding(String)
  case crypto(String)
  case noise(String)
  case invalid(String)
}
