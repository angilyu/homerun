/**
 * Which web pages may call the relay (§9.9, §18 row 105): an exact list of origins, the web
 * client's, and nothing else. No wildcard, no `null`, no credentials (the token is a bearer
 * header, never a cookie). A request without an `Origin` is a native client's and passes; so
 * does one whose `Origin` is the relay's own (iOS's WebSocket sends that).
 */

export const CORS_ALLOWED_HEADERS = "authorization, content-type, homerun-device";
export const CORS_ALLOWED_METHODS = "GET, POST, DELETE";

/** Parses `WEB_ORIGINS` (comma-separated). Throws on anything that isn't exactly an origin. */
export function parseWebOrigins(list: string | readonly string[] | undefined): string[] {
  const items = (typeof list === "string" ? list.split(",") : (list ?? [])).map((x) => x.trim()).filter(Boolean);
  for (const o of items) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`WEB_ORIGINS: not an origin: ${o}`);
    }
    const loopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
    if (u.origin !== o || u.hostname.includes("*") || (u.protocol !== "https:" && !loopback)) throw new Error(`WEB_ORIGINS: not an https origin: ${o}`);
  }
  return items;
}

export type OriginCheck = { ok: true; origin: string | null } | { ok: false };

export function checkOrigin(req: Request, allowed: readonly string[]): OriginCheck {
  const origin = req.headers.get("origin");
  if (origin === null) return { ok: true, origin: null };
  if (origin === new URL(req.url).origin) return { ok: true, origin: null };
  return allowed.includes(origin) ? { ok: true, origin } : { ok: false };
}

/** The answer to a preflight from an allowed origin. */
export function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": CORS_ALLOWED_METHODS,
      "access-control-allow-headers": CORS_ALLOWED_HEADERS,
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

/** `res`, readable by `origin`'s page. */
export function withCors(res: Response, origin: string | null): Response {
  if (!origin || res.status === 101) return res;
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
