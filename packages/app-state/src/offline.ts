import { ago, inTime } from "./format";
import type { RuntimeStatus } from "./transport";

/**
 * What a remote client says while its desktop is out of reach (§9.4, §9.8). Messages still go:
 * sealed at the relay, applied once when the desktop is back. Questions and approvals can't be
 * answered meanwhile: answering them needs the run that asked, on the desktop.
 */

export type OfflineStatus = Extract<RuntimeStatus, { state: "offline" }>;

/** "Your Mac is offline — questions and approvals can be answered when it's back. Last seen 5 min ago." */
export function offlineText(s: OfflineStatus, now: number, desktop = "Your Mac"): string {
  if (s.reason === "relay") return "Can't reach Homerun's relay. Check your connection; messages will send when it's back.";
  const seen = s.last_seen_at !== null ? ` Last seen ${ago(s.last_seen_at, now)}.` : "";
  return `${desktop} is offline — questions and approvals can be answered when it's back.${seen}`;
}

/** A message sealed at the relay: "Will send when your Mac is back — expires in 12 h". */
export function relayedText(expires_at: number | undefined, now: number, desktop = "your Mac"): string {
  if (expires_at === undefined) return `Will send when ${desktop} is back`;
  if (expires_at <= now) return `Not sent: ${desktop} wasn't back before it expired`;
  return `Will send when ${desktop} is back — expires ${inTime(expires_at, now)}`;
}
