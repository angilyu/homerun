import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FakeShell, renderApp } from "./support";

const noKey = () => {
  const s = new FakeShell();
  s.key = { present: false, hint: null, store: "memory" };
  return s;
};

describe("onboarding: connect an API key (§7.2)", () => {
  test("a valid key is saved through the shell and the app opens", async () => {
    const shell = noKey();
    await renderApp({ shell });
    await screen.findByRole("heading", { name: "Connect your Anthropic API key" });
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-mock-not-a-real-key" } });
    fireEvent.click(connect);
    await screen.findByRole("navigation");
    expect(shell.calls).toContain("setKey:sk-ant-mock-not-a-real-key");
  });

  test("a rejected key stays on the form with the reason", async () => {
    const shell = noKey();
    shell.setKeyResult = { outcome: "rejected", detail: "invalid x-api-key" };
    await renderApp({ shell });
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "sk-ant-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("didn't accept");
    expect(alert.textContent).toContain("invalid x-api-key");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("offline: saved but unverified, then continue", async () => {
    const shell = noKey();
    shell.setKeyResult = { outcome: "saved_unverified", detail: "Anthropic couldn't be reached." };
    await renderApp({ shell });
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "sk-ant-offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("status")).textContent).toContain("not checked");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("navigation");
  });

  test("skip shows the app with a banner that leads back to settings", async () => {
    await renderApp({ shell: noKey() });
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    const banner = await screen.findByText(/No API key connected/);
    expect(banner).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect a key" }));
    await screen.findByRole("heading", { name: "Settings" });
  });

  test("the key field is a password field and never prefilled", async () => {
    await renderApp({ shell: noKey() });
    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
