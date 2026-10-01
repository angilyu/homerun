import Foundation
import HomerunKit
import UserNotifications

/// Opens each sealed push natively (§9.7, §18 rows 71, 88): the relay and APNs only ever carry
/// the generic text and the sealed envelope in `hr`. With this device's Noise key and the pinned
/// desktops from the shared Keychain, HomerunKit opens it with CryptoKit; anything that doesn't
/// open shows the generic text. A withdrawal (answered elsewhere) takes down the request's other
/// notifications and arrives silently. Nothing here is ever logged: it is the plaintext.
final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let generic = Self.generic(sound: request.content.sound)
    lock.withLock {
      deliver = contentHandler
      fallback = generic
    }
    let keychain = Keychain.shared
    let state = RemoteStateStore.read(keychain)
    let key = state.flatMap { try? DeviceKeys.load(deviceId: $0.deviceId, store: keychain) }?.noise
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let (p, _) = PushOpener.present(userInfo: request.content.userInfo, state: state, key: key, now: now)
    switch p.outcome {
    case .generic:
      finish(generic)
    case .show:
      let content = Self.content(p, sound: request.content.sound ?? .default)
      Task {
        await Self.register(p)
        self.finish(content)
      }
    case .withdraw(let requestId):
      let content = Self.content(p, sound: nil)
      Task {
        await Self.removeDelivered(requestId: requestId)
        self.finish(content)
      }
    }
  }

  /// Out of time: the generic text, never a half-built notification.
  override func serviceExtensionTimeWillExpire() {
    if let f = lock.withLock({ fallback }) { finish(f) }
  }

  private func finish(_ content: UNNotificationContent) {
    let d: ((UNNotificationContent) -> Void)? = lock.withLock {
      defer { deliver = nil }
      return deliver
    }
    d?(content)
  }

  private static func generic(sound: UNNotificationSound?) -> UNNotificationContent {
    let c = UNMutableNotificationContent()
    c.title = PushPresentation.genericTitle
    c.body = PushPresentation.genericBody
    c.sound = sound
    return c
  }

  private static func content(_ p: PushPresentation, sound: UNNotificationSound?) -> UNNotificationContent {
    let c = UNMutableNotificationContent()
    c.title = p.title
    c.body = p.body
    c.sound = sound
    c.categoryIdentifier = p.categoryIdentifier
    c.threadIdentifier = p.threadIdentifier
    c.userInfo = p.userInfo
    return c
  }

  /// Categories registered at most: older Homerun ones go first.
  private static let maxCategories = 32

  /// Registers the push's buttons as a category named after them (§9.7). Every button needs the
  /// phone unlocked; destructive approvals have none here, since they always open the app for
  /// Face ID (§9.8). The handler answers from `userInfo`, so a category only labels buttons.
  private static func register(_ p: PushPresentation) async {
    guard !p.categoryIdentifier.isEmpty else { return }
    let center = UNUserNotificationCenter.current()
    var categories = await center.notificationCategories()
    if categories.contains(where: { $0.identifier == p.categoryIdentifier }) { return }
    let actions = p.actions.map { UNNotificationAction(identifier: $0.id, title: $0.label, options: [.authenticationRequired]) }
    let mine = categories.filter { $0.identifier.hasPrefix("hr.") }
    if mine.count >= maxCategories {
      for c in mine.prefix(mine.count - maxCategories + 1) { categories.remove(c) }
    }
    categories.insert(UNNotificationCategory(identifier: p.categoryIdentifier, actions: actions, intentIdentifiers: [], options: []))
    center.setNotificationCategories(categories)
  }

  private static func removeDelivered(requestId: String) async {
    let center = UNUserNotificationCenter.current()
    let ids = await center.deliveredNotifications()
      .filter { ($0.request.content.userInfo["hr_request"] as? String) == requestId }
      .map(\.request.identifier)
    if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
  }
}
