import { log } from "../log";

export type KeyCheck = { outcome: "valid" | "invalid" | "unreachable"; detail?: string };

export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * secrets.verify (§7.2): is this an Anthropic API key the API accepts? One `GET /v1/models`,
 * which costs no tokens. The key goes only to Anthropic (or the development base URL) and is
 * neither kept nor logged. 401 and 403 mean the key is wrong or disabled; 429 means it is
 * valid but busy; anything else (no network, 5xx, timeout) is `unreachable`, so the shell can
 * still store the key and let the first run report a real problem.
 */
export async function verifyAnthropicKey(
  key: string,
  baseUrl: string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<KeyCheck> {
  const url = `${(baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/models?limit=1`;
  try {
    const res = await fetchImpl(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || res.status === 429) return { outcome: "valid" };
    if (res.status === 401 || res.status === 403) return { outcome: "invalid", detail: (await errorType(res)) ?? `HTTP ${res.status}` };
    return { outcome: "unreachable", detail: `HTTP ${res.status}` };
  } catch (e) {
    const detail = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "no connection";
    log.info("api key check did not get an answer", { detail });
    return { outcome: "unreachable", detail };
  }
}

async function errorType(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { type?: unknown } };
    return typeof body.error?.type === "string" ? body.error.type.slice(0, 100) : null;
  } catch {
    return null;
  }
}
