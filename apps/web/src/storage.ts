import type { CryptoKeyDb, RemoteState, RemoteStore } from "@homerun/remote";

/**
 * What the browser keeps between visits (§9.9), all in one IndexedDB database of this origin:
 * the device's non-extractable WebCrypto keys, its pairings (`RemoteState`), and the refresh
 * token, encrypted with a non-extractable AES-GCM key. Chat history is never stored: it lives in
 * memory and comes again from the desktop.
 */

export type Area = "keys" | "state" | "vault";
const AREAS: readonly Area[] = ["keys", "state", "vault"];

/** A key-value store with a few areas; IndexedDB in the browser, memory in unit tests. */
export interface Kv {
  get<T>(area: Area, key: string): Promise<T | undefined>;
  put(area: Area, key: string, value: unknown): Promise<void>;
  delete(area: Area, key: string): Promise<void>;
  clear(area: Area): Promise<void>;
}

export class MemoryKv implements Kv {
  private areas = new Map<Area, Map<string, unknown>>(AREAS.map((a) => [a, new Map()]));
  async get<T>(area: Area, key: string) {
    return this.areas.get(area)!.get(key) as T | undefined;
  }
  async put(area: Area, key: string, value: unknown) {
    this.areas.get(area)!.set(key, value);
  }
  async delete(area: Area, key: string) {
    this.areas.get(area)!.delete(key);
  }
  async clear(area: Area) {
    this.areas.get(area)!.clear();
  }
}

/** Opens this origin's database. Rejects where IndexedDB is missing or blocked (private modes that refuse it). */
export function openIdb(name = "homerun"): Promise<Kv> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const a of AREAS) if (!req.result.objectStoreNames.contains(a)) req.result.createObjectStore(a);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB didn't open"));
    req.onblocked = () => reject(new Error("IndexedDB is blocked"));
    req.onsuccess = () => resolve(new IdbKv(req.result));
  });
}

class IdbKv implements Kv {
  constructor(private readonly db: IDBDatabase) {}

  private run<T>(area: Area, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(area, mode);
      const req = op(tx.objectStore(area));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
    });
  }

  get<T>(area: Area, key: string) {
    return this.run<T | undefined>(area, "readonly", (s) => s.get(key));
  }
  async put(area: Area, key: string, value: unknown) {
    await this.run(area, "readwrite", (s) => s.put(value, key));
  }
  async delete(area: Area, key: string) {
    await this.run(area, "readwrite", (s) => s.delete(key));
  }
  async clear(area: Area) {
    await this.run(area, "readwrite", (s) => s.clear());
  }
}

/** The device's key pairs, stored as CryptoKey objects: IndexedDB keeps them non-extractable. */
export class KvKeyDb implements CryptoKeyDb {
  constructor(private readonly kv: Kv) {}
  get(name: string) {
    return this.kv.get<CryptoKeyPair>("keys", name);
  }
  put(name: string, keys: CryptoKeyPair) {
    return this.kv.put("keys", name, keys);
  }
  clear() {
    return this.kv.clear("keys");
  }
}

/** This browser's device and the desktops it is linked with. */
export class KvStore implements RemoteStore {
  constructor(private readonly kv: Kv) {}
  async load() {
    return (await this.kv.get<RemoteState>("state", "remote")) ?? null;
  }
  save(state: RemoteState) {
    return this.kv.put("state", "remote", state);
  }
  clear() {
    return this.kv.delete("state", "remote");
  }
  /** Whose device this is: the account subject that last signed in here. */
  async owner() {
    return (await this.kv.get<string>("state", "owner")) ?? null;
  }
  setOwner(subject: string) {
    return this.kv.put("state", "owner", subject);
  }
}

/** The signed-in session to resume on the next visit. */
export interface SavedSession {
  refreshToken: string;
  /** Whose it is: a different person signing in on this browser starts a new device. */
  subject: string | null;
}

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

/**
 * The refresh token at rest, sealed with an AES-GCM key that can't be read out of the browser.
 * It keeps the token out of plain storage (a copied profile, a storage viewer); script running
 * on the page can still use it, which is why the page's own script is the boundary (§9.9).
 */
export class TokenVault {
  constructor(
    private readonly kv: Kv,
    private readonly subtle: SubtleCrypto = crypto.subtle,
  ) {}

  private async key(): Promise<CryptoKey> {
    const have = await this.kv.get<CryptoKey>("vault", "key");
    if (have) return have;
    const key = await this.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.kv.put("vault", "key", key);
    return key;
  }

  async save(s: SavedSession): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await this.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), new TextEncoder().encode(JSON.stringify(s)));
    await this.kv.put("vault", "session", { iv, data } satisfies Sealed);
  }

  /** The saved session, or null if there is none or it can't be opened (then it is dropped). */
  async load(): Promise<SavedSession | null> {
    const sealed = await this.kv.get<Sealed>("vault", "session");
    const key = await this.kv.get<CryptoKey>("vault", "key");
    if (!sealed || !key) return null;
    try {
      const plain = await this.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sealed.iv) }, key, sealed.data);
      const s = JSON.parse(new TextDecoder().decode(plain)) as SavedSession;
      if (typeof s.refreshToken !== "string" || !s.refreshToken) throw new Error("malformed");
      return { refreshToken: s.refreshToken, subject: typeof s.subject === "string" ? s.subject : null };
    } catch {
      await this.clear();
      return null;
    }
  }

  /** Forgets the session and its key. */
  async clear(): Promise<void> {
    await this.kv.clear("vault");
  }
}
