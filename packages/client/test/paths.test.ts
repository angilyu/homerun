import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { currentUserSid, privateDirSddl, setPathProtectedDacl } from "@homerun/win32";
import {
  SUN_PATH_MAX,
  chooseRunDir,
  dataDir,
  devTokenPath,
  endpointPath,
  EndpointError,
  isPipeName,
  localEndpoint,
  newPipeName,
  readDevToken,
  readDevTokenFile,
  readEndpointFile,
  resolveBuildChannel,
  DevTokenError,
  type FilePrivacy,
} from "../src";

const WINDOWS = process.platform === "win32";

const work = mkdtempSync(join(tmpdir(), "hr-client-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("paths (§5.2)", () => {
  test("the data dir is HOMERUN_DATA_DIR, else Application Support/Homerun", () => {
    expect(dataDir({ HOMERUN_DATA_DIR: "/tmp/x" }, "/Users/u", "darwin")).toBe("/tmp/x");
    expect(dataDir({}, "/Users/u", "darwin")).toBe("/Users/u/Library/Application Support/Homerun");
    if (!WINDOWS) expect(dataDir({})).toBe(join(homedir(), "Library", "Application Support", "Homerun"));
  });

  test("on Windows: HOMERUN_DATA_DIR, else %LOCALAPPDATA%\\Homerun, which never roams", () => {
    expect(dataDir({ HOMERUN_DATA_DIR: "D:\\hr" }, "C:\\Users\\u", "win32")).toBe("D:\\hr");
    expect(dataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u", "win32")).toBe(
      "C:\\Users\\u\\AppData\\Local\\Homerun",
    );
    expect(dataDir({}, "C:\\Users\\u", "win32")).toBe("C:\\Users\\u\\AppData\\Local\\Homerun");
    if (WINDOWS) expect(dataDir({ LOCALAPPDATA: process.env.LOCALAPPDATA })).toBe(join(process.env.LOCALAPPDATA!, "Homerun"));
  });

  test("the socket is <data>/run/homerund.sock, or $TMPDIR/hr-<uid>/ when that is too long", () => {
    expect(chooseRunDir("/d", "/t", 501, "darwin")).toEqual({ runDir: "/d/run", socketPath: "/d/run/homerund.sock" });
    const long = "/" + "x".repeat(SUN_PATH_MAX);
    expect(chooseRunDir(long, "/t", 501, "darwin")).toEqual({ runDir: "/t/hr-501", socketPath: "/t/hr-501/homerund.sock" });
    expect(() => chooseRunDir(long, long, 501, "linux")).toThrow(/too long/);
    expect(devTokenPath("/d/run", "darwin")).toBe("/d/run/dev-token");
  });

  test("on Windows the runtime listens on a new random pipe name at every start", () => {
    const a = chooseRunDir("C:\\d", undefined, undefined, "win32");
    const b = chooseRunDir("C:\\d", undefined, undefined, "win32");
    expect(a.runDir).toBe("C:\\d\\run");
    expect(a.socketPath).toMatch(/^\\\\\.\\pipe\\homerun-[0-9a-f]{32}$/);
    expect(a.socketPath).not.toBe(b.socketPath);
    expect(isPipeName(newPipeName())).toBe(true);
    expect(devTokenPath("C:\\d\\run", "win32")).toBe("C:\\d\\run\\dev-token");
    expect(endpointPath("C:\\d\\run")).toBe("C:\\d\\run\\endpoint");
  });

  test("only a Homerun pipe name on this machine is a pipe name", () => {
    const hex = "0123456789abcdef".repeat(2);
    expect(isPipeName(`\\\\.\\pipe\\homerun-${hex}`)).toBe(true);
    for (const bad of [
      `\\\\server\\pipe\\homerun-${hex}`,
      `\\\\localhost\\pipe\\homerun-${hex}`,
      `\\\\?\\pipe\\homerun-${hex}`,
      `\\\\.\\pipe\\other-${hex}`,
      `\\\\.\\pipe\\homerun-${hex.toUpperCase()}`,
      `\\\\.\\pipe\\homerun-${hex}0`,
      `\\\\.\\pipe\\homerun-${hex}\n`,
      `/tmp/homerund.sock`,
    ])
      expect(isPipeName(bad)).toBe(false);
  });
});

describe("localEndpoint (§5.2)", () => {
  const privateOk: FilePrivacy = () => null;
  const hex = "ab".repeat(16);
  const runDirWith = (name: string, content?: string) => {
    const d = join(work, name);
    mkdirSync(join(d, "run"), { recursive: true });
    if (content !== undefined) writeFileSync(join(d, "run", "endpoint"), content, { mode: 0o600 });
    return d;
  };
  const reason = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (e instanceof EndpointError) return e.reason;
      throw e;
    }
    return "ok";
  };

  test("POSIX: the fixed socket path; no file is read", () => {
    expect(localEndpoint("/d", "darwin")).toEqual({ runDir: "/d/run", socketPath: "/d/run/homerund.sock" });
  });
  // The Windows reader on this OS's file system, with the privacy check injected (the real check
  // runs on Windows below).
  const file = (name: string, content?: string) => join(runDirWith(name, content), "run", "endpoint");
  test("Windows: the published pipe name, trimmed", () => {
    expect(readEndpointFile(file("ep-ok", `\\\\.\\pipe\\homerun-${hex}\r\n`), "win32", privateOk)).toBe(`\\\\.\\pipe\\homerun-${hex}`);
  });
  test("Windows: missing, not a file, not private, or not a pipe name is refused", () => {
    expect(reason(() => readEndpointFile(file("ep-none"), "win32", privateOk))).toBe("missing");
    const dirAsFile = file("ep-dir");
    mkdirSync(dirAsFile);
    expect(reason(() => readEndpointFile(dirAsFile, "win32", privateOk))).toBe("insecure");
    expect(reason(() => readEndpointFile(file("ep-shared", `\\\\.\\pipe\\homerun-${hex}`), "win32", () => "allows S-1-1-0"))).toBe("insecure");
    for (const [i, bad] of [`\\\\server\\pipe\\homerun-${hex}`, "C:\\x", ""].entries())
      expect(reason(() => readEndpointFile(file(`ep-bad-${i}`, bad), "win32", privateOk))).toBe("malformed");
  });
  test.skipIf(!WINDOWS)("Windows, the real check: a file only the user can read passes; the inherited temp DACL does not", () => {
    const d = runDirWith("ep-real", `\\\\.\\pipe\\homerun-${hex}`);
    expect(reason(() => localEndpoint(d, "win32"))).toBe("insecure");
    setPathProtectedDacl(join(d, "run"), privateDirSddl(currentUserSid()));
    writeFileSync(join(d, "run", "endpoint"), `\\\\.\\pipe\\homerun-${hex}`);
    expect(localEndpoint(d, "win32").socketPath).toBe(`\\\\.\\pipe\\homerun-${hex}`);
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

  test.skipIf(WINDOWS)("reads a 0600 token owned by this user", () => {
    const d = dir("ok");
    writeFileSync(devTokenPath(d), token + "\n", { mode: 0o600 });
    expect(readDevToken(d)).toBe(token);
  });

  test.skipIf(WINDOWS)("refuses a missing, group- or world-readable, foreign, symlinked or malformed token", () => {
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

  test("the privacy check decides, on every platform", () => {
    const p = devTokenPath(dir("injected"));
    writeFileSync(p, token, { mode: 0o600 });
    expect(readDevTokenFile(p, userInfo().uid, "win32", () => null)).toBe(token);
    expect(reason(() => readDevTokenFile(p, userInfo().uid, "win32", () => "is not private to this user (allows S-1-1-0)"))).toBe("insecure");
  });

  test.skipIf(!WINDOWS)("Windows: a token only the user can read passes; one under the inherited temp DACL does not", () => {
    const d = dir("win");
    writeFileSync(devTokenPath(d), token);
    expect(reason(() => readDevToken(d))).toBe("insecure");
    setPathProtectedDacl(d, privateDirSddl(currentUserSid()));
    writeFileSync(devTokenPath(d), token);
    expect(readDevToken(d)).toBe(token);
    expect(reason(() => readDevToken(dir("win-missing")))).toBe("missing");
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
