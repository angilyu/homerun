import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { RpcCallError } from "@homerun/app-state";
import { RPC_ERROR } from "@homerun/core";
import { DEVICE, GRANT, SCHEDULE, TASK, T0, THREAD, baseTransport, monitorTask, renderApp, scheduleState, sessionTask } from "./support";

function withTasks(task: object = sessionTask(), schedule: ReturnType<typeof scheduleState> | null = null) {
  const t = baseTransport();
  t.handlers["tasks.list"] = () => ({ tasks: [task] });
  t.handlers["schedules.list"] = () => ({ schedules: schedule ? [schedule] : [] });
  t.handlers["tasks.get"] = () => ({ task });
  t.handlers["runs.list"] = () => ({ runs: [] });
  t.handlers["grants.list"] = () => ({ grants: [] });
  t.handlers["monitors.state.get"] = () => ({ state: null });
  t.handlers["schedules.coverage"] = () => ({ days: [] });
  return t;
}

describe("task editor (§2.1)", () => {
  test("validates with core's schema before saving, then creates", async () => {
    const t = baseTransport();
    t.handlers["tasks.create"] = (p) => ({ task: { ...sessionTask(), name: p.spec.name, spec: p.spec }, thread_id: THREAD });
    t.handlers["tasks.get"] = () => ({ task: sessionTask() });
    t.handlers["runs.list"] = () => ({ runs: [] });
    t.handlers["grants.list"] = () => ({ grants: [] });
    await renderApp({ t, route: { name: "task_edit", kind: "session" } });
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("name");
    expect(t.called("tasks.create")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tidy repo" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep it tidy." } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(t.called("tasks.create")).toHaveLength(1));
    expect(t.called("tasks.create")[0]!.params.spec).toMatchObject({ kind: "session", name: "Tidy repo", prompt: "Keep it tidy." });
    await screen.findByRole("heading", { name: "Tidy repo" });
  });

  test("open egress with folders is refused, as the runtime would (§5.5)", async () => {
    await renderApp({ route: { name: "task_edit", kind: "session" } });
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "y" } });
    fireEvent.change(screen.getByLabelText(/Folders it may use/), { target: { value: "~/code" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow any website" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findAllByText(/open egress is only allowed/)).length).toBeGreaterThan(0);
  });

  test("an edit that lost a race says so (CONFLICT, §6)", async () => {
    const t = withTasks();
    t.handlers["tasks.update"] = () => {
      throw new RpcCallError(RPC_ERROR.CONFLICT, "version 1 is not current");
    };
    await renderApp({ t, route: { name: "task_edit", task_id: TASK } });
    fireEvent.change(await screen.findByLabelText("Instructions"), { target: { value: "New words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed somewhere else");
    expect(t.called("tasks.update")[0]!.params).toMatchObject({ task_id: TASK, expected_version: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText(/changed somewhere else/)).toBeNull());
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep the repo tidy.");
  });

  test("the JSON editor round-trips into the form", async () => {
    await renderApp({ route: { name: "task_edit", kind: "session" } });
    fireEvent.click(await screen.findByText("Advanced: edit as JSON"));
    const json = screen.getByLabelText("Task spec JSON") as HTMLTextAreaElement;
    await waitFor(() => expect(json.value).toContain('"kind": "session"'));
    const spec = JSON.parse(json.value);
    spec.name = "From JSON";
    fireEvent.change(json, { target: { value: JSON.stringify(spec) } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("From JSON");
  });
});

describe("monitors (§8)", () => {
  test("list shows the next check; the page pauses and resumes", async () => {
    const t = withTasks(monitorTask(), scheduleState());
    t.handlers["schedules.set_enabled"] = (p) => ({ schedule: scheduleState({ enabled: p.enabled, paused_reason: p.enabled ? null : "user", next_fire_at: p.enabled ? Date.now() + 60_000 : null }) });
    const h = await renderApp({ t, route: { name: "tasks" } });
    const row = await screen.findByRole("button", { name: /Price watch/ });
    expect(row.textContent).toMatch(/Every 30 minutes · next in 1[12] min/);
    h.go({ name: "task", task_id: TASK });
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(t.called("schedules.set_enabled")[0]?.params).toEqual({ schedule_id: SCHEDULE, enabled: false }));
    await screen.findByRole("button", { name: "Resume" });
    expect(screen.getByText("No check scheduled.")).toBeTruthy();
  });

  test("coverage: bars, the sentence, and the sleep hint when low (§8.4)", async () => {
    const t = withTasks(monitorTask(), scheduleState());
    t.handlers["schedules.coverage"] = (p) => {
      const day = p.to_day;
      return { days: [{ schedule_id: SCHEDULE, day, expected: 48, ran: 10, missed_asleep: 36, missed_not_running: 2, merged: 0 }] };
    };
    await renderApp({ t, route: { name: "task", task_id: TASK } });
    await screen.findByText(/Ran 10 of 48 scheduled checks this week \(21%\)\. Your Mac was asleep for most of the rest\./);
    expect(screen.getByText(/Prevent automatic sleeping/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Checks per day" }).children).toHaveLength(7);
  });

  test("remembered state can be reset", async () => {
    const t = withTasks(monitorTask(), scheduleState());
    t.handlers["monitors.state.get"] = () => ({ state: { task_id: TASK, state: { price: 12 }, version: 4, last_run_id: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a01", updated_at: T0 } });
    t.handlers["monitors.state.reset"] = () => ({ ok: true });
    await renderApp({ t, route: { name: "task", task_id: TASK } });
    await screen.findByText(/"price": 12/);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(within(screen.getByRole("group", { name: /Forget it/ })).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(t.called("monitors.state.reset")[0]?.params).toEqual({ task_id: TASK, expected_version: 4 }));
  });
});

describe("grants (§5.6)", () => {
  test("listed on the task page and revoked after a confirmation", async () => {
    const t = withTasks();
    let revoked = false;
    t.handlers["grants.list"] = () => ({
      grants: revoked ? [] : [{ grant_id: GRANT, task_id: TASK, tool: "Bash", pattern: "npm test *", class: "read", granted_by: DEVICE, granted_at: T0, revoked_at: null }],
    });
    t.handlers["grants.revoke"] = () => ((revoked = true), { revoked_at: T0 + 1 });
    await renderApp({ t, route: { name: "task", task_id: TASK } });
    await screen.findByText("Bash · npm test *");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Ask again next time?" })).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(t.called("grants.revoke")[0]?.params).toEqual({ grant_id: GRANT }));
    await waitFor(() => expect(screen.queryByText("Bash · npm test *")).toBeNull());
  });
});
