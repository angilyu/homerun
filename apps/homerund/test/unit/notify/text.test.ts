import { afterAll, describe, expect, test } from "bun:test";
import { forgetSecret, registerSecret } from "../../../src/log";
import { body, firstLine, plainLine, title } from "../../../src/notify/text";

/** Notification text is shown where anyone near the Mac can read it (§8.2, §9.7, §13). */
describe("notification text", () => {
  /** Key-shaped fixtures are assembled at runtime, so the repository's secret scan stays clean. */
  const KEY = (s: string) => `sk-${"ant"}-api03-${s}`;
  const held = KEY("HELD_secret-value-0123456789");
  registerSecret(held);
  afterAll(() => forgetSecret(held));

  test("a report's first line, as one plain line", () => {
    expect(firstLine("\n\n## Price dropped\n\nDetails below")).toBe("Price dropped");
    expect(firstLine("**Bold** and _em_ and `code`")).toBe("Bold and em and code");
    expect(firstLine("- [Release notes](https://example.com/notes) are out")).toBe("Release notes are out");
    expect(firstLine("")).toBe("");
  });

  test("newlines and control characters don't survive", () => {
    expect(plainLine("a\r\nb\tc\u0000d\u0007e", 100)).toBe("a b c d e");
    expect(firstLine("line one\nline two")).toBe("line one");
  });

  test("bidirectional overrides and isolates are removed", () => {
    const s = plainLine("invoice \u202Egnp.exe\u202C and \u2066x\u2069 \u200Fz", 100);
    expect(s).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/);
    expect(s).toBe("invoice gnp.exe and x z");
  });

  test("no URLs, however long or disguised", () => {
    const long = `https://evil.example/${"a".repeat(5000)}?token=abc`;
    expect(firstLine(`See ${long} now`)).toBe("See now");
    expect(plainLine("go to www.evil.example/path or ftp://x.y/z", 100)).toBe("go to or");
    expect(plainLine(`[click](${long})`, 100)).toBe("click");
  });

  test("secrets are redacted: a held key, any sk-ant- key, and one split by zero-width characters", () => {
    expect(firstLine(`Key is ${held}`)).toBe("Key is …");
    expect(firstLine(`leaked ${KEY("SOMEOTHERKEY_abcdefgh")} done`)).toBe("leaked … done");
    const split = held.split("").join("\u200B");
    expect(firstLine(`x ${split} y`)).toBe("x … y");
    expect(firstLine(`\`${held}\``)).not.toContain("HELD");
  });

  test("lengths are capped, by characters, with an ellipsis", () => {
    expect([...firstLine("é".repeat(500))].length).toBe(140);
    expect(firstLine("é".repeat(500)).endsWith("…")).toBe(true);
    expect([...title("t".repeat(200))].length).toBe(80);
    expect([...body("b".repeat(400))].length).toBe(160);
    expect(title("   ")).toBe("Homerun");
  });
});
