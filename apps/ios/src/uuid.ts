type Rng = (a: Uint8Array) => Uint8Array;

/** A version 4 UUID from `getRandomValues`. */
export function uuidV4(getRandomValues: Rng): `${string}-${string}-${string}-${string}-${string}` {
  const b = getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `crypto.randomUUID` for `RemoteClient` and app-state's ids, where Hermes has none. */
export function installRandomUUID(c: { getRandomValues: Rng; randomUUID?: () => string }): void {
  if (typeof c.randomUUID !== "function") c.randomUUID = () => uuidV4((a) => c.getRandomValues(a));
}
