import { describe, expect, test } from "bun:test";
import { RpcCallError } from "@homerun/app-state";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FakeShell, baseTransport, renderApp, renderWeb } from "./support";

type State = "ok" | "update_required" | "killed";

/** The runtime's gate status (§11), as version.status and version.changed carry it. */
function gate(state: State, o: { interactive?: boolean; url?: string | null; message?: string | null } = {}) {
  return {
    verdict: {
      state,
      reason: state === "ok" ? null : state === "killed" ? "killed" : "below_minimum",
      unattended_allowed: state === "ok",
      interactive_allowed: o.interactive ?? true,
      min_version: state === "update_required" ? "2.0.0" : null,
      message: o.message ?? null,
      url: o.url ?? null,
    },
    policy: null,
    checked_at: null,
    last_error: null,
    version: "1.0.0",
    platform: "macos",
    channel: "stable",
  };
}

describe("the version banner (§11 Updates and control)", () => {
  test("below the minimum: a banner with Update, which asks the updater; it clears when the policy does", async () => {
    const t = baseTransport();
    t.handlers["version.status"] = () => ({ status: gate("ok") });
    const h = await renderApp({ t });
    await waitFor(() => expect(t.called("version.status").length).toBe(1));
    expect(screen.queryByRole("alert", { name: "Update required" })).toBeNull();

    act(() => t.notify("version.changed", { status: gate("update_required") }));
    const banner = await screen.findByRole("alert", { name: "Update required" });
    expect(banner.textContent).toContain("2.0.0");
    expect(banner.textContent).not.toContain("On your Mac");
    expect(banner.textContent).not.toContain("Chat is paused");
    expect(within(banner).queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Update" }));
    expect(h.shell.calls).toContain("checkForUpdates");

    act(() => t.notify("version.changed", { status: gate("ok") }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Update required" })).toBeNull());
  });

  test("killed with chat paused: says so, links the policy's page, and follows the updater's state", async () => {
    const t = baseTransport();
    const url = "https://homerun.example/incident";
    t.handlers["version.status"] = () => ({ status: gate("killed", { interactive: false, url, message: "A bug in this version can repeat scheduled tasks." }) });
    const shell = new FakeShell();
    const h = await renderApp({ t, shell });
    const banner = await screen.findByRole("alert", { name: "Update required" });
    expect(banner.className).toContain("danger");
    expect(banner.textContent).toContain("A bug in this version can repeat scheduled tasks.");
    expect(banner.textContent).toContain("Chat is paused too.");
    fireEvent.click(within(banner).getByRole("button", { name: "Details" }));
    expect(shell.opened).toContain(url);

    act(() => shell.emit({ type: "update", state: { state: "ready", version: "2.0.0", note: null } }));
    fireEvent.click(await within(banner).findByRole("button", { name: "Restart to update" }));
    expect(h.shell.calls).toContain("restartToUpdate");

    act(() => shell.emit({ type: "update", state: { state: "manual", version: "2.0.0", reason: "Homerun can't replace itself here." } }));
    fireEvent.click(await within(banner).findByRole("button", { name: "Download update" }));
    expect(shell.opened.at(-1)).toBe(url);
  });

  test("the web client shows the Mac's gate, without an updater button", async () => {
    const t = baseTransport();
    t.handlers["version.status"] = () => ({ status: gate("update_required") });
    await renderWeb({ t });
    const banner = await screen.findByRole("alert", { name: "Update required" });
    expect(banner.textContent).toMatch(/^On your Mac: /);
    expect(within(banner).queryByRole("button", { name: "Update" })).toBeNull();
  });

  test("a runtime without the gate (older, or the call fails) shows nothing", async () => {
    await renderApp();
    await Bun.sleep(20);
    expect(screen.queryByRole("alert", { name: "Update required" })).toBeNull();
  });
});

describe("crash reports (§11 Diagnostics)", () => {
  const crashTransport = (available: boolean, enabled = false) => {
    const t = baseTransport();
    const s = { available, enabled };
    t.handlers["diagnostics.crash_reports.get"] = () => ({ settings: { ...s } });
    t.handlers["diagnostics.crash_reports.set"] = (p) => {
      s.enabled = (p as { enabled: boolean }).enabled;
      return { settings: { ...s } };
    };
    return { t, s };
  };

  test("hidden in a build without a crash-report endpoint", async () => {
    const { t } = crashTransport(false);
    await renderApp({ t, route: { name: "settings" } });
    const section = await screen.findByRole("region", { name: "Diagnostics" });
    await waitFor(() => expect(t.called("diagnostics.crash_reports.get").length).toBe(1));
    expect(within(section).queryByRole("checkbox", { name: "Send crash reports" })).toBeNull();
  });

  test("off by default; ticking it in Settings turns it on", async () => {
    const { t, s } = crashTransport(true);
    await renderApp({ t, route: { name: "settings" } });
    const box = (await screen.findByRole("checkbox", { name: "Send crash reports" })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Never your chats, tasks, files, links or keys/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(s.enabled).toBe(true));
    await waitFor(() => expect(box.checked).toBe(true));
  });

  test("onboarding offers it unticked, and only a tick turns it on", async () => {
    for (const tick of [false, true]) {
      const { t, s } = crashTransport(true);
      const shell = new FakeShell();
      shell.shellPrefs.keep_running_asked = false;
      await renderApp({ t, shell });
      const box = (await screen.findByRole("checkbox", { name: "Send crash reports" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      if (tick) fireEvent.click(box);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("navigation");
      expect(s.enabled).toBe(tick);
      expect(t.called("diagnostics.crash_reports.set").length).toBe(tick ? 1 : 0);
      cleanup();
    }
  });

  test("onboarding in a build without the endpoint doesn't mention it", async () => {
    const { t } = crashTransport(false);
    const shell = new FakeShell();
    shell.shellPrefs.keep_running_asked = false;
    await renderApp({ t, shell });
    await screen.findByRole("heading", { name: "Keep Homerun running" });
    await waitFor(() => expect(t.called("diagnostics.crash_reports.get").length).toBe(1));
    expect(screen.queryByRole("checkbox", { name: "Send crash reports" })).toBeNull();
  });
});

describe("the diagnostic bundle (§11 Diagnostics)", () => {
  const files = [
    { name: "versions.json", bytes: 220, description: "App, runtime, OS and processor" },
    { name: "logs/homerund.log", bytes: 51_200, description: "The runtime's log, redacted" },
    { name: "database.json", bytes: 512, description: "Schema version and row counts" },
  ];

  test("shows the file list first, then saves through the shell and offers Show in Finder", async () => {
    const t = baseTransport();
    t.handlers["diagnostics.preview"] = () => ({ files });
    const shell = new FakeShell();
    await renderApp({ t, shell, route: { name: "settings" } });
    const section = await screen.findByRole("region", { name: "Diagnostics" });
    fireEvent.click(within(section).getByRole("button", { name: "Create diagnostic bundle…" }));
    const list = await within(section).findByRole("group", { name: "Bundle contents" });
    for (const f of files) expect(within(list).getByText(f.name)).toBeTruthy();
    expect(shell.calls.filter((c) => c.startsWith("saveDiagnostics"))).toEqual([]);

    fireEvent.click(within(list).getByRole("button", { name: "Save to Downloads" }));
    const saved = await within(section).findByRole("status");
    expect(saved.textContent).toContain("Saved homerun-diagnostics-20260101-090000.zip");
    expect(shell.calls).toContain("saveDiagnostics:false");
    fireEvent.click(within(saved).getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => expect(shell.calls).toContain("revealDiagnostics"));
  });

  test("Choose location… asks the save panel; Cancel there keeps the list", async () => {
    const t = baseTransport();
    t.handlers["diagnostics.preview"] = () => ({ files });
    const shell = new FakeShell();
    shell.bundle = null;
    await renderApp({ t, shell, route: { name: "settings" } });
    const section = await screen.findByRole("region", { name: "Diagnostics" });
    fireEvent.click(within(section).getByRole("button", { name: "Create diagnostic bundle…" }));
    const list = await within(section).findByRole("group", { name: "Bundle contents" });
    fireEvent.click(within(list).getByRole("button", { name: "Choose location…" }));
    await waitFor(() => expect(shell.calls).toContain("saveDiagnostics:true"));
    expect(within(section).getByRole("group", { name: "Bundle contents" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Cancel" }));
    await within(section).findByRole("button", { name: "Create diagnostic bundle…" });
  });

  test("a failure says why", async () => {
    const t = baseTransport();
    t.handlers["diagnostics.preview"] = () => {
      throw new RpcCallError(-32000, "The disk is full.");
    };
    await renderApp({ t, route: { name: "settings" } });
    const section = await screen.findByRole("region", { name: "Diagnostics" });
    fireEvent.click(within(section).getByRole("button", { name: "Create diagnostic bundle…" }));
    await within(section).findByText(/disk is full/);
  });

  test("the web client has no Diagnostics section", async () => {
    await renderWeb({ route: { name: "settings" } });
    await screen.findByRole("region", { name: "This browser" });
    expect(screen.queryByRole("region", { name: "Diagnostics" })).toBeNull();
  });
});
