import { describe, expect, test } from "bun:test";
import { deviceName } from "../../src/device-name";
import { KvStore, MemoryKv, TokenVault } from "../../src/storage";

describe("the token vault", () => {
  test("seals the refresh token under a key the page can't export", async () => {
    const kv = new MemoryKv();
    const vault = new TokenVault(kv);
    expect(await vault.load()).toBeNull();
    await vault.save({ refreshToken: "rt-1", subject: "user_a" });
    expect(await vault.load()).toEqual({ refreshToken: "rt-1", subject: "user_a" });
    const key = await kv.get<CryptoKey>("vault", "key");
    expect(key?.extractable).toBe(false);
    expect(crypto.subtle.exportKey("raw", key!)).rejects.toThrow();
    // Nothing in storage holds the token in the clear.
    const sealed = await kv.get<{ data: ArrayBuffer }>("vault", "session");
    expect(new TextDecoder().decode(sealed!.data)).not.toContain("rt-1");
    await vault.save({ refreshToken: "rt-2", subject: null });
    expect(await vault.load()).toEqual({ refreshToken: "rt-2", subject: null });
  });

  test("drops a session it can't open", async () => {
    const kv = new MemoryKv();
    const vault = new TokenVault(kv);
    await vault.save({ refreshToken: "rt", subject: "s" });
    const sealed = await kv.get<{ iv: Uint8Array; data: ArrayBuffer }>("vault", "session");
    const bad = new Uint8Array(sealed!.data);
    bad[0]! ^= 1;
    await kv.put("vault", "session", { iv: sealed!.iv, data: bad.buffer });
    expect(await vault.load()).toBeNull();
    expect(await kv.get("vault", "session")).toBeUndefined();
    expect(await kv.get("vault", "key")).toBeUndefined();
  });

  test("clear forgets the session and its key", async () => {
    const kv = new MemoryKv();
    const vault = new TokenVault(kv);
    await vault.save({ refreshToken: "rt", subject: "s" });
    await vault.clear();
    expect(await vault.load()).toBeNull();
    expect(await kv.get("vault", "key")).toBeUndefined();
  });
});

describe("the remote store", () => {
  test("remembers whose browser this is apart from the device it registered", async () => {
    const store = new KvStore(new MemoryKv());
    expect(await store.owner()).toBeNull();
    await store.setOwner("user_a");
    await store.save({ marker: 1 } as never);
    expect(await store.owner()).toBe("user_a");
    // Forgetting the device (unlinked) keeps whose browser it is.
    await store.clear();
    expect(await store.load()).toBeNull();
    expect(await store.owner()).toBe("user_a");
  });
});

describe("the device name", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["", "A browser"],
  ];
  for (const [ua, name] of cases) test(name, () => expect(deviceName(ua)).toBe(name));
});
