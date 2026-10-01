import { CryptoError, DH_LEN, fromB64url, toB64url } from "@homerun/protocol";
import { SignedOutError, type DeviceKeyPair, type DeviceKeyStore, type RemoteState, type RemoteStore, type TokenSource } from "@homerun/remote";
import { nativeCode, type HomerunNative, type NativeAccount, type NativePublicKeys } from "./native";

/**
 * The `@homerun/remote` seams over the native module (§9.8): the account is Swift's token owner
 * (so a lock-screen answer can refresh a token with no JavaScript running), the device keys are
 * Keychain items JavaScript can only ask to `dh` and `sign`, and the remote state is a Keychain
 * item the Notification Service Extension reads too.
 */

/** The signed-in account, from Swift's token owner. `subject` is kept here: it is read synchronously. */
export class NativeTokens implements TokenSource {
  private account: NativeAccount | null = null;

  constructor(private readonly native: HomerunNative) {}

  get subject(): string | null {
    return this.account?.subject ?? null;
  }
  get email(): string | null {
    return this.account?.email ?? null;
  }
  get signedIn(): boolean {
    return this.account !== null;
  }

  /** Reads who is signed in, from tokens a previous launch kept. */
  async load(): Promise<NativeAccount | null> {
    this.account = await this.native.authState();
    return this.account;
  }

  /** Signs in in the system's sign-in sheet; null if the person closed it. */
  async signIn(): Promise<NativeAccount | null> {
    const a = await this.native.authSignIn();
    if (a) this.account = a;
    return a;
  }

  accessToken(): Promise<string> {
    return this.guard(() => this.native.authAccessToken());
  }

  async refresh(): Promise<{ accessToken: string }> {
    return { accessToken: await this.guard(() => this.native.authRefresh()) };
  }

  async signOut(): Promise<void> {
    this.account = null;
    await this.native.authSignOut();
  }

  /** A session that ended at the provider becomes `SignedOutError`, as `Account` throws. */
  private async guard<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (nativeCode(e) === "SIGNED_OUT") {
        this.account = null;
        throw new SignedOutError("the session ended; sign in again");
      }
      throw e;
    }
  }
}

/** The device's X25519 and Ed25519 keys, in the Keychain (`ThisDeviceOnly`, shared with the extension). */
export class NativeKeys implements DeviceKeyStore {
  constructor(private readonly native: HomerunNative) {}

  async create(deviceId: string): Promise<DeviceKeyPair> {
    return this.handles(await this.native.keysCreate(deviceId));
  }

  async load(deviceId: string): Promise<DeviceKeyPair | null> {
    const k = await this.native.keysLoad(deviceId);
    return k ? this.handles(k) : null;
  }

  destroy(): Promise<void> {
    return this.native.keysDestroy();
  }

  private handles(k: NativePublicKeys): DeviceKeyPair {
    const native = this.native;
    return {
      noise: {
        publicKey: fromB64url(k.noise),
        async dh(theirPublic) {
          if (theirPublic.length !== DH_LEN) throw new CryptoError("bad public key length");
          let out: Uint8Array;
          try {
            out = fromB64url(await native.keysDh(toB64url(theirPublic)));
          } catch {
            throw new CryptoError("invalid public key");
          }
          if (out.length !== DH_LEN || out.every((b) => b === 0)) throw new CryptoError("invalid public key");
          return out;
        },
      },
      signing: {
        publicKey: fromB64url(k.signing),
        sign: async (m) => fromB64url(await native.keysSign(toB64url(m))),
      },
    };
  }
}

/**
 * The remote state (device id, paired desktops, opened message ids) as one Keychain item the
 * extension also reads, to know which desktops' pushes to open. Remembers whose it is, so a
 * different person signing in on this phone starts as a new device.
 */
export class NativeStore implements RemoteStore {
  constructor(private readonly native: HomerunNative) {}

  async load(): Promise<RemoteState | null> {
    const raw = await this.native.stateLoad();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RemoteState;
    } catch {
      return null;
    }
  }

  save(state: RemoteState): Promise<void> {
    return this.native.stateSave(JSON.stringify(state));
  }

  clear(): Promise<void> {
    return this.native.stateClear();
  }

  owner(): Promise<string | null> {
    return this.native.kvGet("owner");
  }

  setOwner(subject: string): Promise<void> {
    return this.native.kvSet("owner", subject);
  }
}
