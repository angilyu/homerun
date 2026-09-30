import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FakeShell, T0, baseTransport, renderApp } from "./support";

const TOKEN = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e01";
const OTHER = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e02";

function cliTransport() {
  const t = baseTransport();
  t.handlers["health.settings.get"] = () => ({ settings: { enabled: true, time: "09:00", timezone: "UTC" } });
  let tokens = [
    { token_id: TOKEN, client: { name: "homerun-cli", version: "0.2.0" }, hostname: "studio", created_at: T0, last_used_at: T0 + 60_000 },
    { token_id: OTHER, client: { name: "homerun-cli", version: "0.1.9" }, hostname: "laptop", created_at: T0, last_used_at: null },
  ];
  t.handlers["cli.tokens.list"] = () => ({ tokens });
  t.handlers["cli.tokens.revoke"] = (p: { token_id: string }) => {
    tokens = tokens.filter((x) => x.token_id !== p.token_id);
    return { ok: true };
  };
  return t;
}

const section = () => screen.findByRole("region", { name: "Command-line access" });

describe("Settings → Command-line access (§5.2)", () => {
  test("tokens show their host and when they were used; Revoke asks, then signs one out", async () => {
    const t = cliTransport();
    await renderApp({ t, route: { name: "settings" } });
    const s = await section();
    const studio = (await within(s).findByText(/on studio/)).closest("li")!;
    const laptop = within(s).getByText(/on laptop/).closest("li")!;
    expect(studio.textContent).toContain("used");
    expect(studio.textContent).not.toContain("never used");
    expect(laptop.textContent).toContain("never used");

    fireEvent.click(within(laptop as HTMLElement).getByRole("button", { name: "Revoke" }));
    const ask = within(laptop as HTMLElement).getByRole("group", { name: /Sign it out\? Anything it has open closes now\./ });
    fireEvent.click(within(ask).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(s).queryByText(/on laptop/)).toBeNull());
    expect(t.called("cli.tokens.revoke").map((c) => c.params)).toEqual([{ token_id: OTHER }]);
    expect(within(s).getByText(/on studio/)).toBeTruthy();
  });

  test("no tokens says so", async () => {
    const t = cliTransport();
    t.handlers["cli.tokens.list"] = () => ({ tokens: [] });
    await renderApp({ t, route: { name: "settings" } });
    await within(await section()).findByText("No command-line clients are signed in.");
  });

  test("a development build explains why there is no tool, and offers no button", async () => {
    await renderApp({ t: cliTransport(), route: { name: "settings" } });
    const s = await section();
    await within(s).findByText("The command-line tool comes with the Homerun app; this is a development build.");
    expect(within(s).queryByRole("button", { name: /Install/ })).toBeNull();
  });

  test("install, the PATH hint, then remove", async () => {
    const shell = new FakeShell();
    shell.tool = { state: "not_installed", link: "/Users/me/.local/bin/homerun" };
    await renderApp({ shell, t: cliTransport(), route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Install command-line tool" }));
    await within(s).findByText("/Users/me/.local/bin/homerun");
    within(s).getByText('export PATH="$HOME/.local/bin:$PATH"');
    fireEvent.click(within(s).getByRole("button", { name: "Remove" }));
    await within(s).findByRole("button", { name: "Install command-line tool" });
    expect(shell.calls).toEqual(expect.arrayContaining(["installCliTool", "removeCliTool"]));
  });

  test("a link to another copy or a deleted one can be pointed here", async () => {
    const shell = new FakeShell();
    shell.tool = { state: "other_copy", link: "/Users/me/.local/bin/homerun", target: "/Users/me/Downloads/Homerun.app/Contents/MacOS/homerun-cli" };
    await renderApp({ shell, t: cliTransport(), route: { name: "settings" } });
    const s = await section();
    await within(s).findByText(/points to another copy of Homerun/);
    fireEvent.click(within(s).getByRole("button", { name: "Use this copy" }));
    await within(s).findByRole("button", { name: "Remove" });

    shell.tool = { state: "dangling", link: "/Users/me/.local/bin/homerun", target: "/Applications/Old.app/Contents/MacOS/homerun-cli" };
    fireEvent.focus(window);
    await within(s).findByText(/has moved or been deleted/);
    within(s).getByRole("button", { name: "Repair" });
  });

  test("something else at the path is left alone: no button", async () => {
    const shell = new FakeShell();
    shell.tool = { state: "foreign", link: "/Users/me/.local/bin/homerun" };
    await renderApp({ shell, t: cliTransport(), route: { name: "settings" } });
    const s = await section();
    await within(s).findByText(/Something else is already at/);
    expect(within(s).queryByRole("button", { name: /Install|Repair|Use this copy|Remove/ })).toBeNull();
    expect(shell.calls).not.toContain("installCliTool");
  });

  test("an install that fails shows the shell's reason", async () => {
    const shell = new FakeShell();
    shell.tool = { state: "not_installed", link: "/Users/me/.local/bin/homerun" };
    shell.installCliTool = async () => {
      throw new Error("~/.local/bin isn't a folder.");
    };
    await renderApp({ shell, t: cliTransport(), route: { name: "settings" } });
    const s = await section();
    fireEvent.click(await within(s).findByRole("button", { name: "Install command-line tool" }));
    expect((await within(s).findByRole("alert")).textContent).toContain("~/.local/bin isn't a folder.");
  });
});
