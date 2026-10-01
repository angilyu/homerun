// The Notification Service Extension (§9.7): opens each sealed push with CryptoKit, in Swift,
// through HomerunKit. It shares the device keys with the app through the Keychain group.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = () => ({
  type: "notification-service",
  bundleIdentifier: ".NotificationService",
  deploymentTarget: "16.4",
  frameworks: ["UserNotifications"],
  entitlements: {
    "keychain-access-groups": ["NMJBY8WL8T.com.angilyu.homerun.shared"],
  },
});
