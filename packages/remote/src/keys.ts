import { CryptoError, DH_LEN, type DhKey, type SigningKey } from "@homerun/protocol";

/**
 * Where a remote device's secret keys live (§12). The client holds only handles: `dh` and `sign`
 * are async so the private halves can stay where JavaScript can't read them, a non-extractable
 * WebCrypto key in IndexedDB on the web (§9.9), the Keychain behind a native module on iOS (§9.8).
 * Without one, `RemoteClient` keeps raw keys in its `RemoteStore`, as tests and M9 did.
 */
export interface DeviceKeyStore {
  /** New keys for this device, replacing any. */
  create(deviceId: string): Promise<DeviceKeyPair>;
  /** This device's keys, or null if they are gone (cleared site data, a restored backup). */
  load(deviceId: string): Promise<DeviceKeyPair | null>;
  /** Forgets every key. */
  destroy(): Promise<void>;
}

export interface DeviceKeyPair {
  noise: DhKey;
  signing: SigningKey;
}

/** Somewhere to keep `CryptoKey` objects: IndexedDB in a browser (structured clone keeps them opaque). */
export interface CryptoKeyDb {
  get(name: string): Promise<CryptoKeyPair | undefined>;
  put(name: string, keys: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
}

/** Whether this browser can make non-extractable X25519 and Ed25519 keys (Chrome 137+, Safari 17+, Firefox 130+). */
export async function supportsWebCryptoKeys(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<boolean> {
  if (!subtle) return false;
  try {
    await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The web client's keys (§9.9): WebCrypto X25519 and Ed25519 made with `extractable: false` and
 * kept in a `CryptoKeyDb`. A page can use them while it is open but can never read them out, so
 * a copied profile or a script that runs later can't take the device's identity elsewhere.
 * There is no JavaScript fallback with raw keys: a browser without these algorithms is refused.
 */
export class WebCryptoKeys implements DeviceKeyStore {
  constructor(
    private readonly db: CryptoKeyDb,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
  ) {}

  async create(deviceId: string): Promise<DeviceKeyPair> {
    await this.db.clear();
    const x = (await this.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const e = (await this.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    if (x.privateKey.extractable || e.privateKey.extractable) throw new CryptoError("the browser made an extractable key");
    await this.db.put(`${deviceId}/x25519`, x);
    await this.db.put(`${deviceId}/ed25519`, e);
    return this.handles(x, e);
  }

  async load(deviceId: string): Promise<DeviceKeyPair | null> {
    const x = await this.db.get(`${deviceId}/x25519`);
    const e = await this.db.get(`${deviceId}/ed25519`);
    if (!x || !e) return null;
    return this.handles(x, e);
  }

  async destroy(): Promise<void> {
    await this.db.clear();
  }

  private async handles(x: CryptoKeyPair, e: CryptoKeyPair): Promise<DeviceKeyPair> {
    const subtle = this.subtle;
    const xPub = new Uint8Array(await subtle.exportKey("raw", x.publicKey));
    const ePub = new Uint8Array(await subtle.exportKey("raw", e.publicKey));
    return {
      noise: {
        publicKey: xPub,
        async dh(theirPublic) {
          if (theirPublic.length !== DH_LEN) throw new CryptoError("bad public key length");
          let out: Uint8Array;
          try {
            const pub = await subtle.importKey("raw", theirPublic as Uint8Array<ArrayBuffer>, { name: "X25519" }, true, []);
            out = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, x.privateKey, 256));
          } catch {
            throw new CryptoError("invalid public key");
          }
          // WebCrypto refuses an all-zero secret already; checked again as x25519Dh does.
          if (out.every((b) => b === 0)) throw new CryptoError("invalid public key");
          return out;
        },
      },
      signing: {
        publicKey: ePub,
        sign: async (m) => new Uint8Array(await subtle.sign("Ed25519", e.privateKey, m as Uint8Array<ArrayBuffer>)),
      },
    };
  }
}

/** A `CryptoKeyDb` in memory, for tests. */
export class MemoryKeyDb implements CryptoKeyDb {
  private keys = new Map<string, CryptoKeyPair>();
  async get(name: string) {
    return this.keys.get(name);
  }
  async put(name: string, keys: CryptoKeyPair) {
    this.keys.set(name, keys);
  }
  async clear() {
    this.keys.clear();
  }
}
