import AuthenticationServices
import UIKit

/// Runs the authorization page in `ASWebAuthenticationSession` (§10.2): an ephemeral session,
/// so no Safari cookies are shared, and the custom-scheme redirect comes back to us only.
final class WebAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = WebAuth()
  private var session: ASWebAuthenticationSession?

  /// The callback URL, or nil if the person closed the sheet.
  func run(_ url: URL, callbackScheme: String) async throws -> URL? {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL?, Error>) in
      DispatchQueue.main.async {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, error in
          self?.session = nil
          if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
            cont.resume(returning: nil)
          } else if let error {
            cont.resume(throwing: error)
          } else {
            cont.resume(returning: callback)
          }
        }
        s.prefersEphemeralWebBrowserSession = true
        s.presentationContextProvider = self
        self.session = s
        if !s.start() {
          self.session = nil
          cont.resume(throwing: BridgeError("Couldn’t open the sign-in page."))
        }
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? ASPresentationAnchor()
  }
}

struct BridgeError: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}
