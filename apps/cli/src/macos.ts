/**
 * The few macOS calls the release CLI makes (§5.2), through `bun:ffi`: socket peer credentials
 * from libSystem, code-signing checks and the keychain from Security.framework, and the
 * CoreFoundation glue they need. Loaded on first use, so other platforms and the development
 * token flow never touch it. `kSec*` and `kCF*` constants are looked up with `dlsym`, not
 * hard-coded.
 */
import { dlopen, FFIType as T, read, toArrayBuffer, type Pointer } from "bun:ffi";

const SYSTEM = "/usr/lib/libSystem.B.dylib";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SECURITY = "/System/Library/Frameworks/Security.framework/Security";

const RTLD_NOW = 2;
const kCFStringEncodingUTF8 = 0x08000100;

const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

/** A CoreFoundation object reference (`CFTypeRef`); `0n` is NULL. */
export type Ref = bigint;
export const NULL: Ref = 0n;

function open() {
  const sys = dlopen(SYSTEM, {
    dlopen: { args: [T.ptr, T.i32], returns: T.ptr },
    dlsym: { args: [T.ptr, T.ptr], returns: T.ptr },
    getsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.ptr], returns: T.i32 },
    getpeereid: { args: [T.i32, T.ptr, T.ptr], returns: T.i32 },
    getuid: { args: [], returns: T.u32 },
  });
  // CF objects travel as `u64` (a bigint), never as `ptr` (a double): a tagged-pointer
  // CFString such as "default" has its high bits set, and a double would round it.
  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [T.u64, T.ptr, T.u32], returns: T.u64 },
    CFDataCreate: { args: [T.u64, T.ptr, T.i64], returns: T.u64 },
    CFDataGetLength: { args: [T.u64], returns: T.i64_fast },
    CFDataGetBytePtr: { args: [T.u64], returns: T.ptr },
    CFDictionaryCreate: { args: [T.u64, T.ptr, T.ptr, T.i64, T.u64, T.u64], returns: T.u64 },
    CFArrayCreate: { args: [T.u64, T.ptr, T.i64, T.u64], returns: T.u64 },
    CFRelease: { args: [T.u64], returns: T.void },
  });
  const sec = dlopen(SECURITY, {
    SecCodeCopyGuestWithAttributes: { args: [T.u64, T.u64, T.u32, T.ptr], returns: T.i32 },
    SecRequirementCreateWithString: { args: [T.u64, T.u32, T.ptr], returns: T.i32 },
    SecCodeCheckValidity: { args: [T.u64, T.u32, T.u64], returns: T.i32 },
    SecItemCopyMatching: { args: [T.u64, T.ptr], returns: T.i32 },
    SecItemAdd: { args: [T.u64, T.u64], returns: T.i32 },
    SecItemDelete: { args: [T.u64], returns: T.i32 },
    SecKeychainOpen: { args: [T.ptr, T.ptr], returns: T.i32 },
  });

  const handle = (path: string) => {
    const h = sys.symbols.dlopen(cstr(path), RTLD_NOW);
    if (!h) throw new Error(`dlopen ${path} failed`);
    return h;
  };
  const cfLib = handle(CORE_FOUNDATION);
  const secLib = handle(SECURITY);
  /** The address of an exported variable. */
  const addressOf = (lib: Pointer, name: string): Pointer => {
    const p = sys.symbols.dlsym(lib, cstr(name));
    if (!p) throw new Error(`dlsym ${name} failed`);
    return p;
  };
  /** The value of an exported `CFTypeRef` constant. */
  const constant = (lib: Pointer, name: string): Ref => read.u64(addressOf(lib, name));
  const address = (lib: Pointer, name: string): Ref => BigInt(addressOf(lib, name));

  const k = {
    dictKeyCallBacks: address(cfLib, "kCFTypeDictionaryKeyCallBacks"),
    dictValueCallBacks: address(cfLib, "kCFTypeDictionaryValueCallBacks"),
    arrayCallBacks: address(cfLib, "kCFTypeArrayCallBacks"),
    true: constant(cfLib, "kCFBooleanTrue"),
    guestAudit: constant(secLib, "kSecGuestAttributeAudit"),
    class: constant(secLib, "kSecClass"),
    classGenericPassword: constant(secLib, "kSecClassGenericPassword"),
    service: constant(secLib, "kSecAttrService"),
    account: constant(secLib, "kSecAttrAccount"),
    label: constant(secLib, "kSecAttrLabel"),
    valueData: constant(secLib, "kSecValueData"),
    returnData: constant(secLib, "kSecReturnData"),
    matchLimit: constant(secLib, "kSecMatchLimit"),
    matchLimitOne: constant(secLib, "kSecMatchLimitOne"),
    useKeychain: constant(secLib, "kSecUseKeychain"),
    matchSearchList: constant(secLib, "kSecMatchSearchList"),
  };
  return { sys: sys.symbols, cf: cf.symbols, sec: sec.symbols, k };
}

type Lib = ReturnType<typeof open>;
let lib: Lib | null = null;
export const macos = (): Lib => (lib ??= open());

/** CoreFoundation objects created in a scope, released together. */
export class CfScope {
  private owned: Ref[] = [];
  constructor(readonly l: Lib = macos()) {}

  own(p: Ref, what: string): Ref {
    if (p === NULL) throw new Error(`${what} failed`);
    this.owned.push(p);
    return p;
  }

  string(s: string): Ref {
    return this.own(this.l.cf.CFStringCreateWithCString(NULL, cstr(s), kCFStringEncodingUTF8), "CFStringCreateWithCString");
  }

  data(bytes: Uint8Array): Ref {
    return this.own(this.l.cf.CFDataCreate(NULL, bytes.length ? bytes : null, bytes.length), "CFDataCreate");
  }

  dict(entries: [Ref, Ref][]): Ref {
    const keys = new BigUint64Array(entries.map(([key]) => key));
    const values = new BigUint64Array(entries.map(([, v]) => v));
    return this.own(this.l.cf.CFDictionaryCreate(NULL, keys, values, entries.length, this.l.k.dictKeyCallBacks, this.l.k.dictValueCallBacks), "CFDictionaryCreate");
  }

  array(items: Ref[]): Ref {
    const values = new BigUint64Array(items);
    return this.own(this.l.cf.CFArrayCreate(NULL, values, items.length, this.l.k.arrayCallBacks), "CFArrayCreate");
  }

  /** Copies a CFData's bytes. */
  bytes(data: Ref): Uint8Array {
    const n = Number(this.l.cf.CFDataGetLength(data));
    if (!n) return new Uint8Array(0);
    const p = this.l.cf.CFDataGetBytePtr(data);
    if (!p) throw new Error("CFDataGetBytePtr failed");
    return new Uint8Array(toArrayBuffer(p, 0, n).slice(0));
  }

  release(): void {
    for (const p of this.owned.reverse()) this.l.cf.CFRelease(p);
    this.owned = [];
  }
}

/** Runs `fn` with a scope, and releases what it created. */
export function withCf<R>(fn: (s: CfScope) => R): R {
  const s = new CfScope();
  try {
    return fn(s);
  } finally {
    s.release();
  }
}

/**
 * An out-parameter for a CF object: `SecFoo(…, out.ptr)`, then `out.value`. Typed arrays are
 * passed to FFI calls as themselves, never as `ptr(array)`: Bun keeps an argument alive for the
 * call, but not an array whose address was taken earlier.
 */
export function outRef(): { ptr: BigUint64Array; readonly value: Ref } {
  const cell = new BigUint64Array(1);
  return {
    ptr: cell,
    get value() {
      return cell[0]!;
    },
  };
}
