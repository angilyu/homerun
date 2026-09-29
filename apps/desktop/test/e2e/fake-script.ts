import type { FakeScript, FakeSession } from "../../../homerund/src/agent/fake-engine";

/**
 * What the fake engine does for the E2E smoke test, keyed on the message text. It drives the
 * runtime through the same gate and sink as `claude` would (§5.3–§5.6), so the UI sees real
 * events from a real runtime.
 */
export const e2eScript: FakeScript = async (s) => {
  for (let i = await s.nextInput(); i; i = await s.nextInput()) {
    const text = i.text.trim();
    if (/run the tests/i.test(text)) {
      const d = await s.tool({ toolCallId: `bash-${i.uuid}`, tool: "Bash", input: { command: "npm test -- --silent" } }, async () => ({ ok: true, output: "12 passed" }));
      if (s.interrupted) break;
      say(s, i.uuid, d.allow ? "All 12 tests passed." : "I didn't run the tests.");
      s.result([i.uuid]);
    } else if (/ask me/i.test(text)) {
      const q = "Which colour do you prefer?";
      const d = await s.tool({
        toolCallId: `ask-${i.uuid}`,
        tool: "AskUserQuestion",
        input: { questions: [{ question: q, header: "Colour", options: [{ label: "Blue", description: "" }, { label: "Green", description: "" }], multiSelect: false }] },
      });
      if (s.interrupted) break;
      const answers = d.allow ? ((d.updatedInput?.answers ?? {}) as Record<string, string>) : {};
      say(s, i.uuid, `You chose ${answers[q] ?? "nothing"}.`);
      s.result([i.uuid]);
    } else {
      // A slow stream, long enough to steer or stop while it runs.
      const words = `Hello! You said "${text}". Here is a longer reply so it streams for a while, word by word, while you watch.`.split(" ");
      const id = `msg-${i.uuid}`;
      let sent = "";
      for (const w of words) {
        if (s.interrupted) break;
        const piece = (sent ? " " : "") + w;
        sent += piece;
        s.emit({ type: "delta", messageId: id, text: piece });
        await Bun.sleep(120);
      }
      s.emit({ type: "message", messageId: id, text: sent });
      s.result([i.uuid]);
      if (s.interrupted) break;
    }
  }
};

function say(s: FakeSession, uuid: string, text: string): void {
  s.emit({ type: "message", messageId: `msg-${uuid}`, text });
}
