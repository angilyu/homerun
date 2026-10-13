import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_PUBKEY, type Manifest, fragment, merge, signedVersion, verifyMinisign } from "../../scripts/release/latest-json";

// The same vectors as the shell's updater tests (src-tauri/src/updater.rs): an ephemeral key, and
// `tauri signer sign --app-version 0.9.0` over PAYLOAD.
const PUB =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUxQzc0OEY1MkE1MkQxNTgKUldSWTBWSXE5VWpIVWYzdjhqeVo3Tkl4QU90NGJSa0VaZUdyTHFuckptc1dWalBORUVqdWhnb0QK";
const SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSWTBWSXE5VWpIVWU3UUprb1pLa3d0cDV4dXROaGV5QUFVNHVuaG9PTjFGTHZ2RnNIckVxSG13ZzM2bmxSbGZlNEt5eHc2S3lRcEh0STlIbW01UnllZndsVlVFelllVmdvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzQwNDU4CWZpbGU6cGF5bG9hZAl2ZXJzaW9uOjAuOS4wCmpWL1lnZ3RmTnNLdjY2S0hTRlJyL3FsRzh3MkUrNGYrZkRaSkt4U3JWL2JzSWFPcWJCQ0QwVTJkR2FFL2FwM0pVSjEwZXU2RHRvNXQ1TGQreCtIMkJBPT0K";
const PAYLOAD = new TextEncoder().encode("homerun update payload");
const URL_V = "https://github.com/angilyu/homerun/releases/download/v0.9.0/";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** PUB with its key ID changed: a different key as far as minisign is concerned. */
function otherKey(): string {
  const [c, k] = unb64(PUB).split("\n");
  const raw = Buffer.from(k!, "base64");
  raw[2] = raw[2]! ^ 0xff;
  return b64(`${c}\n${raw.toString("base64")}\n`);
}

function assets(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "homerun-latest-"));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  return dir;
}

describe("minisign verification", () => {
  test("accepts Tauri's signature and reads the signed version", () => {
    const trusted = verifyMinisign(PUB, SIG, PAYLOAD);
    expect(signedVersion(trusted)).toBe("0.9.0");
  });

  test("rejects a tampered payload, another key, or an edited trusted comment", () => {
    expect(() => verifyMinisign(PUB, SIG, new TextEncoder().encode("homerun update payloaD"))).toThrow("does not match");
    expect(() => verifyMinisign(otherKey(), SIG, PAYLOAD)).toThrow("but the app trusts key");
    const edited = b64(unb64(SIG).replace("version:0.9.0", "version:9.9.9"));
    expect(() => verifyMinisign(PUB, edited, PAYLOAD)).toThrow("trusted comment's signature");
    expect(() => verifyMinisign(PLACEHOLDER_PUBKEY, SIG, PAYLOAD)).toThrow();
    expect(() => verifyMinisign(PUB, "not base64!", PAYLOAD)).toThrow();
  });
});

describe("merge", () => {
  const mac = (): Manifest => ({
    version: "0.9.0",
    notes: "",
    pub_date: "2026-01-01T00:00:00Z",
    platforms: { "darwin-aarch64": { signature: SIG, url: `${URL_V}Homerun_0.9.0_aarch64.app.tar.gz` } },
    homerun: { min_update_from: "0.5.0" },
  });
  const win = () => fragment("windows-x86_64", "0.9.0", `${URL_V}Homerun_0.9.0_x64-setup.exe`, SIG + "\n");
  const dir = () => assets({ "Homerun_0.9.0_aarch64.app.tar.gz": PAYLOAD, "Homerun_0.9.0_x64-setup.exe": PAYLOAD });
  const now = new Date("2026-02-03T04:05:06.789Z");

  test("one manifest for both platforms, extension kept", () => {
    const m = merge({ version: "0.9.0", fragments: [mac(), win()], assetsDir: dir(), pubkey: PUB, notes: "n", now });
    expect(m).toEqual({
      version: "0.9.0",
      notes: "n",
      pub_date: "2026-02-03T04:05:06Z",
      platforms: {
        "darwin-aarch64": { signature: SIG, url: `${URL_V}Homerun_0.9.0_aarch64.app.tar.gz` },
        "windows-x86_64": { signature: SIG, url: `${URL_V}Homerun_0.9.0_x64-setup.exe` },
      },
      homerun: { min_update_from: "0.5.0" },
    });
  });

  test("only the platforms given (an unsigned platform has no fragment)", () => {
    const m = merge({ version: "0.9.0", fragments: [win()], assetsDir: dir(), pubkey: PUB });
    expect(Object.keys(m.platforms)).toEqual(["windows-x86_64"]);
    expect(m.homerun).toBeUndefined();
  });

  test("refuses the placeholder key, a key the payloads weren't signed with, and no platforms", () => {
    expect(() => merge({ version: "0.9.0", fragments: [win()], assetsDir: dir(), pubkey: PLACEHOLDER_PUBKEY })).toThrow("placeholder");
    expect(() => merge({ version: "0.9.0", fragments: [win()], assetsDir: dir(), pubkey: otherKey() })).toThrow("windows-x86_64: signed with key");
    expect(() => merge({ version: "0.9.0", fragments: [], assetsDir: dir(), pubkey: PUB })).toThrow("no signed platforms");
  });

  test("refuses a payload that isn't an asset of this release, or was changed", () => {
    const elsewhere = fragment("windows-x86_64", "0.9.0", "https://example.com/v0.9.0/Homerun_0.9.0_x64-setup.exe", SIG);
    expect(() => merge({ version: "0.9.0", fragments: [elsewhere], assetsDir: dir(), pubkey: PUB })).toThrow("is not an asset of v0.9.0");
    expect(() => merge({ version: "0.9.0", fragments: [win()], assetsDir: assets({}), pubkey: PUB })).toThrow("not among the release's assets");
    const changed = assets({ "Homerun_0.9.0_x64-setup.exe": new TextEncoder().encode("other") });
    expect(() => merge({ version: "0.9.0", fragments: [win()], assetsDir: changed, pubkey: PUB })).toThrow("does not match the payload");
  });

  test("refuses a signature for another version, and duplicates", () => {
    const v = "https://github.com/angilyu/homerun/releases/download/v0.9.1/";
    const f = fragment("windows-x86_64", "0.9.1", `${v}Homerun_0.9.1_x64-setup.exe`, SIG);
    const d = assets({ "Homerun_0.9.1_x64-setup.exe": PAYLOAD });
    expect(() => merge({ version: "0.9.1", fragments: [f], assetsDir: d, pubkey: PUB })).toThrow("signed for version 0.9.0, not 0.9.1");
    expect(() => merge({ version: "0.9.1", fragments: [win()], assetsDir: d, pubkey: PUB })).toThrow("a fragment is for 0.9.0");
    expect(() => merge({ version: "0.9.0", fragments: [win(), win()], assetsDir: dir(), pubkey: PUB })).toThrow("appears twice");
    expect(() => fragment("linux-x86_64", "0.9.0", URL_V, SIG)).toThrow("unknown platform");
  });
});
