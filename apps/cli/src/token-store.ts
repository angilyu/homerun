/**
 * Where the release CLI keeps its token (§5.2): a generic password in the user's login keychain,
 * created by this binary, so macOS asks before any other program reads it. On Windows, a generic
 * credential in Credential Manager, which any process of the user can read (§13). Development
 * builds can use a private file instead (`--dev-token-store`), which is how Linux CI runs the
 * token flow.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { filePrivacy, type FilePrivacy } from "@homerun/client";
import { CliToken } from "@homerun/core";
import { credDelete, credRead, credWrite, currentUserSid, privateFileSddl, setPathProtectedDacl, Win32Error } from "@homerun/win32";
import type { Env } from "./connect";
import { CliError, EXIT } from "./exit";

export interface TokenStore {
  /** For messages: "your keychain (…)". */
  readonly where: string;
  /** The stored token, or null if there is none. */
  read(): string | null;
  /** Store a token, replacing any other. */
  write(token: string): void;
  /** Remove the token. False if there was none. */
  delete(): boolean;
}

export const KEYCHAIN_SERVICE = "com.angilyu.homerun.cli";
export const KEYCHAIN_LABEL = "Homerun command-line tool";

/**
 * One item per data directory: `default`, or `data:<sha256 of its real path>` when
 * HOMERUN_DATA_DIR is set, so a second runtime's token never replaces the first's.
 */
export function keychainAccount(env: Env, platform: string = process.platform): string {
  const dir = env.HOMERUN_DATA_DIR;
  if (!dir) return "default";
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  // Windows paths are case-insensitive: one directory, however it is typed, is one item.
  if (platform === "win32") real = real.toLowerCase();
  return `data:${createHash("sha256").update(real).digest("hex")}`;
}

const errSecItemNotFound = -25300;
const errSecInteractionNotAllowed = -25308;
const errSecAuthFailed = -25293;
const errSecUserCanceled = -128;
const errSecNoSuchKeychain = -25294;

/** A keychain OSStatus as a message and exit code. */
export function keychainFailure(op: "read" | "save" | "delete", status: number): CliError {
  switch (status) {
    case errSecInteractionNotAllowed:
      return new CliError(
        "the keychain is locked, and macOS can't ask to unlock it here",
        EXIT.NOPERM,
        "unlock it first (over ssh: `security unlock-keychain`), then try again",
      );
    case errSecUserCanceled:
    case errSecAuthFailed:
      return new CliError(`keychain access was refused (${op})`, EXIT.NOPERM, 'choose "Allow" when macOS asks about "homerun"');
    case errSecNoSuchKeychain:
      return new CliError("the keychain could not be found", EXIT.NOPERM);
    default:
      return new CliError(`the keychain failed to ${op} the token (OSStatus ${status})`, EXIT.ERROR);
  }
}

/** A token read from anywhere is checked before use: a malformed one is treated as none. */
const valid = (t: string | null) => (t !== null && CliToken.safeParse(t).success ? t : null);

/** The login keychain, or a given keychain file (`--dev-keychain`, for the nightly test). */
export class KeychainTokenStore implements TokenStore {
  readonly where = `your keychain ("${KEYCHAIN_LABEL}")`;

  constructor(
    readonly account: string,
    private keychainPath?: string,
  ) {}

  read(): string | null {
    return this.run((m, s, base) => {
      const out = m.outRef();
      const st = m.macos().sec.SecItemCopyMatching(s.dict([...base, [this.k(m).returnData, this.k(m).true], [this.k(m).matchLimit, this.k(m).matchLimitOne]]), out.ptr);
      if (st === errSecItemNotFound) return null;
      if (st !== 0) throw keychainFailure("read", st);
      const data = s.own(out.value, "SecItemCopyMatching");
      return valid(new TextDecoder().decode(s.bytes(data)));
    });
  }

  write(token: string): void {
    this.run((m, s, base) => {
      const del = m.macos().sec.SecItemDelete(s.dict(base));
      if (del !== 0 && del !== errSecItemNotFound) throw keychainFailure("save", del);
      const k = this.k(m);
      const add: [Ref, Ref][] = [
        [k.class, k.classGenericPassword],
        [k.service, s.string(KEYCHAIN_SERVICE)],
        [k.account, s.string(this.account)],
        [k.label, s.string(KEYCHAIN_LABEL)],
        [k.valueData, s.data(new TextEncoder().encode(token))],
      ];
      if (this.keychainPath) add.push([k.useKeychain, this.keychain(m, s)]);
      const st = m.macos().sec.SecItemAdd(s.dict(add), m.NULL);
      if (st !== 0) throw keychainFailure("save", st);
    });
  }

  delete(): boolean {
    return this.run((m, s, base) => {
      const st = m.macos().sec.SecItemDelete(s.dict(base));
      if (st === errSecItemNotFound) return false;
      if (st !== 0) throw keychainFailure("delete", st);
      return true;
    });
  }

  private k(m: Macos) {
    return m.macos().k;
  }

  private keychain(m: Macos, s: CfScope): Ref {
    const out = m.outRef();
    const st = m.macos().sec.SecKeychainOpen(Buffer.from(this.keychainPath + "\0"), out.ptr);
    if (st !== 0) throw keychainFailure("read", st);
    return s.own(out.value, "SecKeychainOpen");
  }

  private run<R>(fn: (m: Macos, s: CfScope, base: [Ref, Ref][]) => R): R {
    if (process.platform !== "darwin") throw new CliError("the keychain is only available on macOS", EXIT.NOPERM);
    const m = macosModule();
    return m.withCf((s) => {
      const k = m.macos().k;
      const base: [Ref, Ref][] = [
        [k.class, k.classGenericPassword],
        [k.service, s.string(KEYCHAIN_SERVICE)],
        [k.account, s.string(this.account)],
      ];
      if (this.keychainPath) base.push([k.matchSearchList, s.array([this.keychain(m, s)])]);
      return fn(m, s, base);
    });
  }
}

type Macos = typeof import("./macos");
type CfScope = import("./macos").CfScope;
type Ref = import("./macos").Ref;
let macosMod: Macos | null = null;
/** `./macos` loads `bun:ffi` and the frameworks; only on first keychain use, and only on macOS. */
function macosModule(): Macos {
  // A synchronous require keeps the keychain calls synchronous; the module is bundled either way.
  return (macosMod ??= require("./macos") as Macos);
}

const ERROR_NO_SUCH_LOGON_SESSION = 1312;

/** A Credential Manager failure as a message and exit code. */
export function credentialFailure(op: "read" | "save" | "delete", code: number): CliError {
  if (code === ERROR_NO_SUCH_LOGON_SESSION)
    return new CliError("Credential Manager isn't available in this logon session", EXIT.NOPERM, "run homerun from your own desktop session, not over a network logon");
  return new CliError(`Credential Manager failed to ${op} the token (Win32 error ${code})`, EXIT.ERROR);
}

/** `com.angilyu.homerun.cli/<account>`: one generic credential per data directory. */
export const credentialTarget = (account: string) => `${KEYCHAIN_SERVICE}/${account}`;

/** Credential Manager (Windows): a generic credential, persisted on this machine only. */
export class CredentialManagerTokenStore implements TokenStore {
  readonly where = `Credential Manager ("${KEYCHAIN_LABEL}")`;

  constructor(readonly account: string) {}

  read(): string | null {
    const b = this.call("read", () => credRead(credentialTarget(this.account)));
    if (!b) return null;
    const t = new TextDecoder().decode(b);
    b.fill(0);
    return valid(t);
  }

  write(token: string): void {
    const b = new TextEncoder().encode(token);
    try {
      this.call("save", () => credWrite(credentialTarget(this.account), KEYCHAIN_LABEL, b));
    } finally {
      b.fill(0);
    }
  }

  delete(): boolean {
    return this.call("delete", () => credDelete(credentialTarget(this.account)));
  }

  private call<T>(op: "read" | "save" | "delete", f: () => T): T {
    if (process.platform !== "win32") throw new CliError("Credential Manager is only available on Windows", EXIT.NOPERM);
    try {
      return f();
    } catch (e) {
      if (e instanceof Win32Error) throw credentialFailure(op, e.code);
      throw e;
    }
  }
}

/** A private file (`0600`; on Windows, a protected DACL for the user and SYSTEM): development builds only. */
export class FileTokenStore implements TokenStore {
  readonly where: string;

  constructor(
    readonly path: string,
    private platform: string = process.platform,
    private privacy: FilePrivacy = filePrivacy,
  ) {
    this.where = `the development token store (${path})`;
  }

  read(): string | null {
    let text: string;
    try {
      const why = this.privacy(this.path, statSync(this.path), this.platform as NodeJS.Platform);
      if (why) throw new CliError(`${this.path} ${why}; it must be private (0600)`, EXIT.NOPERM);
      text = readFileSync(this.path, "utf8").trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return valid(text);
  }

  write(token: string): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, token + "\n", { mode: 0o600 });
    if (this.platform === "win32") setPathProtectedDacl(tmp, privateFileSddl(currentUserSid()));
    else chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  delete(): boolean {
    try {
      statSync(this.path);
    } catch {
      return false;
    }
    rmSync(this.path, { force: true });
    return true;
  }
}
