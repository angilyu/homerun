import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { SUN_PATH_MAX, chooseRunDir, dataDir, devTokenPath, readDevToken, resolveBuildChannel, DevTokenError } from "../src";

const work = mkdtempSync(join(tmpdir(), "hr-client-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("paths (§5.2)", () => {
  test("the data dir is HOMERUN_DATA_DIR, else Application Support/Homerun", () => {
    expect(dataDir({ HOMERUN_DATA_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(dataDir({}, "/Users/u")).toBe("/Users/u/Library/Application Support/Homerun");
    expect(dataDir({})).toBe(join(homedir(), "Library", "Application Support", "Homerun"));
  });

  test("the socket is <data>/run/homerund.sock, or $TMPDIR/hr-<uid>/ when that is too long", () => {
    expect(chooseRunDir("/d", "/t", 501)).toEqual({ runDir: "/d/run", socketPath: "/d/run/homerund.sock" });
    const long = "/" + "x".repeat(SUN_PATH_MAX);
    expect(chooseRunDir(long, "/t", 501)).toEqual({ runDir: "/t/hr-501", socketPath: "/t/hr-501/homerund.sock" });
    expect(() => chooseRunDir(long, long, 501)).toThrow(/too long/);
    expect(devTokenPath("/d/run")).toBe("/d/run/dev-token");
  });
});

describe("readDevToken", () => {
  const token = "A".repeat(43);
  const dir = (name: string) => {
    const d = join(work, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const reason = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (e instanceof DevTokenError) return e.reason;
      throw e;
    }
    return "ok";
  };

  test("reads a 0600 token owned by this user", () => {
    const d = dir("ok");
    writeFileSync(devTokenPath(d), token + "\n", { mode: 0o600 });
    expect(readDevToken(d)).toBe(token);
  });

  test("refuses a missing, group- or world-readable, foreign, symlinked or malformed token", () => {
    expect(reason(() => readDevToken(dir("missing")))).toBe("missing");
    const open = dir("open");
    writeFileSync(devTokenPath(open), token, { mode: 0o644 });
    chmodSync(devTokenPath(open), 0o644);
    expect(reason(() => readDevToken(open))).toBe("insecure");
    const foreign = dir("foreign");
    writeFileSync(devTokenPath(foreign), token, { mode: 0o600 });
    expect(reason(() => readDevToken(foreign, userInfo().uid + 1))).toBe("insecure");
    const link = dir("link");
    symlinkSync(devTokenPath(dir("ok")), devTokenPath(link));
    expect(reason(() => readDevToken(link))).toBe("insecure");
    const bad = dir("bad");
    writeFileSync(devTokenPath(bad), "not a token", { mode: 0o600 });
    expect(reason(() => readDevToken(bad))).toBe("malformed");
  });
});

describe("resolveBuildChannel", () => {
  test("fails closed: compiled is release unless defined development", () => {
    expect(resolveBuildChannel(undefined, false)).toBe("development");
    expect(resolveBuildChannel(undefined, true)).toBe("release");
    expect(resolveBuildChannel("development", true)).toBe("development");
    expect(resolveBuildChannel("release", false)).toBe("release");
    expect(resolveBuildChannel("dev", true)).toBe("release");
    expect(resolveBuildChannel("", false)).toBe("release");
  });
});
