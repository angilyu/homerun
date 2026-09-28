/**
 * Keychain access from the Bun-compiled runtime via bun:ffi → Security.framework
 * (design §11: items live in a shared access group tied to the Team ID).
 *
 * Two modes:
 *  - dataProtection=true: modern data-protection keychain with kSecAttrAccessGroup.
 *    Needs `keychain-access-groups` (+ application-identifier) entitlements, which on
 *    macOS require a Developer ID provisioning profile.
 *  - dataProtection=false: legacy file-based login keychain; access is controlled by an
 *    ACL bound to the creating binary's code signature (the "wants to access your
 *    keychain" prompt after an update when the designated requirement changes).
 * Reads never show UI (kSecUseAuthenticationUIFail) so a would-be prompt surfaces as
 * errSecInteractionNotAllowed (-25308) instead of blocking.
 */
import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";

const SEC = "/System/Library/Frameworks/Security.framework/Security";
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  dlopen: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
});
// CF object references are passed as u64 (bigint): tagged-pointer CFStrings exceed 2^53
// and would be corrupted as JS numbers.
const REF = FFIType.u64;
const cf = dlopen(CF, {
  CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32], returns: REF },
  CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: REF },
  CFDataGetBytePtr: { args: [REF], returns: FFIType.ptr },
  CFDataGetLength: { args: [REF], returns: FFIType.i64 },
  CFDictionaryCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: REF },
  CFRelease: { args: [REF], returns: FFIType.void },
});
const sec = dlopen(SEC, {
  SecItemAdd: { args: [REF, FFIType.ptr], returns: FFIType.i32 },
  SecItemCopyMatching: { args: [REF, FFIType.ptr], returns: FFIType.i32 },
  SecItemDelete: { args: [REF], returns: FFIType.i32 },
});
type Ref = bigint;

const RTLD_NOW = 2;
const secHandle = libc.symbols.dlopen(Buffer.from(SEC + "\0"), RTLD_NOW);
const cfHandle = libc.symbols.dlopen(Buffer.from(CF + "\0"), RTLD_NOW);
const cstr = (s: string) => Buffer.from(s + "\0");

/** Address of an exported data symbol. */
const sym = (h: Pointer | null, name: string): Pointer => {
  const p = libc.symbols.dlsym(h, cstr(name));
  if (!p) throw new Error(`dlsym ${name} failed`);
  return p;
};
/** Value of an exported `const CFStringRef`/`CFBooleanRef` constant. */
const constant = (h: Pointer | null, name: string): Ref => BigInt(read.u64(sym(h, name)));

const K = {
  kSecClass: constant(secHandle, "kSecClass"),
  kSecClassGenericPassword: constant(secHandle, "kSecClassGenericPassword"),
  kSecAttrService: constant(secHandle, "kSecAttrService"),
  kSecAttrAccount: constant(secHandle, "kSecAttrAccount"),
  kSecAttrAccessGroup: constant(secHandle, "kSecAttrAccessGroup"),
  kSecValueData: constant(secHandle, "kSecValueData"),
  kSecReturnData: constant(secHandle, "kSecReturnData"),
  kSecMatchLimit: constant(secHandle, "kSecMatchLimit"),
  kSecMatchLimitOne: constant(secHandle, "kSecMatchLimitOne"),
  kSecUseDataProtectionKeychain: constant(secHandle, "kSecUseDataProtectionKeychain"),
  kSecUseAuthenticationUI: constant(secHandle, "kSecUseAuthenticationUI"),
  kSecUseAuthenticationUIFail: constant(secHandle, "kSecUseAuthenticationUIFail"),
  kCFBooleanTrue: constant(cfHandle, "kCFBooleanTrue"),
  keyCallBacks: sym(cfHandle, "kCFTypeDictionaryKeyCallBacks"),
  valueCallBacks: sym(cfHandle, "kCFTypeDictionaryValueCallBacks"),
};

const cfString = (s: string): Ref => BigInt(cf.symbols.CFStringCreateWithCString(null, cstr(s), 0x08000100));

function dict(pairs: Array<[Ref, Ref]>): Ref {
  const keys = new BigUint64Array(pairs.map(([k]) => k));
  const vals = new BigUint64Array(pairs.map(([, v]) => v));
  return BigInt(cf.symbols.CFDictionaryCreate(null, ptr(keys), ptr(vals), pairs.length, K.keyCallBacks, K.valueCallBacks));
}

export interface KeychainOpts {
  service: string;
  account: string;
  /** e.g. "<TEAMID>.com.angilyu.homerun.shared"; only used with dataProtection. */
  accessGroup?: string;
  dataProtection: boolean;
}

function base(o: KeychainOpts): Array<[Ref, Ref]> {
  const q: Array<[Ref, Ref]> = [
    [K.kSecClass, K.kSecClassGenericPassword],
    [K.kSecAttrService, cfString(o.service)],
    [K.kSecAttrAccount, cfString(o.account)],
  ];
  if (o.dataProtection) q.push([K.kSecUseDataProtectionKeychain, K.kCFBooleanTrue]);
  if (o.dataProtection && o.accessGroup) q.push([K.kSecAttrAccessGroup, cfString(o.accessGroup)]);
  return q;
}

export function keychainDelete(o: KeychainOpts): number {
  const q = dict(base(o));
  const st = sec.symbols.SecItemDelete(q);
  cf.symbols.CFRelease(q);
  return st;
}

export function keychainSet(o: KeychainOpts, value: string): number {
  keychainDelete(o);
  const bytes = Buffer.from(value);
  const data = BigInt(cf.symbols.CFDataCreate(null, ptr(bytes), bytes.length));
  const q = dict([...base(o), [K.kSecValueData, data]]);
  const st = sec.symbols.SecItemAdd(q, null);
  cf.symbols.CFRelease(q);
  cf.symbols.CFRelease(data);
  return st;
}

export function keychainGet(o: KeychainOpts): { status: number; value?: string } {
  const q = dict([
    ...base(o),
    [K.kSecReturnData, K.kCFBooleanTrue],
    [K.kSecMatchLimit, K.kSecMatchLimitOne],
    [K.kSecUseAuthenticationUI, K.kSecUseAuthenticationUIFail],
  ]);
  const out = new BigUint64Array(1);
  const st = sec.symbols.SecItemCopyMatching(q, ptr(out));
  cf.symbols.CFRelease(q);
  if (st !== 0 || !out[0]) return { status: st };
  const ref = out[0];
  const len = Number(cf.symbols.CFDataGetLength(ref));
  const bp = cf.symbols.CFDataGetBytePtr(ref)!;
  const value = Buffer.from(toArrayBuffer(bp, 0, len)).toString("utf8");
  cf.symbols.CFRelease(ref);
  return { status: st, value };
}

export const SEC_ERRORS: Record<number, string> = {
  0: "errSecSuccess",
  [-25300]: "errSecItemNotFound",
  [-25308]: "errSecInteractionNotAllowed (would have prompted)",
  [-34018]: "errSecMissingEntitlement",
  [-25299]: "errSecDuplicateItem",
  [-25293]: "errSecAuthFailed",
  [-128]: "errSecUserCanceled",
};
