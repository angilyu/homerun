import ExpoModulesCore
import HomerunKit
import UIKit
import UserNotifications

/// The iPhone app's native half, as JavaScript sees it (`modules/homerun/index.ts`). JavaScript
/// never holds a secret: the device keys answer `dh` and `sign`, the token owner hands out access
/// tokens, the approval key signs only after Face ID. Binary values cross as base64url strings.
public final class HomerunModule: Module {
  static weak var current: HomerunModule?

  private let held = Held()

  public func definition() -> ModuleDefinition {
    Name("Homerun")

    Events("pushToken", "pushTap", "pushError")

    OnCreate { HomerunModule.current = self }

    Constants([
      "pushEnvironment": Shared.pushEnvironment,
      "appAttestSupported": AppAttest.isSupported,
    ])

    // MARK: configuration

    AsyncFunction("configure") { (json: String) async throws in
      guard let c = try? JSONDecoder().decode(Shared.Config.self, from: Data(json.utf8)) else { throw fail("CONFIG", "bad configuration") }
      // Keychain items outlive the app; UserDefaults don't. The first launch after an install
      // starts clean, rather than as the device (and the account) a deleted copy left behind.
      if Shared.config == nil {
        self.held.keys = nil
        try? ApprovalKey.destroy(store: Shared.keychain)
        try? Shared.keychain.deleteAll()
        try? Shared.appKeychain.deleteAll()
      }
      Shared.save(c)
      await Shared.tokens.configure(c.oidc)
    }

    // MARK: device keys (§12)

    AsyncFunction("keysCreate") { (deviceId: String) throws -> [String: String] in
      let k = try DeviceKeys.create(deviceId: deviceId, store: Shared.keychain)
      self.held.keys = k
      return Self.publicKeys(k)
    }

    AsyncFunction("keysLoad") { (deviceId: String) throws -> [String: String]? in
      guard let k = try DeviceKeys.load(deviceId: deviceId, store: Shared.keychain) else { return nil }
      self.held.keys = k
      return Self.publicKeys(k)
    }

    AsyncFunction("keysDestroy") { () throws in
      self.held.keys = nil
      try DeviceKeys.destroy(store: Shared.keychain)
    }

    AsyncFunction("keysDh") { (peer: String) throws -> String in
      Bytes.b64url(try self.keys().noise.dh(try Bytes.fromB64url(peer)))
    }

    AsyncFunction("keysSign") { (message: String) throws -> String in
      Bytes.b64url(try self.keys().signing.sign(try Bytes.fromB64url(message)))
    }

    // MARK: stores

    AsyncFunction("stateLoad") { () throws -> String? in try RemoteStateStore.load(Shared.keychain) }
    AsyncFunction("stateSave") { (json: String) throws in try RemoteStateStore.save(json, Shared.keychain) }
    AsyncFunction("stateClear") { () throws in try RemoteStateStore.clear(Shared.keychain) }

    /// Small app records (which desktop pinned which keys), `WhenUnlockedThisDeviceOnly`.
    AsyncFunction("kvGet") { (name: String) throws -> String? in
      try Shared.appKeychain.get("kv." + name).map { String(decoding: $0, as: UTF8.self) }
    }

    AsyncFunction("kvSet") { (name: String, value: String?) throws in
      if let value {
        try Shared.appKeychain.set("kv." + name, Data(value.utf8), afterFirstUnlock: false)
      } else {
        try Shared.appKeychain.delete("kv." + name)
      }
    }

    /// The SQLCipher key for the history cache: 32 random bytes, made once, hex.
    AsyncFunction("cacheKey") { () throws -> String in
      let account = "cache-key"
      if let k = try Shared.appKeychain.get(account), k.count == 32 { return Bytes.hex(k) }
      let k = Random.bytes(32)
      try Shared.appKeychain.set(account, k, afterFirstUnlock: false)
      return Bytes.hex(k)
    }

    /// Forgets everything this app stored: keys, tokens, state, approval key, cache key.
    /// Forgets this device but keeps the sign-in: a different person signed in on this phone.
    AsyncFunction("resetDevice") { () throws in
      self.held.keys = nil
      try? ApprovalKey.destroy(store: Shared.keychain)
      try DeviceKeys.destroy(store: Shared.keychain)
      try RemoteStateStore.clear(Shared.keychain)
      try Shared.appKeychain.deleteAll()
    }

    AsyncFunction("wipe") { () async throws in
      self.held.keys = nil
      try? ApprovalKey.destroy(store: Shared.keychain)
      try Shared.keychain.deleteAll()
      try Shared.appKeychain.deleteAll()
      await MainActor.run {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UIApplication.shared.unregisterForRemoteNotifications()
      }
    }

    // MARK: account (§10)

    AsyncFunction("authState") { () async -> [String: String]? in
      Self.signedIn(await Shared.tokens.state)
    }

    /// Signs in in `ASWebAuthenticationSession`; nil if the person closed the page.
    AsyncFunction("authSignIn") { () async throws -> [String: String]? in
      guard let c = Shared.config, let scheme = URL(string: c.redirectUri)?.scheme else { throw fail("CONFIG", "sign-in isn't configured") }
      do {
        let url = try await Shared.tokens.begin()
        guard let callback = try await WebAuth.shared.run(url, callbackScheme: scheme) else {
          await Shared.tokens.cancelSignIn()
          return nil
        }
        return Self.signedIn(try await Shared.tokens.complete(callback: callback))
      } catch {
        await Shared.tokens.cancelSignIn()
        throw Self.mapped(error)
      }
    }

    AsyncFunction("authAccessToken") { () async throws -> String in
      do { return try await Shared.tokens.accessToken() } catch { throw Self.mapped(error) }
    }

    AsyncFunction("authRefresh") { () async throws -> String in
      do { return try await Shared.tokens.refresh().accessToken } catch { throw Self.mapped(error) }
    }

    AsyncFunction("authSignOut") { () async in await Shared.tokens.signOut() }

    // MARK: App Attest and the approval key (§9.8)

    /// `{key_id, object, approval_key?}` as JSON, or nil where App Attest isn't available.
    AsyncFunction("attest") { (deviceId: String, staticKey: String, signingKey: String, approvalKey: String?) async throws -> String? in
      guard let j = try await AppAttest.attest(deviceId: deviceId, staticKey: staticKey, signingKey: signingKey, approvalKey: approvalKey) else { return nil }
      return String(decoding: j.data, as: UTF8.self)
    }

    AsyncFunction("assertRenewal") { (keyId: String, deviceId: String, approvalKey: String) async throws -> String? in
      try await AppAttest.assertRenewal(keyId: keyId, deviceId: deviceId, approvalKey: approvalKey)
    }

    AsyncFunction("approvalKeyPublic") { () -> String? in ApprovalKey.publicKey(store: Shared.keychain) }
    AsyncFunction("approvalKeyCreate") { () throws -> String? in try ApprovalKey.create(store: Shared.keychain) }

    /// Face ID, then the approval signature (DER, base64url); nil if the person cancelled.
    /// Throws `APPROVAL_KEY_UNUSABLE` when the key is gone or a biometry change invalidated it.
    AsyncFunction("approvalSign") { (deviceId: String, desktopId: String, requestId: String, decision: String, expiresAt: Double, reason: String) async throws -> String? in
      let message = try Approval.message(deviceId: deviceId, desktopId: desktopId, requestId: requestId, decision: decision, expiresAt: Int64(expiresAt))
      do {
        return try await ApprovalKey.sign(message, reason: reason, store: Shared.keychain)
      } catch {
        throw fail("APPROVAL_KEY_UNUSABLE", "This iPhone’s Face ID key can’t be used.")
      }
    }

    // MARK: notifications (§9.7)

    /// Asks to show notifications, then registers with APNs; the token arrives as `pushToken`.
    AsyncFunction("pushRegister") { () async throws -> Bool in
      let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
      if granted { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
      return granted
    }

    AsyncFunction("pushLastToken") { () -> [String: String]? in Shared.lastToken }

    /// The notification tap that's waiting for JavaScript, if any.
    AsyncFunction("takeTap") { () -> [String: String]? in Shared.takeTap() }

    AsyncFunction("clearDelivered") { (requestId: String) async in
      await Notifications.removeDelivered(requestId: requestId)
    }
  }

  private func keys() throws -> DeviceKeys {
    guard let k = held.keys else { throw fail("NO_KEYS", "this device's keys aren't loaded") }
    return k
  }

  private static func publicKeys(_ k: DeviceKeys) -> [String: String] {
    ["noise": Bytes.b64url(k.noise.publicKey), "signing": Bytes.b64url(k.signing.publicKey)]
  }

  private static func signedIn(_ s: TokenOwner.State) -> [String: String]? {
    guard case let .signedIn(subject, email) = s else { return nil }
    var o = ["subject": subject]
    if let email { o["email"] = email }
    return o
  }

  /// A sign-in that ended becomes `SIGNED_OUT`, so JavaScript can tell it from a network error.
  private static func mapped(_ e: Error) -> Error {
    if let o = e as? OidcError {
      return fail(o.code == "signed_out" ? "SIGNED_OUT" : "OIDC", o.message, oidcCode: o.code)
    }
    return e
  }

}

private func fail(_ code: String, _ message: String, oidcCode: String? = nil) -> Exception {
  Exception(name: "HomerunError", description: oidcCode.map { "\(message) (\($0))" } ?? message, code: code)
}

/// The loaded device keys, behind a lock: module functions run concurrently.
private final class Held: @unchecked Sendable {
  private let lock = NSLock()
  private var _keys: DeviceKeys?
  var keys: DeviceKeys? {
    get { lock.lock(); defer { lock.unlock() }; return _keys }
    set { lock.lock(); _keys = newValue; lock.unlock() }
  }
}
