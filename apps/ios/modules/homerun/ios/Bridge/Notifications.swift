import ExpoModulesCore
import HomerunKit
import UIKit
import UserNotifications

/// Hooks the app delegate (through Expo's subscriber list) to own `UNUserNotificationCenter`'s
/// delegate from launch, and to receive the APNs device token.
public final class HomerunAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = Notifications.shared
    return true
  }

  public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Shared.registered(token: Bytes.hex(deviceToken))
  }

  public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    Shared.registrationFailed(error.localizedDescription)
  }
}

/// The notification center's delegate (§9.7). A tap opens the app at the request; a lock-screen
/// button answers natively, as one sealed HTTPS POST to the relay, with no JavaScript and no live
/// session. The Notification Service Extension has already decrypted what's shown.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifications()

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    // The open app shows its own inbox; a banner still says something arrived.
    [.banner, .list]
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let info = response.notification.request.content.userInfo
    switch response.actionIdentifier {
    case UNNotificationDismissActionIdentifier:
      return
    case UNNotificationDefaultActionIdentifier:
      var tap: [String: String] = [:]
      for k in ["hr_desktop", "hr_thread", "hr_request", "hr_category"] {
        if let v = info[k] as? String { tap[String(k.dropFirst(3))] = v }
      }
      Shared.tapped(tap)
    default:
      await answer(actionId: response.actionIdentifier, info: info)
    }
  }

  /// Sends a lock-screen answer. On any failure it says so in a notification: the request is
  /// still waiting, and the app can answer it.
  private func answer(actionId: String, info: [AnyHashable: Any]) async {
    guard let desktopId = info["hr_desktop"] as? String, let requestId = info["hr_request"] as? String,
      let response = LockScreenAnswer.response(actionId: actionId, actions: PushPresentation.actions(userInfo: info))
    else { return }
    let task = await MainActor.run { UIApplication.shared.beginBackgroundTask(withName: "homerun.answer") }
    defer { Task { @MainActor in UIApplication.shared.endBackgroundTask(task) } }
    do {
      try await send(requestId: requestId, response: response, desktopId: desktopId)
      await Notifications.removeDelivered(requestId: requestId)
    } catch {
      await notifyFailed(desktopId: desktopId, requestId: requestId, info: info)
    }
  }

  private func send(requestId: String, response: JSON, desktopId: String) async throws {
    guard await Shared.configureTokens(), let relay = Shared.config.flatMap({ URL(string: $0.relayUrl) }),
      let state = RemoteStateStore.read(Shared.keychain), let desktopStatic = state.desktopStatic(desktopId),
      let keys = try DeviceKeys.load(deviceId: state.deviceId, store: Shared.keychain)
    else { throw BridgeError("not paired") }
    let envelope = try LockScreenAnswer.seal(
      requestId: requestId, response: response, myDeviceId: state.deviceId, desktopId: desktopId, key: keys.noise, desktopStatic: desktopStatic, now: Shared.nowMs()
    )
    for attempt in 0..<2 {
      let token = attempt == 0 ? try await Shared.tokens.accessToken() : try await Shared.tokens.refresh().accessToken
      let req = try LockScreenAnswer.request(envelope: envelope, relay: relay, token: token, deviceId: state.deviceId, key: keys.signing, now: Shared.nowMs())
      let (_, res) = try await URLSession.shared.data(for: req)
      let status = (res as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(status) { return }
      if status != 401 { break }
    }
    throw BridgeError("the relay refused the answer")
  }

  private func notifyFailed(desktopId: String, requestId: String, info: [AnyHashable: Any]) async {
    let c = UNMutableNotificationContent()
    c.title = "Your answer wasn’t sent"
    c.body = "Open Homerun to answer."
    c.userInfo = ["hr_desktop": desktopId, "hr_request": requestId, "hr_thread": info["hr_thread"] as? String ?? ""].filter { !$0.value.isEmpty }
    c.threadIdentifier = (info["hr_thread"] as? String).map { "\(desktopId).\($0)" } ?? desktopId
    try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "hr.failed.\(requestId)", content: c, trigger: nil))
  }

  /// Takes down every delivered notification for a request (answered here or elsewhere).
  static func removeDelivered(requestId: String) async {
    let center = UNUserNotificationCenter.current()
    let ids = await center.deliveredNotifications().filter { ($0.request.content.userInfo["hr_request"] as? String) == requestId }.map(\.request.identifier)
    if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
  }
}
