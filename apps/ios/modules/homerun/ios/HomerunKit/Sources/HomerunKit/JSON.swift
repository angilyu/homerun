import Foundation

/// A JSON value. Objects keep the order they were built in, so what this side writes is stable;
/// parsing doesn't promise the sender's order (nothing here depends on it).
public indirect enum JSON: Equatable {
  case null
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case string(String)
  case array([JSON])
  case object([(String, JSON)])

  public static func == (a: JSON, b: JSON) -> Bool {
    switch (a, b) {
    case (.null, .null): return true
    case let (.bool(x), .bool(y)): return x == y
    case let (.int(x), .int(y)): return x == y
    case let (.double(x), .double(y)): return x == y
    case let (.int(x), .double(y)), let (.double(y), .int(x)): return Double(x) == y
    case let (.string(x), .string(y)): return x == y
    case let (.array(x), .array(y)): return x == y
    case let (.object(x), .object(y)):
      // Order-insensitive, like comparing two parsed JSON objects.
      guard x.count == y.count else { return false }
      let ym = Dictionary(y, uniquingKeysWith: { a, _ in a })
      return x.allSatisfy { k, v in ym[k] == v }
    default: return false
    }
  }

  public subscript(key: String) -> JSON? {
    if case .object(let pairs) = self { return pairs.first { $0.0 == key }?.1 }
    return nil
  }

  public var string: String? { if case .string(let s) = self { return s } else { return nil } }
  public var int: Int64? { if case .int(let n) = self { return n } else { return nil } }
  public var bool: Bool? { if case .bool(let b) = self { return b } else { return nil } }
  public var array: [JSON]? { if case .array(let a) = self { return a } else { return nil } }
  public var object: [(String, JSON)]? { if case .object(let o) = self { return o } else { return nil } }
  public var keys: [String] { object?.map(\.0) ?? [] }

  /// Strict: the bytes must be valid UTF-8 and one JSON value.
  public static func parse(_ data: Data) throws -> JSON {
    guard Bytes.fromUtf8(data) != nil else { throw ProtocolError.invalid("not UTF-8") }
    let any: Any
    do {
      any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    } catch {
      throw ProtocolError.invalid("not JSON")
    }
    return try from(any)
  }

  public static func parse(_ s: String) throws -> JSON { try parse(Data(s.utf8)) }

  /// From what `JSONSerialization` or a notification's `userInfo` holds.
  public static func from(_ any: Any) throws -> JSON {
    switch any {
    case is NSNull: return .null
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
      if CFNumberIsFloatType(n) {
        let d = n.doubleValue
        if d.rounded() == d, abs(d) < 9_007_199_254_740_992 { return .int(Int64(d)) }
        return .double(d)
      }
      return .int(n.int64Value)
    case let s as String: return .string(s)
    case let a as [Any]: return .array(try a.map(from))
    case let o as [String: Any]: return .object(try o.sorted { $0.key < $1.key }.map { ($0.key, try from($0.value)) })
    default: throw ProtocolError.invalid("not JSON")
    }
  }

  /// Compact JSON, as `JSON.stringify` writes it.
  public var serialized: String {
    var out = ""
    write(&out)
    return out
  }

  public var data: Data { Data(serialized.utf8) }

  private func write(_ out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let b): out += b ? "true" : "false"
    case .int(let n): out += String(n)
    case .double(let d): out += d.isFinite ? String(d) : "null"
    case .string(let s): JSON.quote(s, &out)
    case .array(let a):
      out += "["
      for (i, v) in a.enumerated() {
        if i > 0 { out += "," }
        v.write(&out)
      }
      out += "]"
    case .object(let o):
      out += "{"
      for (i, (k, v)) in o.enumerated() {
        if i > 0 { out += "," }
        JSON.quote(k, &out)
        out += ":"
        v.write(&out)
      }
      out += "}"
    }
  }

  private static func quote(_ s: String, _ out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
      switch u {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      default:
        if u.value < 0x20 {
          out += String(format: "\\u%04x", u.value)
        } else {
          out.unicodeScalars.append(u)
        }
      }
    }
    out += "\""
  }
}
