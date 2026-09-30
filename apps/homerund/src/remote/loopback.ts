import type { Server } from "bun";

/**
 * The sign-in redirect's landing place (RFC 8252 §7.3): an http listener on 127.0.0.1 and an
 * ephemeral port, open for one sign-in attempt only. It takes the first request to `/callback`
 * whose `state` matches, so another local page can't end the attempt with a forged redirect; the
 * OIDC layer validates the response itself. It is never a public port (§9.2).
 */
export interface Loopback {
  redirectUri: string;
  /** Resolves with the callback URL the browser loaded. Call before opening the browser. */
  callback(state: string): Promise<URL>;
  close(): void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:15px -apple-system,system-ui,sans-serif;margin:20vh auto;max-width:28em;text-align:center;color:#222}</style>` +
  `</head><body><h1>${title}</h1><p>${text}</p></body></html>`;

export function openLoopback(): Loopback {
  let wanted: string | null = null;
  let deliver: ((u: URL) => void) | null = null;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const state = url.searchParams.get("state");
      const html = (t: string, b: string, status = 200) =>
        new Response(PAGE(t, b), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" } });
      if (!deliver || state !== wanted) return html("Homerun", "This sign-in link is no longer valid. Return to Homerun and try again.", 400);
      const d = deliver;
      deliver = null;
      d(url);
      return url.searchParams.has("error")
        ? html("Sign-in didn't finish", "Return to Homerun to try again.")
        : html("Signed in", "You can close this tab and return to Homerun.");
    },
  });
  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    callback(state) {
      wanted = state;
      return new Promise((resolve) => (deliver = resolve));
    },
    close() {
      deliver = null;
      // Not forced: the page for the callback that ended the attempt is still being written.
      void server.stop();
    },
  };
}
