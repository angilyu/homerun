import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { FakeShell, THREAD, baseTransport, renderApp } from "./support";

function settingsTransport() {
  const t = baseTransport();
  t.handlers["health.settings.get"] = () => ({ settings: { enabled: true, time: "09:00", timezone: "UTC" } });
  t.handlers["cli.tokens.list"] = () => ({ tokens: [] });
  return t;
}

describe("keep Homerun running, once after the key (§5.1)", () => {
  test("open at login is pre-checked; Continue turns it on and never asks again", async () => {
    const shell = new FakeShell();
    shell.shellPrefs.keep_running_asked = false;
    await renderApp({ shell });
    await screen.findByRole("heading", { name: "Keep Homerun running" });
    const box = screen.getByRole("checkbox", { name: "Open Homerun when you log in" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
    await screen.findByText("Notifications are on.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("navigation");
    expect(shell.calls).toEqual(["keyStatus", "requestNotifications", "setLoginItem:true", "keepRunningDone"]);
    expect(shell.shellPrefs.keep_running_asked).toBe(true);
  });

  test("unchecked leaves the login item alone", async () => {
    const shell = new FakeShell();
    shell.shellPrefs.keep_running_asked = false;
    await renderApp({ shell });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Open Homerun when you log in" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("navigation");
    expect(shell.calls).not.toContain("setLoginItem:true");
    expect(shell.calls).not.toContain("setLoginItem:false");
  });

  test("outside the bundle neither the box nor the notification button is offered", async () => {
    const dev = new FakeShell();
    dev.shellPrefs.keep_running_asked = false;
    dev.login = "unavailable";
    dev.permission = "unavailable";
    await renderApp({ shell: dev });
    await screen.findByRole("heading", { name: "Keep Homerun running" });
    await Bun.sleep(20);
    expect(screen.queryByRole("checkbox", { name: "Open Homerun when you log in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("navigation");
  });
});

describe("shell events (§8.2, §11)", () => {
  test("a notification click opens its screen", async () => {
    const h = await renderApp();
    act(() => h.shell.emit({ type: "navigate", target: { screen: "health" } }));
    await screen.findByRole("heading", { name: "Health" });
    act(() => h.shell.emit({ type: "navigate", target: { screen: "thread", thread_id: THREAD } }));
    await waitFor(() => expect(h.t.called("threads.subscribe").length).toBeGreaterThan(0));
  });

  test("a downloaded update offers Restart now, which goes through the shell's quit confirmation", async () => {
    const h = await renderApp();
    act(() => h.shell.emit({ type: "update", state: { state: "ready", version: "0.9.0", note: null } }));
    await screen.findByText(/Homerun 0\.9\.0 is ready\. It installs when you quit Homerun\./);
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(h.shell.calls).toContain("restartToUpdate");
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByText(/is ready/)).toBeNull());
  });
});

describe("Settings → Running in the background and Updates", () => {
  test("a login item turned off in System Settings says so and links there", async () => {
    const shell = new FakeShell();
    shell.login = "needs_approval";
    shell.permission = "denied";
    await renderApp({ shell, t: settingsTransport(), route: { name: "settings" } });
    await screen.findByText(/Turned off in System Settings/);
    fireEvent.click(screen.getByRole("button", { name: "Open Login Items" }));
    await screen.findByText(/Off in System Settings\./);
    fireEvent.click(screen.getByRole("button", { name: "Notification settings" }));
    expect(shell.calls).toEqual(expect.arrayContaining(["openLoginItems", "openNotificationSettings"]));
  });

  test("the toggle follows the system; updates can be checked, turned off, or unavailable", async () => {
    const shell = new FakeShell();
    shell.update = { state: "up_to_date", checked_at: Date.now() };
    await renderApp({ shell, t: settingsTransport(), route: { name: "settings" } });
    const box = (await screen.findByRole("checkbox", { name: "Open Homerun when you log in" })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    await screen.findByText("Homerun is up to date.");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Check for and download updates automatically" }));
    expect(shell.calls).toEqual(expect.arrayContaining(["setLoginItem:true", "checkForUpdates", "setAutoUpdate:false"]));
    act(() => shell.emit({ type: "update", state: { state: "unavailable", message: "This build has no update key, so it can't update itself." } }));
    await screen.findByText("This build has no update key, so it can't update itself.");
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});
