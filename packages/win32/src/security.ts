/**
 * Reading and replacing security descriptors on kernel objects (a pipe) and files (a directory).
 * The bytes are handed to the pure parsers in `sd.ts`.
 */
import { advapi32, asPointer, bytesAt, check, checkStatus, localFree, wide } from "./ffi";
import { parseAcl, SE_DACL_PROTECTED, sidLength, sidToString, type SecurityInfo } from "./sd";

export const SE_FILE_OBJECT = 1;
export const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;

/** The SID at `p`, as a string. */
export function sidAt(p: bigint | number): string {
  const head = bytesAt(p, 2);
  return sidToString(bytesAt(p, sidLength(head[1]!)));
}

function decode(owner: bigint, dacl: bigint, sd: bigint): SecurityInfo {
  try {
    const control = new Uint16Array(1);
    const revision = new Uint32Array(1);
    check(advapi32().GetSecurityDescriptorControl(asPointer(sd), control, revision), "GetSecurityDescriptorControl");
    let aces = null;
    if (dacl) {
      const size = new DataView(bytesAt(dacl, 8).buffer).getUint16(2, true);
      aces = parseAcl(bytesAt(dacl, size));
    }
    return {
      owner: sidAt(owner),
      dacl: aces ? { protected: (control[0]! & SE_DACL_PROTECTED) !== 0, aces } : null,
    };
  } finally {
    localFree(sd);
  }
}

/** The owner and DACL of an open handle (it needs READ_CONTROL). */
export function readSecurity(handle: bigint, objectType = SE_KERNEL_OBJECT): SecurityInfo {
  const owner = new BigUint64Array(1);
  const dacl = new BigUint64Array(1);
  const sd = new BigUint64Array(1);
  const what = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  checkStatus(advapi32().GetSecurityInfo(handle, objectType, what, owner, null, dacl, null, sd), "GetSecurityInfo");
  return decode(owner[0]!, dacl[0]!, sd[0]!);
}

/** The owner and DACL of a file or directory. */
export function readPathSecurity(path: string): SecurityInfo {
  const owner = new BigUint64Array(1);
  const dacl = new BigUint64Array(1);
  const sd = new BigUint64Array(1);
  const what = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  checkStatus(advapi32().GetNamedSecurityInfoW(wide(path), SE_FILE_OBJECT, what, owner, null, dacl, null, sd), "GetNamedSecurityInfoW");
  return decode(owner[0]!, dacl[0]!, sd[0]!);
}

/** Parse the DACL out of `sddl` and hand it to `apply`, freeing the descriptor after. */
function withDacl(sddl: string, apply: (dacl: bigint) => number, call: string): void {
  const sd = new BigUint64Array(1);
  check(advapi32().ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, sd, null), "ConvertStringSecurityDescriptorToSecurityDescriptorW");
  try {
    const present = new Int32Array(1);
    const dacl = new BigUint64Array(1);
    const defaulted = new Int32Array(1);
    check(advapi32().GetSecurityDescriptorDacl(asPointer(sd[0]!), present, dacl, defaulted), "GetSecurityDescriptorDacl");
    if (!present[0] || !dacl[0]) throw new Error(`no DACL in ${sddl}`);
    checkStatus(apply(dacl[0]!), call);
  } finally {
    localFree(sd[0]!);
  }
}

const SET_PROTECTED_DACL = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;

/** Replace a handle's DACL with the one in `sddl`, protected from inheritance (it needs WRITE_DAC). */
export function setProtectedDacl(handle: bigint, sddl: string, objectType = SE_KERNEL_OBJECT): void {
  withDacl(sddl, (d) => advapi32().SetSecurityInfo(handle, objectType, SET_PROTECTED_DACL, null, null, asPointer(d), null), "SetSecurityInfo");
}

/** Replace a file's or directory's DACL with the one in `sddl`, protected from inheritance. */
export function setPathProtectedDacl(path: string, sddl: string): void {
  withDacl(sddl, (d) => advapi32().SetNamedSecurityInfoW(wide(path), SE_FILE_OBJECT, SET_PROTECTED_DACL, null, null, asPointer(d), null), "SetNamedSecurityInfoW");
}
