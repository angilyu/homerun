import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApp } from "@homerun/desktop/app";
import "@homerun/desktop/styles.css";
import { builtInConfig } from "./config";
import { browserEnv, WebSession } from "./session";
import { openIdb } from "./storage";
import { WebRoot, WebSettings } from "./ui";
import "./web.css";

const root = createRoot(document.getElementById("root")!);
const config = builtInConfig();

if (!config) {
  document.getElementById("root")!.textContent = "This build of Homerun isn’t set up: it has no relay or sign-in configured.";
} else {
  void openIdb().then(
    (kv) => {
      const session = new WebSession(browserEnv(config, kv), (transport) =>
        createApp({ transport, shell: null, role: "web", settings: WebSettings, retry: () => transport.retry() }),
      );
      // Links in model output open in a new tab, never in place of the app.
      document.addEventListener("click", (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (href && /^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      });
      window.addEventListener("pagehide", () => session.close());
      // Back from the back-forward cache, the session is closed: start again.
      window.addEventListener("pageshow", (e) => e.persisted && location.reload());
      root.render(
        <StrictMode>
          <WebRoot session={session} />
        </StrictMode>,
      );
      void session.start();
    },
    () => {
      document.getElementById("root")!.textContent = "Homerun needs this site’s storage. Allow site data for it, or leave private browsing, and reload.";
    },
  );
}
