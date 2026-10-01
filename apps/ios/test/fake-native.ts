import { Account } from "@homerun/remote";
import { approvalRenewalClientDataHash, ed25519Key, fromB64url, toB64url, x25519Dh, x25519Key, type AttestedIdentity } from "@homerun/protocol";
import { testApprovalKey, testAssertion, type TestApprovalKey, type TestAppAttestCA } from "@homerun/protocol/testing";
import type { HomerunNative, NativeAccount, NativePushToken, NativeSubscription, NativeTap } from "../src/native";

/**
 * The Swift module as a test sees it: one simulated iPhone. Its Keychain (a Map) outlives app
 * launches, as the real one outlives the app; tokens come from the local issuer through
 * `Account` (Swift's token owner does the same OIDC); App Attest is the test CA; the Face ID
 * approval key is a P-256 key the test can invalidate, as a Face ID enrolment change does.
 */

type Issuer = { url: string; clientId: string; browse(url: string): Promise<URL> };

export class FakeNative implements HomerunNative {
  pushEnvironment = "sandbox" as const;
  appAttestSupported = true;
  /** No Secure Enclave or biometry: no approval key. */
  biometry = true;
  /** The person closes the sign-in sheet. */
  cancelSignIn = false;
  /** The person cancels Face ID. */
  cancelFaceId = false;
  readonly keychain = new Map<string, string>();
  readonly calls: string[] = [];
  private account: Account | null = null;
  private config: string | null = null;
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  private credentials = new Map<string, { secret: Uint8Array; counter: number }>();
  private approval: TestApprovalKey | null = null;
  private approvalInvalid = false;
  private tap: NativeTap | null = null;
  pushToken: NativePushToken | null = null;

  constructor(
    private readonly issuer: Issuer,
    private readonly ca: TestAppAttestCA,
  ) {}

  /** A fresh launch of the app on this phone: listeners go, the Keychain and the sign-in stay. */
  relaunch(): void {
    this.listeners.clear();
  }

  async configure(json: string): Promise<void> {
    this.calls.push("configure");
    JSON.parse(json);
    if (this.config === null) {
      this.keychain.clear();
      this.account = null;
    }
    this.config = json;
  }

  // ---------------------------------------------------------------- keys

  async keysCreate(deviceId: string) {
    const noise = crypto.getRandomValues(new Uint8Array(32));
    const signing = crypto.getRandomValues(new Uint8Array(32));
    this.keychain.set("keys", JSON.stringify({ deviceId, noise: toB64url(noise), signing: toB64url(signing) }));
    return this.publicKeys();
  }

  async keysLoad(deviceId: string) {
    const k = this.keys();
    return k && k.deviceId === deviceId ? this.publicKeys() : null;
  }

  async keysDestroy() {
    this.keychain.delete("keys");
  }

  async keysDh(peer: string) {
    return toB64url(x25519Dh(fromB64url(this.need().noise), fromB64url(peer)));
  }

  async keysSign(message: string) {
    return toB64url(await ed25519Key(fromB64url(this.need().signing)).sign(fromB64url(message)));
  }

  private keys(): { deviceId: string; noise: string; signing: string } | null {
    const raw = this.keychain.get("keys");
    return raw ? JSON.parse(raw) : null;
  }

  private need() {
    const k = this.keys();
    if (!k) throw Object.assign(new Error("no device keys"), { code: "NO_KEYS" });
    return k;
  }

  private publicKeys() {
    const k = this.need();
    return { noise: toB64url(x25519Key(fromB64url(k.noise)).publicKey), signing: toB64url(ed25519Key(fromB64url(k.signing)).publicKey) };
  }

  // ---------------------------------------------------------------- stores

  async stateLoad() {
    return this.keychain.get("state") ?? null;
  }
  async stateSave(json: string) {
    this.keychain.set("state", json);
  }
  async stateClear() {
    this.keychain.delete("state");
  }
  async kvGet(name: string) {
    return this.keychain.get(`kv.${name}`) ?? null;
  }
  async kvSet(name: string, value: string | null) {
    if (value === null) this.keychain.delete(`kv.${name}`);
    else this.keychain.set(`kv.${name}`, value);
  }
  async cacheKey() {
    let k = this.keychain.get("cache-key");
    if (!k) this.keychain.set("cache-key", (k = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")));
    return k;
  }

  async resetDevice() {
    this.calls.push("resetDevice");
    this.approval = null;
    for (const k of [...this.keychain.keys()]) if (k !== "tokens") this.keychain.delete(k);
  }

  async wipe() {
    this.calls.push("wipe");
    this.approval = null;
    this.keychain.clear();
    this.account = null;
    this.pushToken = null;
  }

  // ---------------------------------------------------------------- account

  private newAccount() {
    return Account.create({
      issuer: this.issuer.url,
      clientId: this.issuer.clientId,
      allowInsecureLoopback: true,
      redirectUri: "http://127.0.0.1:53682/callback",
      browser: (url) => this.issuer.browse(url),
    });
  }

  private me(): NativeAccount | null {
    const a = this.account;
    return a?.signedIn && a.subject ? { subject: a.subject, ...(a.email ? { email: a.email } : {}) } : null;
  }

  async authState() {
    return this.keychain.has("tokens") ? this.me() : null;
  }

  async authSignIn() {
    if (this.cancelSignIn) return null;
    const a = await this.newAccount();
    await a.signIn();
    this.account = a;
    this.keychain.set("tokens", "1");
    return this.me();
  }

  async authAccessToken() {
    if (!this.account?.signedIn) throw Object.assign(new Error("signed out"), { code: "SIGNED_OUT" });
    return this.account.accessToken();
  }

  async authRefresh() {
    if (!this.account?.signedIn) throw Object.assign(new Error("signed out"), { code: "SIGNED_OUT" });
    return (await this.account.refresh()).accessToken;
  }

  async authSignOut() {
    this.calls.push("authSignOut");
    await this.account?.signOut();
    this.account = null;
    this.keychain.delete("tokens");
  }

  // ---------------------------------------------------------------- App Attest and Face ID

  async attest(deviceId: string, staticKey: string, signingKey: string, approvalKey: string | null) {
    this.calls.push("attest");
    if (!this.appAttestSupported) return null;
    const c = this.ca.attest(
      { device_id: deviceId as AttestedIdentity["device_id"], static_public_key: staticKey, signing_public_key: signingKey },
      approvalKey ? { approvalKey } : {},
    );
    this.credentials.set(c.attestation.key_id, { secret: c.credentialSecretKey, counter: 0 });
    return JSON.stringify(c.attestation);
  }

  async assertRenewal(keyId: string, deviceId: string, approvalKey: string) {
    this.calls.push("assertRenewal");
    const c = this.credentials.get(keyId);
    if (!c) return null;
    return toB64url(testAssertion(c.secret, approvalRenewalClientDataHash(deviceId, approvalKey), ++c.counter));
  }

  async approvalKeyPublic() {
    return this.approval?.publicKey ?? null;
  }

  async approvalKeyCreate() {
    if (!this.biometry) return null;
    this.approval = testApprovalKey();
    this.approvalInvalid = false;
    return this.approvalKeyPublic();
  }

  /** Face ID enrolment changed: the approval key can't sign any more. */
  changeFaceId(): void {
    this.approvalInvalid = true;
  }

  async approvalSign(deviceId: string, desktopId: string, requestId: string, decision: string, expiresAt: number, _reason: string) {
    this.calls.push("approvalSign");
    if (!this.approval || this.approvalInvalid) throw Object.assign(new Error("unusable"), { code: "APPROVAL_KEY_UNUSABLE" });
    if (this.cancelFaceId) return null;
    return this.approval.sign({ device_id: deviceId, desktop_id: desktopId, request_id: requestId, decision, expires_at: expiresAt });
  }

  // ---------------------------------------------------------------- pushes

  async pushRegister() {
    this.calls.push("pushRegister");
    this.pushToken ??= { token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), environment: "sandbox" };
    const t = this.pushToken;
    queueMicrotask(() => this.emit("pushToken", t));
    return true;
  }

  async pushLastToken() {
    return this.pushToken;
  }

  async takeTap() {
    const t = this.tap;
    this.tap = null;
    return t;
  }

  /** The person taps a notification. */
  tapNotification(t: NativeTap): void {
    this.tap = t;
    this.emit("pushTap", t);
  }

  async clearDelivered(_requestId: string) {}

  addListener(event: string, fn: (e: never) => void): NativeSubscription {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const f = fn as (e: unknown) => void;
    set.add(f);
    return { remove: () => set.delete(f) };
  }

  private emit(event: string, e: unknown): void {
    for (const f of this.listeners.get(event) ?? []) f(e);
  }
}
