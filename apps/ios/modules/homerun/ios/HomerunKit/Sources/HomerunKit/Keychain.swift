import Foundation
import Security

/// Generic-password items in the Keychain group the app shares with its extension (§9.8).
/// Everything is `ThisDeviceOnly`: never in a backup, never on another device.
public struct Keychain {
  public static let service = "com.angilyu.homerun"

  /// The full access group, team prefix included; nil uses the app's default group (tests).
  public let accessGroup: String?

  public init(accessGroup: String?) { self.accessGroup = accessGroup }

  /// The group named in Info.plist (`HomerunKeychainGroup`), which the config plugin sets.
  public static var shared: Keychain {
    Keychain(accessGroup: Bundle.main.object(forInfoDictionaryKey: "HomerunKeychainGroup") as? String)
  }

  private func base(_ account: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Keychain.service,
      kSecAttrAccount as String: account,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    return q
  }

  /// `afterFirstUnlock` lets the extension read it while the phone is locked; otherwise
  /// `whenUnlocked`.
  public func set(_ account: String, _ data: Data, afterFirstUnlock: Bool) throws {
    let accessible = afterFirstUnlock ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: accessible]
    var status = SecItemUpdate(base(account) as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = base(account)
      add.merge(update) { _, b in b }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw KeychainError.status(status) }
  }

  public func get(_ account: String) throws -> Data? {
    var q = base(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError.status(status) }
    return out as? Data
  }

  public func delete(_ account: String) throws {
    let status = SecItemDelete(base(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
  }

  /// Every item this app stored under its service in this group.
  public func deleteAll() throws {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Keychain.service,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    let status = SecItemDelete(q as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
  }
}

public enum KeychainError: Error, Equatable {
  case status(OSStatus)
}

/// The remote state, stored whole as JSON.
public enum RemoteStateStore {
  static let account = "remote-state"

  public static func load(_ kc: Keychain = .shared) throws -> String? {
    try kc.get(account).flatMap { String(data: $0, encoding: .utf8) }
  }

  public static func save(_ json: String, _ kc: Keychain = .shared) throws {
    try kc.set(account, Data(json.utf8), afterFirstUnlock: true)
  }

  public static func clear(_ kc: Keychain = .shared) throws { try kc.delete(account) }

  public static func read(_ kc: Keychain = .shared) -> RemoteState? {
    guard let s = try? load(kc), let j = try? JSON.parse(s) else { return nil }
    return RemoteState(json: j)
  }
}
