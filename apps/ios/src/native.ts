/**
 * The iPhone app's native half (`modules/homerun`, Swift on HomerunKit), as the session sees it.
 * JavaScript never holds a secret (§9.8): the device keys answer `dh` and `sign`, the token owner
 * hands out access tokens, the approval key signs only after Face ID. Binary values cross as
 * base64url strings. Unit tests pass a fake with the same shape.
 */

export interface NativeConfig {
  relayUrl: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  authParams?: Record<string, string>;
  dev: boolean;
}

export interface NativePublicKeys {
  noise: string;
  signing: string;
}

export interface NativeAccount {
  subject: string;
  email?: string;
}

/** A notification the person tapped: what to open. */
export interface NativeTap {
  desktop?: string;
  thread?: string;
  request?: string;
  category?: string;
}

export interface NativePushToken {
  token: string;
  environment: "sandbox" | "production";
}

export interface NativeSubscription {
  remove(): void;
}

export interface HomerunNative {
  readonly pushEnvironment: "sandbox" | "production";
  readonly appAttestSupported: boolean;

  configure(json: string): Promise<void>;

  keysCreate(deviceId: string): Promise<NativePublicKeys>;
  keysLoad(deviceId: string): Promise<NativePublicKeys | null>;
  keysDestroy(): Promise<void>;
  keysDh(peer: string): Promise<string>;
  keysSign(message: string): Promise<string>;

  stateLoad(): Promise<string | null>;
  stateSave(json: string): Promise<void>;
  stateClear(): Promise<void>;
  kvGet(name: string): Promise<string | null>;
  kvSet(name: string, value: string | null): Promise<void>;
  cacheKey(): Promise<string>;
  /** Forgets this device (keys, state, approval key, app records) but keeps the sign-in. */
  resetDevice(): Promise<void>;
  /** Forgets everything, the sign-in too. */
  wipe(): Promise<void>;

  authState(): Promise<NativeAccount | null>;
  /** Null if the person closed the sign-in page. */
  authSignIn(): Promise<NativeAccount | null>;
  authAccessToken(): Promise<string>;
  authRefresh(): Promise<string>;
  authSignOut(): Promise<void>;

  /** `{key_id, object, approval_key?}` as JSON, or null where App Attest isn't available. */
  attest(deviceId: string, staticKey: string, signingKey: string, approvalKey: string | null): Promise<string | null>;
  assertRenewal(keyId: string, deviceId: string, approvalKey: string): Promise<string | null>;
  approvalKeyPublic(): Promise<string | null>;
  approvalKeyCreate(): Promise<string | null>;
  /** Face ID, then the signature; null if the person cancelled. Rejects with `APPROVAL_KEY_UNUSABLE`. */
  approvalSign(deviceId: string, desktopId: string, requestId: string, decision: string, expiresAt: number, reason: string): Promise<string | null>;

  pushRegister(): Promise<boolean>;
  pushLastToken(): Promise<NativePushToken | null>;
  takeTap(): Promise<NativeTap | null>;
  clearDelivered(requestId: string): Promise<void>;

  addListener(event: "pushToken", fn: (t: NativePushToken) => void): NativeSubscription;
  addListener(event: "pushTap", fn: (t: NativeTap) => void): NativeSubscription;
  addListener(event: "pushError", fn: (e: { message: string }) => void): NativeSubscription;
}

/** The code a native rejection carries (`CONFIG`, `NO_KEYS`, `SIGNED_OUT`, `OIDC`, `APPROVAL_KEY_UNUSABLE`). */
export function nativeCode(e: unknown): string | null {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : null;
}
