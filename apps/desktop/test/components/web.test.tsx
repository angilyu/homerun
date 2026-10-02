import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { RUN, TASK, THREAD, approvalPrompt, baseTransport, monitorTask, questionPrompt, renderWeb, requested, scheduleState, started, summary, toolCall, userMsg, uuid } from "./support";

/** The desktop's views, rendered as the web client renders them (§9.9): no shell, the web role. */

function threadWith(events: unknown[]) {
  const t = baseTransport();
  t.handlers["threads.list"] = () => ({ threads: [summary(THREAD)], has_more: false });
  t.handlers["threads.history"] = () => ({ events, has_more: false });
  t.handlers["input.answer"] = () => ({ status: "applied" });
  t.handlers["health.settings.get"] = () => ({ settings: { enabled: true, time: "08:00", timezone: "Europe/London" } });
  return t;
}

describe("the web client (§9.9)", () => {
  test("goes straight to the app: no key onboarding, no shell", async () => {
    await renderWeb();
    expect(screen.queryByText(/API key/)).toBeNull();
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  test("an approval that needs more than reading says to approve on a phone or Mac", async () => {
    const r = uuid();
    const t = threadWith([userMsg(1, "Test it"), started(2), toolCall(3, "tc1", "Bash", { command: "rm -rf build" }, "needs_approval"), requested(4, r, approvalPrompt("tc1"))]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    const card = await screen.findByRole("region", { name: "Approve Bash" });
    expect(within(card).getByRole("note").textContent).toBe("Approve on your phone or Mac");
    expect(within(card).queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Always allow/ })).toBeNull();
  });

  test("a read-class approval can be allowed once, never always", async () => {
    const r = uuid();
    const t = threadWith([userMsg(1, "Look"), started(2), toolCall(3, "tc1", "Read", { file_path: "/tmp/x" }, "needs_approval"), requested(4, r, approvalPrompt("tc1", { tool: "Read", class: "read", input: { kind: "inline", value: { file_path: "/tmp/x" } }, suggested_grant: { tool: "Read", pattern: null, class: "read" } }))]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    const card = await screen.findByRole("region", { name: "Approve Read" });
    expect(within(card).queryByRole("button", { name: /Always allow/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(t.called("input.answer")).toHaveLength(1));
    expect(t.called("input.answer")[0]!.params).toMatchObject({ request_id: r, response: { type: "approval", decision: "allow" } });
  });

  test("never offers 'Allow all web fetches for this task' (§5.6, §9.9)", async () => {
    const r = uuid();
    const prompt = approvalPrompt("tc1", {
      tool: "WebFetch",
      class: "network",
      input: { kind: "inline", value: { url: "https://evil.test/x" } },
      url: "https://evil.test/x",
      reason: "tainted_egress",
      suggested_grant: { tool: "WebFetch", pattern: "evil.test", class: "network" },
      suggested_grant_all: { tool: "WebFetch", pattern: "*", class: "network" },
    });
    const t = threadWith([userMsg(1, "Look"), started(2), toolCall(3, "tc1", "WebFetch", { url: "https://evil.test/x" }, "needs_approval"), requested(4, r, prompt)]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    const card = await screen.findByRole("region", { name: "Approve WebFetch" });
    expect(within(card).getByRole("note").textContent).toBe("Approve on your phone or Mac");
    expect(within(card).queryByRole("button", { name: /Allow all web fetches|Always allow/ })).toBeNull();
    expect(within(card).queryByText(/any website/)).toBeNull();
  });

  test("questions are answered from the web", async () => {
    const q = uuid();
    const t = threadWith([userMsg(1, "Go"), started(2), requested(3, q, questionPrompt())]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    const card = await screen.findByRole("region", { name: "Question from Claude" });
    fireEvent.click(within(card).getByLabelText("main"));
    fireEvent.click(within(card).getByLabelText("lint"));
    fireEvent.click(within(card).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(t.called("input.answer")).toHaveLength(1));
  });

  test("while the desktop is offline, cards wait for it", async () => {
    const q = uuid();
    const t = threadWith([userMsg(1, "Go"), started(2), requested(3, q, questionPrompt())]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    const card = await screen.findByRole("region", { name: "Question from Claude" });
    t.setStatus({ state: "offline", reason: "desktop", last_seen_at: null });
    await waitFor(() => expect(within(card).getByRole("note").textContent).toBe("Can be answered when your Mac is back"));
    expect(within(card).queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(screen.getAllByRole("status").some((e) => e.textContent?.includes("Your Mac is offline"))).toBe(true);
  });

  test("tasks are read-only: no new, edit, archive, pause or state edits; Check now stays", async () => {
    const t = baseTransport();
    const task = monitorTask();
    t.handlers["tasks.list"] = () => ({ tasks: [task] });
    t.handlers["tasks.get"] = () => ({ task });
    t.handlers["schedules.list"] = () => ({ schedules: [scheduleState()] });
    t.handlers["runs.list"] = () => ({ runs: [] });
    t.handlers["grants.list"] = () => ({ grants: [] });
    t.handlers["monitors.state.get"] = () => ({ state: { task_id: TASK, state: { price: 3 }, version: 1, updated_at: Date.now() } });
    t.handlers["schedules.coverage"] = () => ({ days: [] });
    const h = await renderWeb({ t, route: { name: "tasks" } });
    await screen.findByText("Price watch");
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New monitor" })).toBeNull();
    h.go({ name: "task", task_id: TASK });
    await screen.findByRole("button", { name: "Check now" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    h.go({ name: "task_edit", task_id: TASK });
    await screen.findByText("Create and edit tasks on your Mac.");
  });

  test("settings: the web client's own section and a read-only digest", async () => {
    const t = threadWith([]);
    await renderWeb({ t, route: { name: "settings" } });
    await screen.findByRole("region", { name: "This browser" });
    const digest = await screen.findByRole("region", { name: "Daily summary" });
    expect((within(digest).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(within(digest).getByText("Change this on your Mac.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /API key/ })).toBeNull();
  });

  test("blocked: Try again instead of restarting a runtime it doesn't run", async () => {
    const h = await renderWeb();
    h.t.setStatus({ state: "blocked", reason: "unlinked", message: "This browser isn't linked to that Mac any more." });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(h.retried).toBe(1);
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show logs" })).toBeNull();
  });

  test("a thread made by the web isn't saved as a task from here", async () => {
    const t = threadWith([userMsg(1, "Hi"), started(2, RUN)]);
    await renderWeb({ t, route: { name: "thread", thread_id: THREAD } });
    await screen.findByText("Hi");
    expect(screen.queryByRole("button", { name: /Save as task/ })).toBeNull();
  });
});
