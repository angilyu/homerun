import Foundation

/// Relay request signing (§9.4), from `packages/protocol/src/wire.ts`.
public enum Wire {
  public static let authLabel = "homerun/relay-auth/v1"
  public static let requestLabel = "homerun/relay-request/v1"
  public static let proofHeader = "homerun-device"
  public static let sealedPath = "/v1/sealed"

  public static func challengeBytes(nonce: String, deviceId: String) throws -> Data {
    try Bytes.framed([.string(authLabel), .string(nonce), .string(deviceId)])
  }

  public static func requestBytes(deviceId: String, ts: Int64, method: String, path: String, body: Data) throws -> Data {
    try Bytes.framed([.string(requestLabel), .string(deviceId), .string(String(ts)), .string(method.uppercased()), .string(path), .string(Bytes.b64url(Primitives.sha256(body)))])
  }

  public static func signRequest(key: SigningKey, deviceId: String, ts: Int64, method: String, path: String, body: Data) throws -> String {
    "\(deviceId).\(ts).\(Bytes.b64url(try key.sign(requestBytes(deviceId: deviceId, ts: ts, method: method, path: path, body: body))))"
  }

  /// A signed relay request with a bearer token.
  public static func request(relay: URL, method: String, path: String, body: JSON?, token: String, deviceId: String, key: SigningKey, now: Int64) throws -> URLRequest {
    let bytes = body?.data ?? Data()
    guard let url = URL(string: relay.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw ProtocolError.invalid("bad relay URL") }
    var r = URLRequest(url: url)
    r.httpMethod = method
    r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    r.setValue(try signRequest(key: key, deviceId: deviceId, ts: now, method: method, path: path, body: bytes), forHTTPHeaderField: proofHeader)
    if body != nil {
      r.setValue("application/json", forHTTPHeaderField: "content-type")
      r.httpBody = bytes
    }
    return r
  }
}

/// Lock-screen answers (§9.7): one sealed answer in one HTTPS POST, from the action handler,
/// without starting the app's JavaScript.
public enum LockScreenAnswer {
  /// The response an action id stands for: `allow`/`deny` for approvals, `option:<i>` for a
  /// single-choice question whose labels all fit a button.
  public static func response(actionId: String, actions: [SealedPush.Action]) -> JSON? {
    guard let action = actions.first(where: { $0.id == actionId }) else { return nil }
    switch actionId {
    case "allow", "deny":
      return .object([("type", .string("approval")), ("decision", .string(actionId))])
    default:
      guard actionId.hasPrefix("option:") else { return nil }
      return .object([("type", .string("question")), ("answers", .array([.object([("selected", .array([.string(action.label)]))])]))])
    }
  }

  public static func seal(requestId: String, response: JSON, myDeviceId: String, desktopId: String, key: DhKey, desktopStatic: Data, now: Int64) throws -> Sealed.Envelope {
    let body = JSON.object([("type", .string("answer")), ("request_id", .string(requestId)), ("response", response), ("via", .string("notification"))])
    return try Sealed.seal(body: body, from: myDeviceId, to: desktopId, sender: key, recipientStatic: desktopStatic, now: now)
  }

  public static func request(envelope: Sealed.Envelope, relay: URL, token: String, deviceId: String, key: SigningKey, now: Int64) throws -> URLRequest {
    try Wire.request(relay: relay, method: "POST", path: Wire.sealedPath, body: .object([("envelope", envelope.json)]), token: token, deviceId: deviceId, key: key, now: now)
  }
}
