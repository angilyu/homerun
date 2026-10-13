import { RELAY_PATHS } from "@homerun/protocol";

/** The policy platform of this OS (§11), matching `PolicyPlatform` where Homerun ships. */
export function policyPlatform(p: NodeJS.Platform = process.platform): string {
  return p === "darwin" ? "macos" : p === "win32" ? "windows" : p;
}

/** The version policy's URL on a relay (base URL without a trailing slash). */
export function policyUrl(relayUrl: string | null | undefined): string | null {
  return relayUrl ? relayUrl + RELAY_PATHS.versionPolicy : null;
}
