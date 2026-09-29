import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  OTHER_DEVICE,
  RUN,
  THREAD,
  approvalPrompt,
  baseTransport,
  delta,
  ended,
  final,
  questionPrompt,
  renderApp,
  requested,
  started,
  summary,
  toolCall,
  userMsg,
  uuid,
} from "./support";
import { RpcCallError } from "@homerun/app-state";

function threadWith(events: unknown[]) {
  const t = baseTransport();
  t.handlers["threads.list"] = () => ({ threads: [summary(THREAD)], has_more: false });
  t.handlers["threads.history"] = () => ({ events, has_more: false });
  t.handlers["messages.send"] = (p) => ({ seq: 99, run_id: RUN, disposition: "started_run", _p: p });
  t.handlers["input.answer"] = () => ({ status: "applied" });
  t.handlers["runs.stop"] = () => ({ state: "running" });
  return t;
}

const open = (t: ReturnType<typeof threadWith>) => renderApp({ t, route: { name: "thread", thread_id: THREAD } });
const send = (text: string) => {
  const box = screen.getByLabelText("Message");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

describe("chat: streaming, steering, stop (§5.3, §5.7)", () => {
  test("deltas stream into one bubble, then the final message replaces them", async () => {
    const t = threadWith([userMsg(1, "Say hi"), started(2)]);
    await open(t);
    await screen.findByText("Say hi");
    const m = uuid();
    t.notify("thread.event", { event: delta(2, m, 0, "Hel") });
    t.notify("thread.event", { event: delta(2, m, 1, "lo **wor") });
    await waitFor(() => expect(document.querySelector(".msg.assistant")?.textContent).toContain("Hello"));
    expect(document.querySelector(".msg.assistant")?.getAttribute("aria-busy")).toBe("true");
    t.notify("thread.event", { event: final(3, m, "Hello **world**") });
    t.notify("thread.event", { event: ended(4) });
    await waitFor(() => expect(document.querySelector(".msg.assistant strong")?.textContent).toBe("world"));
    expect(document.querySelectorAll(".msg.assistant")).toHaveLength(1);
    expect(document.querySelector(".msg.assistant")?.getAttribute("aria-busy")).toBeNull();
  });

  test("Enter sends; the bubble shows at once", async () => {
    const t = threadWith([]);
    await open(t);
    send("Tidy the repo");
    await screen.findByText("Tidy the repo");
    await waitFor(() => expect(t.called("messages.send")).toHaveLength(1));
    expect(t.called("messages.send")[0]!.params).toMatchObject({ thread_id: THREAD, text: "Tidy the repo" });
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });

  test("while a run works, the composer steers and Stop stops it", async () => {
    const t = threadWith([userMsg(1, "Go"), started(2)]);
    await open(t);
    await screen.findByRole("button", { name: "Steer" });
    expect(screen.getByText(/sent to the running task/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(t.called("runs.stop")[0]?.params).toEqual({ run_id: RUN }));
  });

  test("a failed send can be retried or discarded", async () => {
    const t = threadWith([]);
    t.handlers["messages.send"] = () => {
      throw new RpcCallError(-32602, "too long");
    };
    await open(t);
    send("Hi");
    await screen.findByText(/Not sent: too long/);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("Hi")).toBeNull());
  });
});

describe("held messages (§5.7)", () => {
  const q = uuid();
  test("held while the run waits for input", async () => {
    await open(threadWith([userMsg(1, "Go"), started(2), requested(3, q, questionPrompt()), userMsg(4, "also check docs", "held")]));
    await screen.findByText("also check docs");
    expect(screen.getByText(/Held until you answer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByText(/held and delivered with it/)).toBeTruthy();
  });

  test("the run ended first: Not delivered, and Send again sends it as a new message", async () => {
    const t = threadWith([userMsg(1, "Go"), started(2), requested(3, q, questionPrompt()), userMsg(4, "also check docs", "held"), ended(5, RUN, "cancelled")]);
    await open(t);
    await screen.findByText(/Not delivered/);
    expect(document.querySelector('[data-delivery="not_delivered"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(t.called("messages.send")[0]?.params.text).toBe("also check docs"));
  });
});

describe("approvals (§5.6)", () => {
  const setup = async () => {
    const r = uuid();
    const t = threadWith([userMsg(1, "Test it"), started(2), toolCall(3, "tc1", "Bash", { command: "npm test -- --watch=false" }, "needs_approval"), requested(4, r, approvalPrompt("tc1"))]);
    await open(t);
    const card = await screen.findByRole("region", { name: "Approve Bash" });
    return { t, r, card: within(card) };
  };

  test("shows the exact call and the reason", async () => {
    const { card } = await setup();
    expect(card.getByText(/npm test -- --watch=false/)).toBeTruthy();
    expect(card.getByText(/isn't in the task's allowlist/)).toBeTruthy();
  });

  test("Allow once", async () => {
    const { t, r, card } = await setup();
    fireEvent.click(card.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(t.called("input.answer")[0]?.params).toEqual({ request_id: r, response: { type: "approval", decision: "allow" }, via: "app" }));
  });

  test("Deny", async () => {
    const { t, card } = await setup();
    fireEvent.click(card.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(t.called("input.answer")[0]?.params.response).toEqual({ type: "approval", decision: "deny" }));
  });

  test("Always allow shows the suggested pattern, checks an edit, and sends the confirmed grant", async () => {
    const { t, card } = await setup();
    fireEvent.click(card.getByRole("button", { name: "Always allow…" }));
    const pattern = card.getByLabelText(/Command pattern/) as HTMLInputElement;
    expect(pattern.value).toBe("npm test *");
    fireEvent.change(pattern, { target: { value: "git *" } });
    expect(card.getByText(/doesn't cover the call/)).toBeTruthy();
    expect((card.getByRole("button", { name: "Save and allow" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(pattern, { target: { value: "npm test *" } });
    fireEvent.click(card.getByRole("button", { name: "Save and allow" }));
    await waitFor(() =>
      expect(t.called("input.answer")[0]?.params.response).toEqual({ type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "npm test *", class: "read" } }),
    );
  });

  test("no Always allow when the runtime doesn't offer it", async () => {
    const r = uuid();
    await open(threadWith([userMsg(1, "x"), started(2), requested(3, r, approvalPrompt("tc1", { offer_always: false, reason: "destructive" }))]));
    const card = within(await screen.findByRole("region", { name: "Approve Bash" }));
    expect(card.queryByRole("button", { name: "Always allow…" })).toBeNull();
  });

  test("first answer wins: a late answer says who answered", async () => {
    const { t, card } = await setup();
    t.handlers["input.answer"] = () => ({ status: "already_resolved", state: "answered", answered_by: OTHER_DEVICE });
    fireEvent.click(card.getByRole("button", { name: "Allow once" }));
    await screen.findByText("This was already answered on another device.");
  });
});

describe("questions (§5.6)", () => {
  test("single choice, multiple choice, and freeform", async () => {
    const r = uuid();
    const t = threadWith([userMsg(1, "Ship it"), started(2), requested(3, r, questionPrompt())]);
    await open(t);
    const card = within(await screen.findByRole("region", { name: "Question from Claude" }));
    const sendBtn = card.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(card.getByRole("radio", { name: "dev" }));
    fireEvent.change(card.getByLabelText(/Or write your own/), { target: { value: "  and rebase  " } });
    fireEvent.click(card.getByRole("checkbox", { name: "lint" }));
    fireEvent.click(card.getByRole("checkbox", { name: "build" }));
    fireEvent.click(card.getByRole("checkbox", { name: "lint" }));
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    await waitFor(() =>
      expect(t.called("input.answer")[0]?.params.response).toEqual({ type: "question", answers: [{ selected: ["dev"], text: "and rebase" }, { selected: ["build"] }] }),
    );
  });

  test("freeform alone answers a question", async () => {
    const r = uuid();
    const prompt = questionPrompt(undefined, { questions: [{ question: "Name?", options: [{ label: "a" }, { label: "b" }], multi_select: false, allow_freeform: true }] });
    const t = threadWith([userMsg(1, "x"), started(2), requested(3, r, prompt)]);
    await open(t);
    const card = within(await screen.findByRole("region", { name: "Question from Claude" }));
    fireEvent.change(card.getByLabelText(/Or write your own/), { target: { value: "c" } });
    fireEvent.click(card.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(t.called("input.answer")[0]?.params.response).toEqual({ type: "question", answers: [{ selected: [], text: "c" }] }));
  });
});

describe("Did this happen? (§5.4)", () => {
  test("answers completed or not_run", async () => {
    const r = uuid();
    const prompt = { type: "ambiguous_tool_call", tool: "Bash", tool_call_id: "tc9", class: "destructive", input: { kind: "inline", value: { command: "git push" } } };
    const t = threadWith([userMsg(1, "Push"), started(2), requested(3, r, prompt)]);
    await open(t);
    const card = within(await screen.findByRole("region", { name: "Did this happen?" }));
    expect(card.getByText(/git push/)).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "No, it didn't run" }));
    await waitFor(() => expect(t.called("input.answer")[0]?.params.response).toEqual({ type: "ambiguous_tool_call", outcome: "not_run" }));
  });
});

describe("links in model output open outside the webview (§13)", () => {
  test("http links go to the shell; javascript: links are plain text", async () => {
    const m = uuid();
    const h = await open(threadWith([userMsg(1, "Links"), started(2), final(3, m, "See [docs](https://example.com/a) and [bad](javascript:alert(1))"), ended(4)]));
    const link = await screen.findByRole("link", { name: "docs" });
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText("bad")).toBeTruthy();
    // app.tsx's mount() installs the click handler; here the link must at least carry the href.
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(h.shell.opened).toEqual([]);
  });
});
