import Foundation
import Security

public enum Random {
  public static func bytes(_ n: Int) -> Data {
    var d = Data(count: n)
    let ok = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
    precondition(ok == errSecSuccess, "no system randomness")
    return d
  }
}

/// `SealedPush` from `@homerun/core` (§9.7).
public struct SealedPush: Equatable {
  public enum Category: String, CaseIterable {
    case input_request, run_finished, run_failed, monitor_changed, schedule_missed
  }

  public struct Action: Equatable {
    public let id: String
    public let label: String
  }

  public let category: Category
  public let title: String
  public let body: String
  public let threadId: String?
  public let requestId: String?
  public let actions: [Action]
  public let withdrawn: Bool

  public init?(_ j: JSON) {
    guard j["type"]?.string == "push",
      let category = j["category"]?.string.flatMap(Category.init(rawValue:)),
      let title = j["title"]?.string, (1...200).contains(title.utf16.count),
      let body = j["body"]?.string, body.utf16.count <= 1000
    else { return nil }
    var threadId: String?, requestId: String?
    if let t = j["thread_id"] {
      guard let s = t.string, Ids.isUUID(s) else { return nil }
      threadId = s
    }
    if let r = j["request_id"] {
      guard let s = r.string, Ids.isUUID(s) else { return nil }
      requestId = s
    }
    var actions: [Action] = []
    if let a = j["actions"] {
      guard let list = a.array, list.count <= 4 else { return nil }
      for item in list {
        guard let id = item["id"]?.string, (1...64).contains(id.utf16.count),
          let label = item["label"]?.string, (1...64).contains(label.utf16.count)
        else { return nil }
        actions.append(Action(id: id, label: label))
      }
    }
    var withdrawn = false
    if let w = j["withdrawn"] {
      guard w == .bool(true) else { return nil }
      withdrawn = true
    }
    self.category = category
    self.title = title
    self.body = body
    self.threadId = threadId
    self.requestId = requestId
    self.actions = actions
    self.withdrawn = withdrawn
  }
}

/// What the Notification Service Extension shows for a push (§9.7, §18 row 88).
public struct PushPresentation: Equatable {
  public static let genericTitle = "Homerun"
  public static let genericBody = "You have a new update."

  public enum Outcome: Equatable {
    /// Show the generic text: the push had no payload, or it didn't open.
    case generic
    /// Show the decrypted push.
    case show
    /// The request was answered elsewhere. Its collapse id already replaces the original
    /// notification with this one, which has no actions; the extension also removes any other
    /// delivered notification for `requestId` and plays no sound.
    case withdraw(requestId: String)
  }

  public let outcome: Outcome
  public let title: String
  public let body: String
  /// The notification category: the registered actions for this push's buttons, or "" for none.
  public let categoryIdentifier: String
  public let threadIdentifier: String
  /// Kept in `userInfo` so the app and the action handler can find the request and answer it.
  public let userInfo: [String: String]
  public let actions: [SealedPush.Action]

  public static let generic = PushPresentation(outcome: .generic, title: genericTitle, body: genericBody, categoryIdentifier: "", threadIdentifier: "", userInfo: [:], actions: [])

  /// The category identifier encodes the action ids so a dynamically registered category can be reused.
  public static func category(for actions: [SealedPush.Action]) -> String {
    actions.isEmpty ? "" : "hr." + Bytes.b64url(Primitives.sha256(Data(actions.map { "\($0.id)\u{0}\($0.label)" }.joined(separator: "\u{1}").utf8)).prefix(9))
  }
}

extension PushPresentation {
  /// The actions as kept in `userInfo["hr_actions"]`: the handler answers from these, and the
  /// category's button titles are only for display.
  public static func encode(_ actions: [SealedPush.Action]) -> String {
    String(decoding: JSON.array(actions.map { .object([("id", .string($0.id)), ("label", .string($0.label))]) }).data, as: UTF8.self)
  }

  public static func actions(userInfo: [AnyHashable: Any]) -> [SealedPush.Action] {
    guard let s = userInfo["hr_actions"] as? String, let j = try? JSON.parse(Data(s.utf8)), let list = j.array else { return [] }
    return list.compactMap { a in a["id"]?.string.flatMap { id in a["label"]?.string.map { SealedPush.Action(id: id, label: $0) } } }
  }
}

public enum PushOpener {
  /// The sealed envelope in an APNs payload's `hr` key, if it is one.
  public static func envelope(userInfo: [AnyHashable: Any]) -> JSON? {
    guard let hr = userInfo["hr"], let j = try? JSON.from(hr), j.object != nil else { return nil }
    return j
  }

  /// Opens a push with this device's key and the pinned desktops. Every failure is the generic text.
  public static func present(userInfo: [AnyHashable: Any], state: RemoteState?, key: DhKey?, now: Int64) -> (PushPresentation, msgId: String?) {
    guard let env = envelope(userInfo: userInfo), let state, let key else { return (.generic, nil) }
    let result = Sealed.open(env, myDeviceId: state.deviceId, myKey: key, senderStatic: state.desktopStatic, now: now, seen: { state.seen.contains($0) })
    guard case let .ok(header, inner) = result, header.kind == .push, let push = SealedPush(inner["body"]!) else { return (.generic, nil) }
    let sender = header.fromDeviceId
    if push.withdrawn, let rid = push.requestId {
      let p = PushPresentation(outcome: .withdraw(requestId: rid), title: push.title, body: push.body, categoryIdentifier: "", threadIdentifier: sender, userInfo: ["hr_desktop": sender, "hr_request": rid, "hr_withdrawn": "1"], actions: [])
      return (p, header.msgId)
    }
    var info: [String: String] = ["hr_desktop": sender, "hr_category": push.category.rawValue]
    if let t = push.threadId { info["hr_thread"] = t }
    if let r = push.requestId { info["hr_request"] = r }
    if !push.actions.isEmpty { info["hr_actions"] = PushPresentation.encode(push.actions) }
    let thread = push.threadId.map { "\(sender).\($0)" } ?? sender
    let p = PushPresentation(outcome: .show, title: push.title, body: push.body, categoryIdentifier: PushPresentation.category(for: push.actions), threadIdentifier: thread, userInfo: info, actions: push.actions)
    return (p, header.msgId)
  }
}
