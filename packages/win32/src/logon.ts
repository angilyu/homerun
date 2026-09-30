/**
 * Another user's token, for tests that must show a second local account is shut out (§5.2).
 * Nothing in the product logs anyone on.
 */
import { advapi32, check, wide } from "./ffi";

export const LOGON32_LOGON_INTERACTIVE = 2;
export const LOGON32_LOGON_NETWORK = 3;
export const LOGON32_LOGON_NETWORK_CLEARTEXT = 8;

/** Log `user` (a local account) on with logon `type`; the caller closes the token. */
export function logonUser(user: string, password: string, type: number): bigint {
  const t = new BigUint64Array(1);
  check(advapi32().LogonUserW(wide(user), wide("."), wide(password), type, 0, t), `LogonUserW(${type})`);
  return t[0]!;
}

/** Run `f` on this thread as `token`, then revert, even if `f` throws. `f` must not await. */
export function asUser<T>(token: bigint, f: () => T): T {
  check(advapi32().ImpersonateLoggedOnUser(token), "ImpersonateLoggedOnUser");
  try {
    return f();
  } finally {
    check(advapi32().RevertToSelf(), "RevertToSelf");
  }
}
