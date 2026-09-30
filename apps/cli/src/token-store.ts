/**
 * Where the release CLI keeps its token (§5.2): a generic password in the user's login keychain,
 * created by this binary, so macOS asks before any other program reads it. Development builds
 * can use a `0600` file instead (`--dev-token-store`), which is how Linux CI runs the token flow.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliToken } from "@homerun/core";
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
export function keychainAccount(env: Env): string {
  const dir = env.HOMERUN_DATA_DIR;
  if (!dir) return "default";
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
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

/** A `0600` file: development builds only. */
export class FileTokenStore implements TokenStore {
  readonly where: string;

  constructor(readonly path: string) {
    this.where = `the development token store (${path})`;
  }

  read(): string | null {
    let text: string;
    try {
      if ((statSync(this.path).mode & 0o077) !== 0) throw new CliError(`${this.path} is readable by other users; it must be 0600`, EXIT.NOPERM);
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
    chmodSync(tmp, 0o600);
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
