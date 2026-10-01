import { describe, expect, test } from "bun:test";
import { offlineText, relayedText } from "../src/offline";
import { T0 } from "./helpers";

const H = 3600_000;

describe("a remote client while its desktop is away (§9.4, §9.8)", () => {
  test("says the desktop is offline, when it was last seen, and that answers wait", () => {
    expect(offlineText({ state: "offline", reason: "desktop", last_seen_at: T0 - 5 * 60_000 }, T0)).toBe(
      "Your Mac is offline — questions and approvals can be answered when it's back. Last seen 5 min ago.",
    );
    expect(offlineText({ state: "offline", reason: "desktop", last_seen_at: null }, T0, "Studio")).toBe(
      "Studio is offline — questions and approvals can be answered when it's back.",
    );
    expect(offlineText({ state: "offline", reason: "relay", last_seen_at: null }, T0)).toMatch(/^Can't reach Homerun's relay/);
  });

  test("a relayed message says it will send, and when it expires", () => {
    expect(relayedText(T0 + 12 * H, T0)).toBe("Will send when your Mac is back — expires in 12 h");
    expect(relayedText(T0 + 90 * 60_000, T0)).toBe("Will send when your Mac is back — expires in 1 h 30 min");
    expect(relayedText(T0 - 1, T0)).toBe("Not sent: your Mac wasn't back before it expired");
    expect(relayedText(undefined, T0)).toBe("Will send when your Mac is back");
  });
});
