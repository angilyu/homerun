import { SignedVersionPolicy } from "@homerun/protocol";
import { errorResponse } from "./account";

/**
 * GET /v1/version-policy (§11 "Updates and control"): the signed version policy, public and
 * cacheable, before any token check, so a signed-out desktop, the iPhone app and the web client
 * can all read it. The relay only serves the bytes the operator published (`VERSION_POLICY`); it
 * holds no signing key, so a compromised relay can withhold or replay a policy but not forge one.
 */

/** Long enough that a CDN absorbs a stampede, short enough that a kill reaches clients within minutes. */
export const VERSION_POLICY_MAX_AGE_S = 300;

export function versionPolicyResponse(req: Request, published: string | null | undefined): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return errorResponse("not_found", "no such endpoint");
  const raw = published?.trim();
  if (!raw) {
    // Nothing published: clients fail open. Cached briefly, like a policy.
    const r = errorResponse("not_found", "no version policy is published");
    r.headers.set("cache-control", "public, max-age=60");
    return r;
  }
  let ok = false;
  try {
    ok = SignedVersionPolicy.safeParse(JSON.parse(raw)).success;
  } catch {
    ok = false;
  }
  // A malformed publication is the operator's mistake; say so rather than serve it.
  if (!ok) return errorResponse("internal", "the published version policy is malformed");
  return new Response(req.method === "HEAD" ? null : raw, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${VERSION_POLICY_MAX_AGE_S}`,
    },
  });
}
