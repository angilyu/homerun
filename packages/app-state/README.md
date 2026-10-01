# `@homerun/app-state`

The client state layer (docs/design.md §9.8). The desktop app and the web client render it with
React DOM; the [iOS app](../../apps/ios/README.md) renders the same stores with React Native. Nothing here imports React, the DOM, Tauri or Bun: `tsconfig.json` builds with
`types: []` and `lib: ES2023`, so a platform API can't sneak in.

**The seams.** A client supplies two things:

- `Transport` (`transport.ts`): `call(method, params)`, `listen(fn)` and `status()`. The desktop
  implements it over Tauri commands and a Channel; the web and iOS clients use `RelayTransport`
  from `@homerun/remote`; the tests use a fake. The status says whether the runtime is `ready`
  (with a connection number that changes on every reconnect), `starting`, `restarting`, in a
  `crash_loop`, `blocked` or `stopping` (§5.1), or, for a remote client, `offline` because the
  desktop or the relay is out of reach (§9.4). A remote transport also has `queueInstruction`,
  which seals a message at the relay for an offline desktop.
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
  - A remote client whose desktop is offline seals the message at the relay instead: the bubble
    is `relayed` until the desktop applies it, with its expiry (§9.4). It is not sent again on
    reconnect; the desktop's copy is idempotent on the same `client_msg_id`.
  - With a `ThreadCache` (`threads/cache.ts`), it opens on the cached events and outbox, then
    subscribes from the last cached seq, so the iPhone shows history offline (§9.8). It keeps the
    newest 200 contiguous events per thread and the first page of the list, written a second
    after state settles; a failed read or write costs only the head start. The iOS app's cache is
    SQLCipher (§18 row 122); the desktop and the web keep nothing.
  - With a `signApproval` seam, an allow on a destructive call carries a Face ID proof
    (§18 row 115). A cancelled Face ID sends nothing (`ApprovalNotConfirmedError`); a client
    without the seam, or whose desktop hasn't pinned its key, says "Approve on your Mac".
- `threads/list.ts`: the thread list, patched by `threads.changed`. `groupThreads` sorts it into
  "Needs you", "Running" and "Recent".
- `inbox.ts`: every pending request, with its thread.
- `input.ts`: drafts for the input cards (§5.6).
  - Approvals: the Always-allow editor and `checkGrant`, which uses core's `grantCovers` so an
    edited pattern must still cover the call.
  - Questions: single and multiple choice plus freeform.
  - The resolution text, for example "Allowed once on iPhone". This client's own answers say
    "on this Mac", "on this iPhone" or "on this browser" by its role (`THIS_DEVICE`); the
    transport's `device_id` is this client's own device, which `answered_by` names.
  - `cantAnswer(prompt, role)`: the web client's reduced authority (§9.9). It answers questions
    and `read`-class approvals only, never with Always allow; the rest say "Approve on your phone
    or Mac". The runtime enforces the same rule with core's `checkResponse`, which the drafts
    call with the client's role (`AppClient.role`).
- `tasks.ts`: tasks with their schedules, the spec editor helpers (`checkSpec` uses the core
  schema) and the schedule state text (§8.1).
- `monitors.ts`: weekly coverage and its sentence (§8.4), and the digest's health lines (§8.3).
- `offline.ts`: what a remote client says while its desktop is away: `offlineText` ("Your Mac is
  offline — questions and approvals can be answered when it's back") and `relayedText` ("Will send
  when your Mac is back — expires in 12 h").
- `grants.ts`, `format.ts`: display text.
- `markdown.ts`: model markdown as a neutral block and inline tree, never HTML. Raw HTML stays
  text. Only http(s) and mailto links keep a target, and images become links (§13).
- `remote.ts`: the desktop's remote access (§10): the account and relay status, the paired
  devices and an open QR pairing offer, kept current by `account.changed`, `devices.changed` and
  `devices.pairing_completed`, with their display text. `relayText` says *Connected* or *Offline
  since …*; `sentFromText` says *Sent 3 h ago from Ada's iPhone* for a message that waited at
  the relay (`QUEUED_MIN_MS` or more, in `threads/timeline.ts`). These methods are the desktop's
  local UI's only, so `AppClient` loads them only with `{ remote: true }`.
- `client.ts`: `AppClient`, the root.
  - It routes notifications (`thread.event`, `threads.changed`, `health.digest_ready`).
  - It keeps open threads alive while a view retains them, plus a linger.
  - On every new connection it reloads the list, the inbox and the tasks, and resubscribes open
    threads.
  - `may(method)` says whether its role may call a method, from core's allowlists. The views
    hide what the runtime would refuse; the web client doesn't edit tasks, schedules or grants.

**Dependencies.** `@homerun/core`, and `marked` for its lexer only; its HTML renderer is never
used.

```sh
pnpm --filter @homerun/app-state typecheck
pnpm --filter @homerun/app-state test
```

The tests feed every valid event in `packages/core/vectors/events.json` through the reducer and
the timeline.
