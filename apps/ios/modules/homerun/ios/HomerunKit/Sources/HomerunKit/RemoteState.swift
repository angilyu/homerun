import Foundation

/// The parts of `@homerun/remote`'s `RemoteState` the extension needs: this device's id and the
/// pinned desktops' static keys. The app owns the state (as JSON in the shared Keychain); the
/// extension only reads it.
public struct RemoteState {
  public let deviceId: String
  public let desktops: [String: (name: String, staticKey: Data)]
  public let seen: Set<String>

  public init(deviceId: String, desktops: [String: (name: String, staticKey: Data)], seen: Set<String>) {
    self.deviceId = deviceId
    self.desktops = desktops
    self.seen = seen
  }

  public init?(json: JSON) {
    guard let id = json["device"]?["device_id"]?.string, Ids.isUUID(id) else { return nil }
    var desktops: [String: (String, Data)] = [:]
    for (k, v) in json["desktops"]?.object ?? [] {
      guard let s = v["static_public_key"]?.string, let key = try? Bytes.fromB64url(s), key.count == 32 else { continue }
      desktops[k] = (v["name"]?.string ?? "", key)
    }
    deviceId = id
    self.desktops = desktops
    seen = Set((json["seen"]?.object ?? []).map(\.0))
  }

  public func desktopStatic(_ deviceId: String) -> Data? { desktops[deviceId]?.staticKey }
}
