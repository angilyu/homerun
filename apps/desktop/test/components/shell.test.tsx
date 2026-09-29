import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEVICE, OTHER_THREAD, RUN, THREAD, approvalPrompt, baseTransport, renderApp, summary, uuid } from "./support";

describe("runtime banner (§5.1)", () => {
  test("restarting, crash loop and blocked each say what's happening; Restart now asks the shell", async () => {
    const h = await renderApp();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => h.t.setStatus({ state: "restarting", retry_at: Date.now() + 4000, last_error: "exit 1" }));
    expect((await screen.findByText(/stopped unexpectedly and is restarting/)).textContent).toMatch(/Retrying in 4 s/);
    act(() => h.t.setStatus({ state: "crash_loop", retry_at: null, last_error: "database is locked" }));
    await screen.findByText(/keeps stopping: database is locked/);
    fireEvent.click(screen.getByRole("button", { name: "Show logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(h.shell.calls).toEqual(expect.arrayContaining(["revealLogs", "restartRuntime"]));
    act(() => h.t.setStatus({ state: "blocked", reason: "other_runtime", message: "Another copy of Homerun is running." }));
    await screen.findByText("Another copy of Homerun is running.");
    act(() => h.t.ready());
    await waitFor(() => expect(screen.queryByText(/Another copy/)).toBeNull());
  });

  test("the retry countdown is counted from the status change, not the last clock tick", async () => {
    const h = await renderApp();
    // The banner's clock ticks once a second; a restart late in a tick must not add a second.
    await Bun.sleep(700);
    act(() => h.t.setStatus({ state: "restarting", retry_at: Date.now() + 1000, last_error: "killed" }));
    expect((await screen.findByText(/stopped unexpectedly and is restarting/)).textContent).toMatch(/Retrying in 1 s\./);
  });

  test("a reconnect reloads the thread list (§5.2)", async () => {
    const t = baseTransport();
    const h = await renderApp({ t });
    const before = t.called("threads.list").length;
    t.handlers["threads.list"] = () => ({ threads: [summary(THREAD, { title: "After reconnect" })], has_more: false });
    act(() => t.setStatus({ state: "restarting", retry_at: null, last_error: null }));
    act(() => t.ready());
    await screen.findByText("After reconnect");
    expect(t.called("threads.list").length).toBe(before + 1);
    expect(h.client.connected).toBe(true);
  });
});

describe("sidebar and inbox (§5.6, §9.8)", () => {
  test("threads are grouped; the inbox counts what waits and opens its thread", async () => {
    const t = baseTransport();
    t.handlers["threads.list"] = () => ({
      threads: [
        summary(THREAD, { title: "Deploy", input_pending: true, active_run: { run_id: RUN, state: "waiting_input" } }),
        summary(OTHER_THREAD, { title: "Notes", unread_count: 2 }),
      ],
      has_more: false,
    });
    const req = uuid();
    t.handlers["input.list_pending"] = () => ({
      requests: [{ request_id: req, run_id: RUN, kind: "approval", tool_call_id: "tc1", prompt: approvalPrompt("tc1"), state: "pending", requested_at: Date.now() - 60_000, expires_at: null, answered_at: null, response: null, answered_by: null }],
    });
    t.handlers["runs.get"] = () => ({ run: { run_id: RUN, thread_id: THREAD, task_id: null, task_version: null, sdk_session_id: null, device_id: "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a02", trigger: "message", origin_device: DEVICE, authority: "full", scheduled_for: null, dedupe_key: "k", attempt: 0, state: "waiting_input", started_at: Date.now(), ended_at: null, outcome: null, error: null, check_result: null, cost_usd: null, claude_pid: null } });
    const h = await renderApp({ t });
    const needs = within(await screen.findByRole("region", { name: "Needs you" }));
    expect(needs.getByText("Deploy")).toBeTruthy();
    const recent = within(screen.getByRole("region", { name: "Recent" }));
    expect(recent.getByLabelText("unread")).toBeTruthy();
    await screen.findByLabelText("1 waiting");
    h.go({ name: "inbox" });
    fireEvent.click(await screen.findByRole("button", { name: /Allow Bash\?/ }));
    await screen.findByRole("heading", { name: "Deploy" });
  });
});
