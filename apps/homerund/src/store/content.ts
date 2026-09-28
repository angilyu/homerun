import { createHash } from "node:crypto";
import { BLOB_INLINE_MAX_BYTES, BLOB_PREVIEW_MAX_CHARS, Content, jsonByteLength, type JsonValue } from "@homerun/core";
import type { Store } from "./store";

/** Anything the SDK hands us, made JSON-safe (undefined dropped, cycles and bigints stringified). */
export function toJsonValue(v: unknown): JsonValue {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? "null") as JsonValue;
  } catch {
    return String(v);
  }
}

/**
 * A tool input or output as core `Content` (§6.1): inline up to 4 KB of JSON, otherwise stored
 * once in `blobs` by SHA-256. A string is stored as its UTF-8 text; any other value as JSON.
 */
export function toContent(store: Store, value: unknown, now = Date.now()): Content {
  const v = toJsonValue(value);
  if (jsonByteLength(v) <= BLOB_INLINE_MAX_BYTES) return Content.parse({ kind: "inline", value: v });
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const bytes = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  store.db
    .query("INSERT OR IGNORE INTO blobs (sha256, bytes, size, created_at, expires_at) VALUES (?, ?, ?, ?, NULL)")
    .run(sha256, bytes, bytes.length, now);
  return Content.parse({ kind: "blob", sha256, size: bytes.length, preview: preview(text), expired: false });
}

/** First 500 characters, never splitting a surrogate pair. */
export function preview(text: string): string {
  if (text.length <= BLOB_PREVIEW_MAX_CHARS) return text;
  let end = BLOB_PREVIEW_MAX_CHARS;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}

export function getBlob(store: Store, sha256: string): { bytes: Uint8Array; size: number } | null {
  const row = store.db.query<{ bytes: Uint8Array; size: number }, [string]>("SELECT bytes, size FROM blobs WHERE sha256 = ?").get(sha256);
  return row ?? null;
}

/** The value behind a Content, for recovery and tests. Null if the blob has expired. */
export function contentValue(store: Store, c: Content): unknown {
  if (c.kind === "inline") return c.value;
  const b = getBlob(store, c.sha256);
  if (!b) return null;
  const text = Buffer.from(b.bytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
