import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppClient, Store } from "@homerun/app-state";
import { AppContext, type App, type Route } from "./hooks";
import type { KeyStatus, Platform } from "./platform/types";
import { Root } from "./screens/Root";

export function createApp(platform: Platform, client = new AppClient(platform.transport)): App {
  const route = new Store<Route>({ name: "home" });
  const key = new Store<KeyStatus | null>(null);
  return {
    client,
    shell: platform.shell,
    route,
    key,
    go: (r) => route.set(r),
    refreshKey: async () => key.set(await platform.shell.keyStatus()),
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
  // Links in model output open outside the webview (plan §4).
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && /^(https?:|mailto:)/i.test(href)) void platform.shell.openExternal(href).catch(() => {});
  });
  createRoot(el).render(
    <StrictMode>
      <AppRoot app={app} />
    </StrictMode>,
  );
}
