# `@homerun/core`

Homerun's shared contracts, written as Zod schemas: the task spec, domain rows, `thread_events`,
the local IPC protocol with per-caller allowlists, and the relay payload envelopes. This is
milestone 1 in [`docs/design.md` §16](../../docs/design.md#16-build-plan).

The package holds no runtime behaviour: only schemas, constants, small validators (cron and
IANA timezones) and data tables (tool classes, run-state transitions, allowlists). The runtime,
the CLI, the desktop webview and the web client import it directly. The iOS client (Swift) and
the Rust shell read the generated artifacts in [`schema/`](schema) and [`vectors/`](vectors).

```ts
import { ThreadEvent, METHODS, authorize, PROTOCOL_VERSION } from "@homerun/core";

const ev = ThreadEvent.parse(JSON.parse(line));
if (!authorize("webview", "secrets.set").ok) { /* reject: FORBIDDEN */ }
```

The package exports TypeScript source (`./src/index.ts`) and has no build step. Consumers need a
bundler or Bun. Imports are extensionless, with `moduleResolution: "Bundler"`.

## Layout

```
src/
  common.ts         ids (lowercase UUIDs; opaque SDK ids), TimestampMs, JsonValue, Content/BlobRef, Origin, size helpers, assertNever
  tools.ts          ToolClass, built-in tools and their class table, Bash command patterns
  patterns.ts       Bash pattern and egress domain matching, grantCovers() (shared by runtime and clients)
  cron.ts           dependency-free 5-field cron parser (plus @daily-style macros)
  timezone.ts       IANA zone validation through Intl
  schedule.ts       CronSchedule | IntervalSchedule, catch-up policy, ScheduleState, ScheduleCoverage
  task-spec.ts      SessionSpec | MonitorSpec, policy, checks, SPEC_FORMAT, upgradeSpec()
  grants.ts         ToolGrant and its shape rules, effectiveEgressDomains()
  input.ts          input prompts and responses, requiredAuthority(), checkResponse(), alwaysAllowable()
  domain.ts         Device, Task, TaskVersion, Thread, Run (+ transitions), MonitorState, ThreadSummary
  events.ts         thread_events: persisted and live-only unions, parseThreadEventLenient(), HeldMessages
  protocol/
    jsonrpc.ts      JSON-RPC 2.0 frames, error codes, classifyFrame()
    handshake.ts    PROTOCOL_VERSION, CallerRole, hello params and result, negotiation
    methods.ts      METHODS and NOTIFICATIONS tables: schemas, direction, callers, description
    callers.ts      allowlists derived from the tables, authorize(), mayReceive(), maySend()
  relay.ts          relay envelope header, sealed inner payloads, expiry constants, pairing QR payload
  registry.ts       named(): gives schemas a stable $defs name
  json-schema.ts    buildSchemaBundle(), buildCallers(), buildManifest()
scripts/
  gen.ts            writes schema/ and vectors/; --check fails if they are stale
  vectors/          source of the golden vectors
schema/             GENERATED and committed
  homerun.schema.json   every named schema, as JSON Schema 2020-12 $defs
  callers.json          allowlists per caller role (for the Rust shell and Swift)
  manifest.json         versions, event partition, error codes, methods and notifications
vectors/            GENERATED and committed: golden test vectors, one file per area
test/               bun test
```

## Schema inventory

| Area | Main schemas (`$defs` names) | Design § |
|---|---|---|
| Common | `DeviceId` `TaskId` `ThreadId` `RunId` `RequestId` `GrantId` `ScheduleId` `ToolCallId` `SdkSessionId` `TimestampMs` `JsonValue` `Content` (`inline` \| `blob`) `BlobRef` `Surface` `Origin` | §6, §6.1, §9.4 |
| Tools | `ToolClass` `BuiltinTool` (with `BUILTIN_TOOL_CLASS`) `ToolName` `BashCommandPattern` | §5.5 |
| Schedule | `CronExpression` `IanaTimezone` `CatchupPolicy` `CronSchedule` `IntervalSchedule` `ScheduleSpec` `SchedulePausedReason` `ScheduleState` `ScheduleCoverage` | §5.3, §8, §8.1, §8.4 |
| Health | `HealthSettings` `TimeOfDay` `Downtime` `MonitorHealth` `HealthDigest` | §8.3, §8.4 |
| Task spec | `TaskSpec` = `SessionSpec` \| `MonitorSpec`; `ModelChoice` `Budget` `McpServerSpec` `ToolsSpec` `EgressPolicy` `BashPattern` `InputTimeoutPolicy` `TaskPolicy` | §2.1, §5.3, §5.5, §5.6, §7.3, §7.4, §8 |
| Checks | `RuleCheck` (http json_path/css/regex, rss, file_hash, homerun_tool) `ModelCheck` `CheckSpec` `CheckResult` | §8.3 |
| Grants | `ToolGrant` | §5.6 |
| Input | `ApprovalPrompt` (with `AllDomainsGrant`) `QuestionPrompt` `AmbiguousCallPrompt` `InputPrompt` `InputResponse` `InputRequest` `AnswerVia` | §5.4, §5.6, §9.7, §9.9 |
| Domain | `Device` `TaskKind` `Task` `TaskVersion` `Thread` `ThreadSummary` `RunState` `RunTrigger` `Authority` `RunOutcome` `RunError` `Run` `MonitorState` | §2.1, §5.3, §6, §8.3, §9.9 |
| Events | `PersistedThreadEvent` `LiveThreadEvent` `ThreadEvent` and one schema per event type (below) | §5.3, §5.4, §5.6, §6.1, §8.2 |
| IPC | `RpcRequest` `RpcNotification` `RpcResponse` `RpcError` `HelloParams` `HelloResult`, `<Method>Params`/`<Method>Result` per method, `<Name>Notification` per notification | §5.1, §5.2, §9.6, §14 |
| Relay | `RelayEnvelopeHeader` `RelayPresence` `LivePayload` `SealedInstruction` `SealedPush` `SealedAnswer` `SealedInner` `PairingQrPayload` | §9.4, §9.6, §9.7, §9.8 |

**Events.** Persisted events have `{thread_id, seq, run_id, ts, type, payload}`, and
`LIVE_ONLY_EVENT_TYPES` lists the ones that are never stored. Live events carry `after_seq` (the
last persisted `seq` they follow) instead of `seq`.

| Persisted | Live-only (never in `thread_events`, §6.1) |
|---|---|
| `user.message` `message.final` `tool.call` `tool.result` `input.requested` `input.resolved` `run.started` `run.resumed` `run.cancelled` `run.end` `schedule.missed` `schedule.paused` | `message.delta` `run.status` |

**IPC methods.** `schema/manifest.json` lists all 56 methods and 16 notifications with their
callers. Shell-only: `secrets.set`, `secrets.clear`, `secrets.verify`, `cli.approve`, `cli.deny`,
`devices.link.decide`. Runtime → shell: `secrets.persist`, `secrets.delete`. Allowed before `hello` (preauth): `hello`,
`cli.request_access`. The surface was provisional until milestone 7 (D8), which added
`threads.create` with a `task_id` and `secrets.verify`. Milestone 8a added `cli.sign_out` (the
release CLI revokes its own token) and `cli.access_withdrawn` (runtime → shell: dismiss the
prompt), put `hostname` on `CliTokenInfo`, `expires_at` on a request, and a `reason` on a refused
decision. `CliAuthFailureData` and `CliAccessUnavailableData` type their errors' `data`.
Milestone 9 added the account and paired-device methods (`account.*`, `devices.*`, local UI
only), `devices.link.decide` for the shell's native link prompt, `secrets.delete`, and the
notifications `account.changed`, `devices.changed`, `devices.pairing_completed`, and, to the shell
only, `devices.link_requested`, `devices.link_withdrawn` and `browser.open` (§9.6, §10.4, §10.5).

## Versioning

- **Protocol.** `PROTOCOL_VERSION = 1`, the integer the milestone 0 spike already sends.
  - The client sends a `{min, max}` range in `hello`. The runtime picks the highest common version
    or fails with `INCOMPATIBLE_PROTOCOL`, returning its own range so the UI can fall back to its
    bundled baseline (§5.2).
  - Additive changes (an optional field, a method, a notification or an event type) do **not**
    bump the version. They are advertised as capabilities (`CAPABILITIES`, intersected in
    `hello`).
  - Breaking changes bump the version, and the runtime keeps serving N−1.
  - Readers are tolerant. Objects strip unknown keys, and `parseThreadEventLenient` returns
    `{type:"unknown"}` for event types it doesn't know. Invalid vectors therefore never test extra
    keys; the handful of `strictObject`s (JSON-RPC frames) are the exceptions.
- **Task specs.** These are two independent numbers:
  - `tasks.version` / `runs.task_version` counts edits (§6).
  - `spec.format` (`SPEC_FORMAT = 1`) is the shape of the JSON.

  `task_versions` rows are immutable, so every format ever written must stay readable through
  `upgradeSpec(stored) → TaskSpec`.
- **Persisted events** are kept for as long as the thread (§6.1), so their payloads may only
  change additively. A breaking change needs a new event type.
- **Relay.** Every envelope has `v: RELAY_ENVELOPE_VERSION` (1).
- **Snapshot.** CI regenerates `schema/` and `vectors/` and fails on any difference, and
  `test/schema.test.ts` checks the same thing. A protocol change is therefore always a visible
  diff in review.

## Golden vectors

`vectors/<area>.json` is `{ "$comment", "cases": [...] }`. Each case is:

```json
{ "schema": "CronExpression", "name": "four fields", "valid": false, "layer": "json_schema", "value": "0 9 * *" }
```

- `schema` names a `$defs` entry of `schema/homerun.schema.json`.
- `valid: true` means every client must accept `value`, and re-serialising it must give the same
  JSON (Homerun schemas never transform).
- `valid: false` means every client must reject `value`. `layer` says where:
  - `json_schema`: the exported JSON Schema already rejects it, so a generic validator is
    enough.
  - `refinement`: the JSON Schema *accepts* it, and the client has to implement the rule by
    hand (list below). The test suite checks both directions of this label with Ajv, so it stays
    accurate.

There are 505 cases across 133 schemas, 61 of them refinement-only. Every event type, method
and notification has at least one valid vector.

`vectors/answer-rules.json` has a different shape, because the answer rules depend on who
answers. Each case is `{name, prompt, response, from: {role, via}, allowed}`. It covers every
caller role × approval class, question and "Did this happen?", plus lock-screen answers and
"Always allow". The `allowed` values are written by hand, and the tests check that
`checkResponse` agrees with them.

### Rules that JSON Schema can't express

Swift and web clients that validate with JSON Schema alone must implement these by hand. Each one
has `layer: "refinement"` vectors.

- **Cron grammar and ranges** (`parseCron`) and **IANA zone existence**.
- **Size limits:** inline content is at most 4 KB and monitor state at most 64 KB of UTF-8 JSON.
- **Cross-field rules:**
  - `Run`: `task_id` ⇔ `task_version`; the scheduled trigger ⇔ `scheduled_for` ⇔ no origin;
    `attempt > 0` only when scheduled; `ended_at` ⇔ terminal; `outcome` only when succeeded;
    `error` only when failed or abandoned; `claude_pid` only while running or waiting.
  - `Task`: `kind` and `name` match the spec.
  - `InputRequest`: `kind` matches the prompt; `response`, `answered_by` and `answered_at` are
    set exactly when answered; the response type matches the prompt.
  - `input.resolved`: `response`, `answered_by`, `surface` and `via` are set exactly when the state
    is `answered`.
  - `run.end`: `state` is terminal, plus the same outcome and error rules as `Run`.
  - `HelloParams`: the auth kind matches the role (`launch_token`: shell or webview;
    `cli_token`: cli; `dev_token`: cli_dev; `paired_device`: ios or web).
  - `cli.access_decision`: `token` ⇔ `approved` ⇔ no `reason`.
  - `ProtocolRange`: `min ≤ max`.
  - `SealedInner`: `expires_at > created_at`.
- **Spec policy:**
  - open egress with roots;
  - bash patterns without `Bash`;
  - `Bash` or `use_shell_environment` on a monitor;
  - duplicate tools or server ids;
  - the reserved `homerun` server id.
- **Grant shape:**
  - `Bash` grants need a metacharacter-free pattern;
  - the class must match the built-in class table;
  - `WebFetch` grants take a domain pattern, or `*` (`ANY_DOMAIN`) for every domain. `*` covers
    any http(s) host name, but never an IP literal or a `localhost` name, and is never an egress
    allowlist entry (`effectiveEgressDomains` leaves it out). `Bash` never takes a bare `*`.
- **Answer rules** (`checkResponse`, `INPUT_ANSWER_RIGHTS`): these take context (the answering
  role and `via`), so they aren't schema-level at all. Use `vectors/answer-rules.json`.
- **Release builds refuse `cli_dev`** (`DEV_ONLY_ROLES`). This is a build-time rule, not a
  schema rule.
- **Held messages** (`HeldMessages`, `undeliveredMessages`): a message sent while its run waits
  for input is held (§5.7). It is delivered if a `run.resumed` of that run follows it. If the
  run's `run.end` comes first (for example, the run was stopped while it waited), it was not
  delivered: show it that way and offer to resend it. Homerun never sends it later on its own.

## Commands

```sh
pnpm --filter @homerun/core typecheck     # src (no Bun types), then src + test + scripts
pnpm --filter @homerun/core test          # bun test
pnpm --filter @homerun/core gen           # regenerate schema/ and vectors/ after changing src or scripts/vectors
pnpm --filter @homerun/core schema:check  # fail if schema/ or vectors/ are stale (CI)
```

No linter is configured in the repository, so CI runs typecheck, tests and `schema:check`
(`.github/workflows/ci.yml`).

## Rules beyond the design

[`docs/design.md`](../../docs/design.md) is the source of truth. These rules fill in detail the
design leaves open; the schemas enforce them. D-numbers are cited from code and tests.

### Authority and callers

- **Web cannot edit tasks.** Web may not call `tasks.create`, `tasks.update`, `tasks.archive`,
  `schedules.set_enabled`, `grants.create`, `monitors.state.set`, `monitors.state.reset` or
  `health.settings.set`
  (`NOT_WEB` in `methods.ts`). A web client that could edit a monitor's prompt, tools or roots
  would get full authority at its next scheduled fire, because scheduled runs have no origin.
- **A remote's role is what the desktop verified.** `remote.devices` and link requests carry
  `platform` (the role the device has: `ios` only with an App Attest attestation the desktop
  checked) and `claimed_platform` (what it said it was), so the UI can name an unverified
  iPhone that links with a browser's authority (§18 rows 99 and 101).
- **Account deletion says what happened at the identity provider.** `account.delete` returns
  a `ProviderDeletion`: `deleted`, `pending` (the relay keeps retrying) or `manual` (delete
  the sign-in in the provider's settings), §10.9, §18 row 103.
- **Only the development-mode CLI answers approvals.** Anything running as the user can invoke
  the CLI binary (§5.2).
  - A separate caller role, `cli_dev`, is authenticated by `auth.kind: "dev_token"` (the
    development-mode token of §16 M3). Release builds of the runtime refuse it at `hello`
    (`DEV_ONLY_ROLES`, `roleAllowedInBuild`). It has the same methods as `cli`. A dev token uses
    the same 43-character format as CLI tokens.
  - `INPUT_ANSWER_RIGHTS` (also in `schema/callers.json`) lists the prompt types each role may
    answer. The release `cli` role answers questions only. `cli_dev` answers everything.
  - **"Did this happen?" counts as an approval** for this rule, so the release CLI can't answer
    it: the answer decides whether a side effect is repeated or treated as done.
  - `checkResponse` takes the answering role, not a surface. Both CLI roles record
    `surface: "cli"` (`SURFACE_OF_ROLE`).
  - The CLI can't grant itself access: `cli.approve` and `cli.deny` are shell-only.
  - **Nor can it pre-approve calls through a task spec** (milestone 8a). `policyNeedsFullApp`
    lists what a spec adds that only the full app may: a `Bash` pattern classed below
    `destructive`, an MCP server (its process starts without a prompt), or open egress. For an
    edit it compares with the previous spec, so keeping or removing them is fine. The runtime
    refuses a release `cli` caller's `tasks.create` or `tasks.update` with
    `AUTHORITY_INSUFFICIENT` when the list isn't empty.
- **"Did this happen?" needs full authority unless the call was `read`.** After "not run" the
  model re-issues the call, and an existing grant in a full-authority run would let it through
  with no new approval. So `requiredAuthority` follows the call's class, as for approvals:
  `read` → any, otherwise full. §5.4 resumes read calls without asking, so in practice only
  desktop (shell or webview), iOS and `cli_dev` answer it.
- **D4. Webview connection.** The shell forwards webview calls on a separate connection whose
  `hello` declares `role: "webview"`. The runtime pins that connection to the webview allowlist,
  so "never from forwarded webview calls" (§5.2) is enforced by the runtime as well as by the
  shell.
- **D8. Full v1 method surface**, provisional until milestone 7 (see *IPC methods* above). The
  desktop app (M7) added two things: `threads.create` takes an optional `task_id` for a new chat
  on a session task (§2.1), and the shell-only `secrets.verify` checks a candidate API key with
  the provider before the shell stores it (§7.2). `threads.changed` goes to every authenticated
  connection whenever a thread's summary changes.

### Schedules and runs

- **D1. Interval schedules.** `ScheduleSpec` = `CronSchedule` \| `IntervalSchedule`
  (`every_minutes`). An interval is stored in `schedules.cron` as `@every <n>m`
  (`scheduleCronColumn`). "Every 15 minutes" is measured in elapsed time (§8); written as
  `*/15 * * * *`, the fall-back overlap rule would lose an hour of fires.
- **D2. Monitor retries.** A retry is a new run of the same fire with `attempt` 1–2
  (`MAX_RUN_ATTEMPT`); `dedupe_key` is opaque to core, which keeps `UNIQUE(dedupe_key)`
  compatible with §5.3's two retries. The runtime uses
  `fire:<schedule_id>:<scheduled_for>:<attempt>`.
- **D3. Run columns.** `Run.check_result` (§8.3: evidence stored with the run) and `Run.cost_usd`
  (§7.4: cost summed per task). `run.end` also carries `cost_usd`.
- `abandoned` means ending without an agent outcome, for example a run that can't be resumed. A
  fire merged into a later one (§5.3) never becomes a run: it is counted in
  `ScheduleCoverage.merged` and reported by `schedule.missed` with `skipped_by_policy`. `RUN_STATE_TRANSITIONS` documents the legal transitions, and tests
  cover them.
- The monitor schedule lives in the (versioned) spec. `enabled`, `next_fire_at` and
  `last_fired_at` are scheduler state (`ScheduleState`), so pausing a monitor doesn't create a
  task version. v1 allows one schedule per monitor.
- **D11. Why a schedule is paused.** `ScheduleState.paused_reason` is set exactly when it is
  disabled: `user`, `failures` (three failed fires in a row, §5.3), `budget_cap` (§7.4) or
  `archived`. The runtime announces the pauses the user didn't make with a persisted
  `schedule.paused` event. `consecutive_failures` and `missed_since_last_run` feed the
  "never fail silently" view (§8.2) until push arrives.
- **D12. Model checks may name a source.** `ModelCheck.source` is a `RuleSource`: the runtime
  fetches it, as for a rule check, and the model only judges the observation, with no tools.
  Without a source, the model gathers observations with the task's tools under its policy.
- **D13. Health digest.** `health.digest` computes a `HealthDigest` for any period up to 31
  days. The daily one is generated at `HealthSettings.time` and sent as `health.digest_ready`.
  `ScheduleCoverage.merged` counts fires merged because the previous run was still going, so
  every slot is ran, missed (asleep or not running) or merged.
- `Budget.monthly_cap_usd`: the budget period is the calendar month in the schedule's
  timezone.

### Input requests

- **D5. "Did this happen?"** (§5.4) is its own prompt, `ambiguous_tool_call`, with the response
  `outcome: completed | not_run`. It is stored as `kind: "question"`, because §6 allows only
  approval or question. Its authority and who may answer it are under *Authority and callers*.
- **D6. AskUserQuestion shape.** A question prompt holds 1–4 questions in the SDK's shape
  (options with label and description, `multi_select`, optional free-form text), and the
  response holds one answer per question.

### Events

- **D7. Lifecycle events.**
  - `run.cancelled` means a stop was requested (by whom, and why).
  - `run.end` is the single terminal event: state, outcome, error and cost.
  - Persisted `run.started` (trigger, authority, origin, `task_version`), `run.resumed` and
    `schedule.missed`, plus the live-only `run.status`.
  - A no-change monitor fire persists nothing (§8.3).
- **D10. Every `tool.call` gets a `tool.result`.** `status` is one of `ok`, `error`, `denied`,
  `resolved_completed`, `resolved_not_run` or `interrupted_retryable`. The last three are written
  during crash resume (§5.4), so a denied call is never mistaken for an ambiguous one.
- `schedule.missed` carries a `count` and a `skipped_by_policy` reason.
- `run.resumed` carries `ambiguity_resolved`, and `run.status` has a `stopping` detail.
- `schedules.coverage` serves the §8.4 health view, and `threads.mark_read` sets a per-device
  read marker for unread counts.

### Tools, grants and policy

- **D9. Network "Always allow"** creates a `WebFetch` grant for the domain; it does not edit the
  spec or bump its version. The effective egress allowlist is the spec's domains ∪ the network
  grants (`effectiveEgressDomains`). *"Allow all web fetches for this task"* is a `WebFetch` grant
  with pattern `*`: `grantCovers` matches it against the host, and it never joins the allowlist.
  The runtime offers it as `ApprovalPrompt.suggested_grant_all`, beside the per-domain
  `suggested_grant`. It is an optional field, so a client that predates it still offers the
  domain, and `checkResponse` accepts a `*` grant only where the prompt offers it.
- Shell metacharacters are the design's list plus a lone `&`, newline and carriage return.
- "Trusted tools" are grants, created from settings through `grants.create`, not a separate list
  in the spec.
- `AskUserQuestion` is classed `read`: it has no side effect and only raises a question.
- Only half of the open-egress rule can be checked statically ("no roots"). The trusted-MCP half is
  left to runtime policy.

### Ids, formats and wire conventions

- Homerun ids are lowercase UUIDs; SDK ids (tool calls, sessions) are opaque strings.
  Timestamps are integer milliseconds since the epoch.
- The IPC is JSON-RPC 2.0, one frame per line (maximum 4 MiB). Frames must include
  `"jsonrpc":"2.0"`, and params are passed by name only.
- Content is tagged: `{kind:"inline", value}` or `{kind:"blob", sha256, size, preview}`. A JSON
  value can never be mistaken for a blob reference. `blobs.get` pages are at most 1 MiB.
- A pairing code is 16–64 characters of base64url.
- Secret names form an extensible enum: `anthropic_api_key`, `device_static_key`,
  `refresh_token`.
- Model ids are free-form strings (§7.2), because Bedrock, Vertex and Foundry ids differ.
- `Origin = {device_id, surface}`, where `surface` is desktop, cli, ios or web. How an answer
  arrived is a separate field, `via: app | notification`, so a notification answer from iOS is
  still `surface: ios`.
- The CLI access flow: `cli.request_access` is preauth, and the shell receives
  `cli.access_requested`. The user decides in a native prompt, which calls the shell-only
  `cli.approve` or `cli.deny`. The CLI then receives `cli.access_decision` with a token. Tokens
  are listed and revoked by the local UI (`cli.tokens.*`).
- The shell sends `power.will_sleep` and `power.did_wake` to the runtime.

### Where the rest lives

- Next-fire and DST computation: `apps/homerund/src/schedule/`, with its fake-clock suite.
  Core only validates schedules and documents the semantics.
- Bash pattern matching: milestone 6.
- SQL and migrations: `apps/homerund` (`src/store/migrations/`).
- Crypto and ciphertext test vectors: milestone 9.
- The Rust shell reads its webview allowlist from `schema/callers.json` at build time
  (`apps/desktop/src-tauri/shell-core/src/allowlist.rs`).
