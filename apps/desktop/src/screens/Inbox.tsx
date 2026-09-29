import { toolName } from "@homerun/app-state";
import type { InputPrompt } from "@homerun/core";
import { useApp, useStore } from "../hooks";
import { Empty, ErrorText, Page, Time } from "../ui/bits";

/** Everything waiting for you, across threads (§5.6). Answers happen in the thread. */
export function Inbox() {
  const app = useApp();
  const inbox = useStore(app.client.inbox.store);
  const list = useStore(app.client.threads.store);
  const titleOf = (id: string | null) => {
    const t = id ? list.threads.find((x) => x.thread_id === id) : undefined;
    return t?.title ?? t?.last_message?.preview.slice(0, 60) ?? "a chat";
  };
  return (
    <Page title="Inbox" sub="Approvals and questions waiting for you.">
      <ErrorText error={inbox.error} />
      {inbox.loaded && inbox.entries.length === 0 && <Empty>Nothing needs you right now.</Empty>}
      <ul className="cards">
        {inbox.entries.map(({ request, thread_id }) => (
          <li key={request.request_id}>
            <button type="button" className="card row-card" disabled={!thread_id} onClick={() => thread_id && app.go({ name: "thread", thread_id })}>
              <strong>{promptTitle(request.prompt)}</strong>
              <span className="muted">
                In {titleOf(thread_id)} · <Time ts={request.requested_at} relative />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}

export function promptTitle(p: InputPrompt): string {
  switch (p.type) {
    case "approval":
      return `Allow ${toolName(p.tool)}?`;
    case "question":
      return p.questions[0]!.question + (p.questions.length > 1 ? ` (+${p.questions.length - 1} more)` : "");
    case "ambiguous_tool_call":
      return `Did ${toolName(p.tool)} happen?`;
  }
}
