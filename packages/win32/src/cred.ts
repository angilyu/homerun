/**
 * Credential Manager (docs/design.md §5.2, §13): generic credentials, persisted on this machine
 * only (never roamed), readable by this user's processes, like a keychain item without an ACL.
 */
import { ptr as addressOf } from "bun:ffi";
import { advapi32, asPointer, bytesAt, check, ERROR_NOT_FOUND, kernel32, Win32Error, wide } from "./ffi";

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
/** CRED_MAX_CREDENTIAL_BLOB_SIZE. */
export const CRED_MAX_BLOB = 5 * 512;
/** CREDENTIALW on x64: Type @4, TargetName @8, CredentialBlobSize @32, CredentialBlob @40, Persist @48, UserName @72. */
const CREDENTIALW_SIZE = 80;

/** The secret stored under `target`, or null when there is none. */
export function credRead(target: string): Uint8Array | null {
  const out = new BigUint64Array(1);
  if (!advapi32().CredReadW(wide(target), CRED_TYPE_GENERIC, 0, out)) {
    const code = kernel32().GetLastError();
    if (code === ERROR_NOT_FOUND) return null;
    throw new Win32Error("CredReadW", code);
  }
  try {
    const cred = new DataView(bytesAt(out[0]!, CREDENTIALW_SIZE).buffer);
    const size = cred.getUint32(32, true);
    const blob = cred.getBigUint64(40, true);
    return size && blob ? bytesAt(blob, size) : new Uint8Array(0);
  } finally {
    advapi32().CredFree(asPointer(out[0]!));
  }
}

/** Store `secret` under `target`, replacing what was there. The copy made for the call is zeroed. */
export function credWrite(target: string, userName: string, secret: Uint8Array): void {
  if (secret.length > CRED_MAX_BLOB) throw new Error(`a credential holds at most ${CRED_MAX_BLOB} bytes`);
  const t = wide(target);
  const u = wide(userName);
  const blob = Buffer.alloc(Math.max(1, secret.length));
  blob.set(secret);
  const cred = Buffer.alloc(CREDENTIALW_SIZE);
  cred.writeUInt32LE(CRED_TYPE_GENERIC, 4);
  cred.writeBigUInt64LE(BigInt(addressOf(t)), 8);
  cred.writeUInt32LE(secret.length, 32);
  cred.writeBigUInt64LE(BigInt(addressOf(blob)), 40);
  cred.writeUInt32LE(CRED_PERSIST_LOCAL_MACHINE, 48);
  cred.writeBigUInt64LE(BigInt(addressOf(u)), 72);
  try {
    check(advapi32().CredWriteW(cred, 0), "CredWriteW");
  } finally {
    blob.fill(0);
    cred.fill(0);
  }
}

/** Remove the credential under `target`. False when there was none. */
export function credDelete(target: string): boolean {
  if (advapi32().CredDeleteW(wide(target), CRED_TYPE_GENERIC, 0)) return true;
  const code = kernel32().GetLastError();
  if (code === ERROR_NOT_FOUND) return false;
  throw new Win32Error("CredDeleteW", code);
}
