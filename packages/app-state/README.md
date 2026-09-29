# `@homerun/app-state`

The client state layer (docs/design.md §9.8). The desktop app renders it with React DOM today.
The web and iOS clients (milestone 10) will render the same stores with React DOM and React
Native. Nothing here imports React, the DOM, Tauri or Bun: `tsconfig.json` builds with
`types: []` and `lib: ES2023`, so a platform API can't sneak in.

**The seams.** A client supplies two things:

- `Transport` (`transport.ts`): `call(method, params)`, `listen(fn)` and `status()`. The desktop
  implements it over Tauri commands and a Channel; the tests use a fake. The status says whether
  the runtime is `ready` (with a connection number that changes on every reconnect), `starting`,
  `restarting`, in a `crash_loop`, `blocked` or `stopping` (§5.1).
- `Env` (`env.ts`): the clock, timers and id generation. The tests drive them by hand.

**The pieces.**

- `rpc.ts`: `Rpc.call(method, params)`, typed from the core method table. It validates every
  result with its core schema and throws `ProtocolError` when a result doesn't match.
- `store.ts`: `Store<T>`, a value with `get`, `set` and `subscribe`. Views bind to it; React uses
  `useSyncExternalStore`.
- `threads/reducer.ts`: the pure reducer over `thread_events` (§6).
  - Persisted events append contiguously by `seq`: duplicates are dropped, and a skipped seq
    flags a gap.
  - Deltas build streams by index, and `message.final` replaces them. A resumed or ended run
    drops its partial responses (§5.4).
  - It also keeps the outbox of messages not yet echoed back as `user.message`.
- `threads/timeline.ts`: the view model. `threadView(state)` returns the items, the pending
  requests and the active run.
  - A held message is `held`, then `delivered` when its run resumes, or `not_delivered` when
    the run ends first (§5.7).
  - A tool row is `running`, `waiting`, `ok`, `error`, `denied`, `no_result` or `resolved_*`.
    A question card replaces its `AskUserQuestion` row.
- `threads/sync.ts`: `ThreadSync` keeps one open thread current (§5.2).
  - It loads the latest page of history, then subscribes from its last seq.
  - It subscribes again after a gap or a reconnect.
  - Sending goes through the outbox. `messages.send` is idempotent on `client_msg_id`, so a
    message queued offline goes out once, with its original time.
- `threads/list.ts`: the thread list, patched by `threads.changed`. `groupThreads` sorts it into
  "Needs you", "Running" and "Recent".
- `inbox.ts`: every pending request, with its thread.
- `input.ts`: drafts for the input cards (§5.6).
  - Approvals: the Always-allow editor and `checkGrant`, which uses core's `grantCovers` so an
    edited pattern must still cover the call.
  - Questions: single and multiple choice plus freeform.
  - The resolution text, for example "Allowed once on iPhone".
- `tasks.ts`: tasks with their schedules, the spec editor helpers (`checkSpec` uses the core
  schema) and the schedule state text (§8.1).
- `monitors.ts`: weekly coverage and its sentence (§8.4), and the digest's health lines (§8.3).
- `grants.ts`, `format.ts`: display text.
- `markdown.ts`: model markdown as a neutral block and inline tree, never HTML. Raw HTML stays
  text. Only http(s) and mailto links keep a target, and images become links (§13).
- `client.ts`: `AppClient`, the root.
  - It routes notifications (`thread.event`, `threads.changed`, `health.digest_ready`).
  - It keeps open threads alive while a view retains them, plus a linger.
  - On every new connection it reloads the list, the inbox and the tasks, and resubscribes open
    threads.

**Dependencies.** `@homerun/core`, and `marked` for its lexer only; its HTML renderer is never
used.

```sh
pnpm --filter @homerun/app-state typecheck
pnpm --filter @homerun/app-state test
```

The tests feed every valid event in `packages/core/vectors/events.json` through the reducer and
the timeline.
