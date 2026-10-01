import Foundation
import HomerunKit
import UIKit

/// What the JavaScript module and the notification delegate share in the app's process: the
/// Keychain groups, the one token owner, and the configuration the JavaScript last set (kept in
/// `UserDefaults` so a lock-screen answer can be sent before any JavaScript has run).
enum Shared {
  /// The group shared with the Notification Service Extension: device keys, tokens, remote state.
  static let keychain = Keychain.shared
  /// The app's own group: the cache key, which the extension never needs.
  static let appKeychain = Keychain(accessGroup: Bundle.main.object(forInfoDictionaryKey: "HomerunAppKeychainGroup") as? String)
  static let tokens = TokenOwner(store: Keychain.shared)

  struct Config: Codable, Equatable {
    var relayUrl: String
    var issuer: String
    var clientId: String
    var redirectUri: String
    var authParams: [String: String]
    /// A development build talking to a local issuer over plain HTTP on loopback.
    var dev: Bool

    var oidc: OidcConfig {
      OidcConfig(issuer: issuer, clientId: clientId, redirectUri: redirectUri, authParams: authParams, allowInsecureLoopback: dev)
    }
  }

  private static let configKey = "homerun.config"

  static func save(_ c: Config) {
    UserDefaults.standard.set(try? JSONEncoder().encode(c), forKey: configKey)
  }

  static var config: Config? {
    guard let d = UserDefaults.standard.data(forKey: configKey) else { return nil }
    return try? JSONDecoder().decode(Config.self, from: d)
  }

  /// Configures the token owner from the saved configuration; false if the app never set one.
  @discardableResult
  static func configureTokens() async -> Bool {
    guard let c = config else { return false }
    await tokens.configure(c.oidc)
    return true
  }

  static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

  /// The APNs environment this build's entitlement names, as the relay spells it.
  static var pushEnvironment: String {
    (Bundle.main.object(forInfoDictionaryKey: "HomerunApsEnvironment") as? String) == "production" ? "production" : "sandbox"
  }

  // MARK: - Events for JavaScript

  private static let lock = NSLock()
  private static var pendingTap: [String: String]?
  private static var pendingToken: [String: String]?

  /// A notification the person tapped: kept until JavaScript takes it, so a tap that launched
  /// the app isn't lost while the bundle loads.
  static func tapped(_ info: [String: String]) {
    lock.lock()
    pendingTap = info
    lock.unlock()
    DispatchQueue.main.async { HomerunModule.current?.sendEvent("pushTap", info) }
  }

  static func takeTap() -> [String: String]? {
    lock.lock()
    defer { lock.unlock() }
    let t = pendingTap
    pendingTap = nil
    return t
  }

  static func registered(token: String) {
    let e = ["token": token, "environment": pushEnvironment]
    lock.lock()
    pendingToken = e
    lock.unlock()
    DispatchQueue.main.async { HomerunModule.current?.sendEvent("pushToken", e) }
  }

  static var lastToken: [String: String]? {
    lock.lock()
    defer { lock.unlock() }
    return pendingToken
  }

  static func registrationFailed(_ message: String) {
    DispatchQueue.main.async { HomerunModule.current?.sendEvent("pushError", ["message": message]) }
  }
}
