/**
 * Authenticode (the CLI's peer check, §5.2): whether a file's signature verifies to a trusted
 * root, and the common name of the certificate that signed it. The Windows counterpart of a
 * code-signing requirement's identifier-and-team pin.
 */
import { dlopen, FFIType, ptr as addressOf } from "bun:ffi";
import { bytesAt, INVALID_HANDLE, wide } from "./ffi";

const { u32, i32, u64, ptr: P } = FFIType;

let lib: ReturnType<typeof load> | undefined;
function load() {
  const wintrust = dlopen("wintrust.dll", {
    WinVerifyTrust: { args: [u64, P, P], returns: i32 },
    WTHelperProvDataFromStateData: { args: [u64], returns: u64 },
    WTHelperGetProvSignerFromChain: { args: [u64, u32, i32, u32], returns: u64 },
    WTHelperGetProvCertFromChain: { args: [u64, u32], returns: u64 },
  }).symbols;
  const crypt32 = dlopen("crypt32.dll", {
    CertGetNameStringW: { args: [u64, u32, u32, P, P, u32], returns: u32 },
  }).symbols;
  return { wintrust, crypt32 };
}
function libs() {
  if (process.platform !== "win32") throw new Error(`@homerun/win32 called on ${process.platform}`);
  return (lib ??= load());
}

/** WINTRUST_ACTION_GENERIC_VERIFY_V2, {00AAC56B-CD44-11d0-8CC2-00C04FC295EE}. */
function genericVerifyV2(): Buffer {
  const g = Buffer.alloc(16);
  g.writeUInt32LE(0x00aac56b, 0);
  g.writeUInt16LE(0xcd44, 4);
  g.writeUInt16LE(0x11d0, 6);
  Buffer.from([0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee]).copy(g, 8);
  return g;
}

/** TRUST_E_NOSIGNATURE: the file carries no signature. */
export const TRUST_E_NOSIGNATURE = 0x800b0100;

const WTD_UI_NONE = 2;
const WTD_REVOKE_NONE = 0;
const WTD_CHOICE_FILE = 1;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
/** Verify offline: no revocation fetches, so a check never waits on the network. */
const WTD_REVOCATION_CHECK_NONE = 0x10;
const WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000;
const CERT_NAME_ATTR_TYPE = 3;

/**
 * Verify `path`'s Authenticode signature. `status` is WinVerifyTrust's (0 when it verifies, as an
 * unsigned 32-bit HRESULT otherwise); `subject` is the signing certificate's common name, when
 * the signature verified.
 */
export function authenticode(path: string): { status: number; subject: string | null } {
  const { wintrust, crypt32 } = libs();
  const file = wide(path);
  // WINTRUST_FILE_INFO (x64): cbStruct @0, pcwszFilePath @8, hFile @16, pgKnownSubject @24.
  const fileInfo = Buffer.alloc(32);
  fileInfo.writeUInt32LE(32, 0);
  fileInfo.writeBigUInt64LE(BigInt(addressOf(file)), 8);
  // WINTRUST_DATA (x64): cbStruct @0, dwUIChoice @24, fdwRevocationChecks @28, dwUnionChoice @32,
  // pFile @40, dwStateAction @48, hWVTStateData @56, dwProvFlags @72.
  const data = Buffer.alloc(88);
  data.writeUInt32LE(88, 0);
  data.writeUInt32LE(WTD_UI_NONE, 24);
  data.writeUInt32LE(WTD_REVOKE_NONE, 28);
  data.writeUInt32LE(WTD_CHOICE_FILE, 32);
  data.writeBigUInt64LE(BigInt(addressOf(fileInfo)), 40);
  data.writeUInt32LE(WTD_STATEACTION_VERIFY, 48);
  data.writeUInt32LE(WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL, 72);
  const action = genericVerifyV2();
  const hwnd = INVALID_HANDLE;
  const status = wintrust.WinVerifyTrust(hwnd, action, data) >>> 0;
  try {
    if (status !== 0) return { status, subject: null };
    return { status, subject: signerName(data.readBigUInt64LE(56)) };
  } finally {
    data.writeUInt32LE(WTD_STATEACTION_CLOSE, 48);
    wintrust.WinVerifyTrust(hwnd, action, data);
  }

  function signerName(state: bigint): string | null {
    const prov = wintrust.WTHelperProvDataFromStateData(state);
    if (!prov) return null;
    const signer = wintrust.WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
    if (!signer) return null;
    const leaf = wintrust.WTHelperGetProvCertFromChain(signer, 0);
    if (!leaf) return null;
    // CRYPT_PROVIDER_CERT (x64): cbStruct @0, pCert @8.
    const cert = new DataView(bytesAt(leaf, 16).buffer).getBigUint64(8, true);
    if (!cert) return null;
    const oid = Buffer.from("2.5.4.3\0", "latin1");
    const out = Buffer.alloc(512);
    const n = crypt32.CertGetNameStringW(cert, CERT_NAME_ATTR_TYPE, 0, oid, out, out.length / 2);
    if (n <= 1) return null;
    return out.subarray(0, (n - 1) * 2).toString("utf16le");
  }
}
