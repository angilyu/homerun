import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppClient, Store } from "@homerun/app-state";
import { AppContext, type App, type Route } from "./hooks";
import type { KeyStatus, Platform, UpdateState } from "./platform/types";
import { Root } from "./screens/Root";

/**
 * The app for a platform. The desktop passes its shell; the web client passes none and its own
 * role, and the views leave out what needs the shell or what the role may not do (§9.9).
 */
export function createApp(platform: Platform, client = new AppClient(platform.transport, { remote: true, role: platform.role })): App {
  const route = new Store<Route>({ name: "home" });
  const key = new Store<KeyStatus | null>(null);
  const update = new Store<UpdateState | null>(null);
  const shell = platform.shell;
  return {
    client,
    shell,
    openExternal: (url) => {
      if (shell) void shell.openExternal(url).catch(() => {});
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    settings: platform.settings ?? null,
    retry: platform.retry ?? null,
    route,
    key,
    update,
    go: (r) => route.set(r),
    refreshKey: async () => {
      if (shell) key.set(await shell.keyStatus());
    },
  };
}

export function AppRoot({ app }: { app: App }) {
  return (
    <AppContext.Provider value={app}>
      <Root />
    </AppContext.Provider>
  );
}

/** Mount the app into the page: one AppClient for the window's lifetime. */
export function mount(platform: Platform, el: HTMLElement): void {
  const app = createApp(platform);
  app.client.start();
  // Links in model output open outside the webview (plan §4), or in a new tab on the web.
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && /^(https?:|mailto:)/i.test(href)) app.openExternal(href);
  });
  createRoot(el).render(
    <StrictMode>
      <AppRoot app={app} />
    </StrictMode>,
  );
}
