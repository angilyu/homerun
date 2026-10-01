import type { ConfigContext, ExpoConfig } from "expo/config";
import { withInfoPlist, type ConfigPlugin } from "expo/config-plugins";

/**
 * The iPhone app's build configuration (§9.8). `expo prebuild` generates `ios/` from this; it is
 * never committed. What the app connects to is fixed at build time from `HOMERUN_IOS_*`:
 *
 * - `HOMERUN_IOS_RELAY_URL`, `HOMERUN_IOS_OIDC_ISSUER`, `HOMERUN_IOS_OIDC_CLIENT_ID`
 * - `HOMERUN_IOS_AUTH_PARAMS`: JSON, extra authorization parameters (WorkOS: `{"provider":"authkit"}`)
 * - `HOMERUN_IOS_DEV=1`: a development build. The development APNs and App Attest environments,
 *   and plain http to the local network for the local relay and issuer.
 * - `HOMERUN_IOS_BUILD`: the build number.
 */

const TEAM = "NMJBY8WL8T";
const BUNDLE_ID = "com.angilyu.homerun.ios";
/** Shared with the Notification Service Extension: device keys, tokens, pinned desktops. */
const SHARED_KEYCHAIN = `${TEAM}.com.angilyu.homerun.shared`;
/** The app's own: the cache key and the app's settings. Listed first, so it's the default group. */
const APP_KEYCHAIN = `${TEAM}.${BUNDLE_ID}`;

const VERSION = "0.0.1";

/**
 * Release builds register no URL scheme and reach nothing on the local network (§18 row 124).
 * Sign-in returns through `ASWebAuthenticationSession`'s callback, which needs no registered
 * scheme; a registered one would let any stray redirect open the app. Prebuild adds the bundle
 * id's scheme, and expo-dev-client its scheme and local-network keys; this strips them.
 */
const withReleaseHardening: ConfigPlugin<boolean> = (config, dev) =>
  withInfoPlist(config, (c) => {
    if (dev) return c;
    const p = c.modResults;
    delete p.CFBundleURLTypes;
    delete p.NSLocalNetworkUsageDescription;
    delete p.NSBonjourServices;
    p.NSAppTransportSecurity = { NSAllowsArbitraryLoads: false };
    return c;
  });

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env;
  const dev = env.HOMERUN_IOS_DEV === "1";
  const environment = dev ? "development" : "production";
  return withReleaseHardening({
    ...config,
    name: "Homerun",
    slug: "homerun",
    version: VERSION,
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    platforms: ["ios"],
    ios: {
      bundleIdentifier: BUNDLE_ID,
      appleTeamId: TEAM,
      buildNumber: env.HOMERUN_IOS_BUILD ?? "1",
      supportsTablet: false,
      entitlements: {
        "aps-environment": environment,
        "com.apple.developer.devicecheck.appattest-environment": environment,
        "keychain-access-groups": [APP_KEYCHAIN, SHARED_KEYCHAIN],
        "com.apple.developer.default-data-protection": "NSFileProtectionComplete",
      },
      infoPlist: {
        HomerunKeychainGroup: SHARED_KEYCHAIN,
        HomerunAppKeychainGroup: APP_KEYCHAIN,
        HomerunApsEnvironment: environment,
        // No ITSAppUsesNonExemptEncryption until export compliance is answered in App Store
        // Connect (README manual check 39): the answer is the user's, not the build's (§18 row 118).
        ...(dev ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
      },
    },
    plugins: [
      ["expo-build-properties", { ios: { deploymentTarget: "16.4" } }],
      ["expo-sqlite", { useSQLCipher: true }],
      ["expo-camera", { cameraPermission: "Homerun scans the QR code your Mac shows, to pair this iPhone.", microphonePermission: false, barcodeScannerEnabled: true }],
      ["expo-local-authentication", { faceIDPermission: "Face ID confirms destructive approvals and can lock Homerun." }],
      "@bacons/apple-targets",
    ],
    extra: {
      homerun: {
        relayUrl: env.HOMERUN_IOS_RELAY_URL ?? "",
        issuer: env.HOMERUN_IOS_OIDC_ISSUER ?? "",
        clientId: env.HOMERUN_IOS_OIDC_CLIENT_ID ?? "",
        authParams: env.HOMERUN_IOS_AUTH_PARAMS ? (JSON.parse(env.HOMERUN_IOS_AUTH_PARAMS) as Record<string, string>) : {},
        dev,
        version: VERSION,
      },
    },
  }, dev);
};
