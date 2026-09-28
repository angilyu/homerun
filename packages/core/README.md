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
  cron.ts           dependency-free 5-field cron parser (plus @daily-style macros)
  timezone.ts       IANA zone validation through Intl
  schedule.ts       CronSchedule | IntervalSchedule, catch-up policy, ScheduleState, ScheduleCoverage
  task-spec.ts      SessionSpec | MonitorSpec, policy, checks, SPEC_FORMAT, upgradeSpec()
  grants.ts         ToolGrant and its shape rules, effectiveEgressDomains()
  input.ts          input prompts and responses, requiredAuthority(), checkResponse()
  domain.ts         Device, Task, TaskVersion, Thread, Run (+ transitions), MonitorState, ThreadSummary
  events.ts         thread_events: persisted and live-only unions, parseThreadEventLenient()
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
| Schedule | `CronExpression` `IanaTimezone` `CatchupPolicy` `CronSchedule` `IntervalSchedule` `ScheduleSpec` `ScheduleState` `ScheduleCoverage` | §8, §8.1, §8.4 |
| Task spec | `TaskSpec` = `SessionSpec` \| `MonitorSpec`; `ModelChoice` `Budget` `McpServerSpec` `ToolsSpec` `EgressPolicy` `BashPattern` `InputTimeoutPolicy` `TaskPolicy` | §2.1, §5.3, §5.5, §5.6, §7.3, §7.4, §8 |
| Checks | `RuleCheck` (http json_path/css/regex, rss, file_hash, homerun_tool) `ModelCheck` `CheckSpec` `CheckResult` | §8.3 |
| Grants | `ToolGrant` | §5.6 |
| Input | `ApprovalPrompt` `QuestionPrompt` `AmbiguousCallPrompt` `InputPrompt` `InputResponse` `InputRequest` `AnswerVia` | §5.4, §5.6, §9.7, §9.9 |
| Domain | `Device` `TaskKind` `Task` `TaskVersion` `Thread` `ThreadSummary` `RunState` `RunTrigger` `Authority` `RunOutcome` `RunError` `Run` `MonitorState` | §2.1, §5.3, §6, §8.3, §9.9 |
| Events | `PersistedThreadEvent` `LiveThreadEvent` `ThreadEvent` and one schema per event type (below) | §5.3, §5.4, §5.6, §6.1, §8.2 |
| IPC | `RpcRequest` `RpcNotification` `RpcResponse` `RpcError` `HelloParams` `HelloResult`, `<Method>Params`/`<Method>Result` per method, `<Name>Notification` per notification | §5.1, §5.2, §9.6, §14 |
| Relay | `RelayEnvelopeHeader` `RelayPresence` `LivePayload` `SealedInstruction` `SealedPush` `SealedAnswer` `SealedInner` `PairingQrPayload` | §9.4, §9.6, §9.7, §9.8 |

**Events.** Persisted events have `{thread_id, seq, run_id, ts, type, payload}`, and
`LIVE_ONLY_EVENT_TYPES` lists the ones that are never stored. Live events carry `after_seq` (the
last persisted `seq` they follow) instead of `seq`.

| Persisted | Live-only (never in `thread_events`, §6.1) |
|---|---|
| `user.message` `message.final` `tool.call` `tool.result` `input.requested` `input.resolved` `run.started` `run.resumed` `run.cancelled` `run.end` `schedule.missed` | `message.delta` `run.status` |

**IPC methods.** `schema/manifest.json` lists all 40 methods and 6 notifications with their
callers. Shell-only: `secrets.set`, `secrets.clear`, `cli.approve`, `cli.deny`. Runtime → shell:
`secrets.persist`. Allowed before `hello` (preauth): `hello`, `cli.request_access`. Everything
except `hello` and `cli.request_access` is **provisional until milestone 7** (D8).

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

There are 406 cases across 121 schemas, 52 of them refinement-only. Every event type, method
and notification has at least one valid vector.

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
  - `HelloParams`: the auth kind matches the role.
  - `cli.access_decision`: `token` ⇔ `approved`.
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
  - `WebFetch` grants take a domain pattern.
- **Answer rules** (`checkResponse`): these take context (the answering surface), so they aren't
  schema-level at all.

## Commands

```sh
pnpm --filter @homerun/core typecheck     # src (no Bun types), then src + test + scripts
pnpm --filter @homerun/core test          # bun test
pnpm --filter @homerun/core gen           # regenerate schema/ and vectors/ after changing src or scripts/vectors
pnpm --filter @homerun/core schema:check  # fail if schema/ or vectors/ are stale (CI)
```

No linter is configured in the repository, so CI runs typecheck, tests and `schema:check`
(`.github/workflows/ci.yml`).

## Design gaps found

`docs/design.md` is the source of truth. Where turning it into schemas needed a decision, it is
recorded here.

### Open questions: confirm before milestone 6 or 10

- **Q1. Can the web client edit tasks?** §9.9 says the `web_read_only` run is "the only
  per-surface difference in authority". But a web client that can edit a monitor's prompt, tools
  or roots gets full authority at the next scheduled fire, because scheduled runs have no origin.
  That would bypass §9.9 entirely. §9.9 also says the policy "can be relaxed only on the desktop".
  - **Current choice (conservative):** web may not call `tasks.create`, `tasks.update`,
    `tasks.archive`, `schedules.set_enabled`, `grants.create`, `monitors.state.set` or
    `monitors.state.reset`. Widening an allowlist later is additive; narrowing it would break web
    clients.
  - **Alternative:** allow the edits, but record the authority on `task_versions`, so a version
    edited from the web runs `web_read_only`.
- **Q2. Can the CLI answer approvals?** The §5.2 threat model says approvals always happen "in
  UI the user can see", and anything running as the user can invoke the CLI binary. But the §16
  M6 exit criterion includes "answer from CLI", and M6 comes before the desktop app (M7).
  - **Current choice:** `input.answer` is open to the CLI and `checkResponse` doesn't
    restrict it, so M6 can be built. The CLI still can't grant itself access: `cli.approve` and
    `cli.deny` are shell-only.
  - **To decide in M6 or M7:** keep this, or restrict CLI approvals to development-mode tokens.

### Decisions (approved in the milestone 1 plan)

- **D1. Interval schedules.** `ScheduleSpec` = `CronSchedule` \| `IntervalSchedule`
  (`every_minutes`). An interval is stored in `schedules.cron` as `@every <n>m`
  (`scheduleCronColumn`). "Every 15 minutes" is measured in elapsed time (§8); written as
  `*/15 * * * *`, the fall-back overlap rule would lose an hour of fires.
- **D2. Monitor retries.** A retry is a new run of the same fire with `attempt` 1–2
  (`MAX_RUN_ATTEMPT`); `dedupe_key` is opaque to core. This reconciles `UNIQUE(dedupe_key)` with
  §5.3's two retries. M5 fixes the key format, for example `task:fire:attempt`.
- **D3. Missing `runs` columns.** Added `Run.check_result` (§8.3: evidence "stored with the run")
  and `Run.cost_usd` (§7.4: cost summed per task). `run.end` also carries `cost_usd`.
- **D4. Webview connection.** The shell forwards webview calls on a separate connection whose
  `hello` declares `role: "webview"`. The runtime pins that connection to the webview allowlist,
  so "never from forwarded webview calls" (§5.2) is enforced by the runtime as well as by the
  shell.
- **D5. "Did this happen?"** (§5.4) is its own prompt, `ambiguous_tool_call`, with the response
  `outcome: completed | not_run`. It is stored as `kind: "question"` because §6 allows only
  approval|question. Web can answer it: after "not run" the model re-issues the call, which goes
  through policy again.
- **D6. AskUserQuestion shape.** A question prompt holds 1–4 questions in the SDK's shape
  (options with label and description, `multi_select`, optional free-form text), and the
  response holds one answer per question.
- **D7. Lifecycle events.**
  - `run.cancelled` means a stop was requested (by whom, and why).
  - `run.end` is the single terminal event: state, outcome, error and cost.
  - Added persisted `run.started` (trigger, authority, origin, `task_version`), `run.resumed` and
    `schedule.missed`, plus the live-only `run.status`.
  - A no-change monitor fire persists nothing (§8.3).
- **D8. Full v1 method surface**, provisional until M7 (see *IPC methods* above).
- **D9. Network "Always allow"** creates a `WebFetch` grant for the domain; it does not edit the
  spec or bump its version. The effective egress allowlist is the spec's domains ∪ the network
  grants (`effectiveEgressDomains`).
- **D10. Every `tool.call` gets a `tool.result`.** `status` is one of `ok`, `error`, `denied`,
  `resolved_completed`, `resolved_not_run` or `interrupted_retryable`. The last three are written
  during crash resume (§5.4), so a denied call is never mistaken for an ambiguous one.

### Smaller gaps filled

**Ids, formats and wire conventions**
- Homerun ids are lowercase UUIDs; SDK ids (tool calls, sessions) are opaque strings.
  Timestamps are integer milliseconds since the epoch.
- The IPC is JSON-RPC 2.0, one frame per line (maximum 4 MiB). Frames must include
  `"jsonrpc":"2.0"` (the spike omits it), and params are passed by name only.
- Content is tagged: `{kind:"inline", value}` or `{kind:"blob", sha256, size, preview}`. A JSON
  value can never be mistaken for a blob reference. `blobs.get` pages are at most 1 MiB.
- The pairing code format isn't in the design; it is 16–64 characters of base64url.
- Secret names form an extensible enum: `anthropic_api_key`, `device_static_key`,
  `refresh_token`.
- Model ids are free-form strings (§7.2), because Bedrock, Vertex and Foundry ids differ.

**Surfaces and the CLI**
- `Origin = {device_id, surface}`, where `surface` is desktop, cli, ios or web. How an answer
  arrived is a separate field, `via: app | notification`, so a notification answer from iOS is
  still `surface: ios`.
- The CLI flow: `cli.request_access` is preauth, and the shell receives `cli.access_requested`.
  The user decides in a native prompt, which calls the shell-only `cli.approve` or `cli.deny`.
  The CLI then receives `cli.access_decision` with a token. Tokens are listed and revoked by the
  local UI (`cli.tokens.*`).
- The shell sends `power.will_sleep` and `power.did_wake` to the runtime.

**Tools, grants and policy**
- Shell metacharacters are the design's list plus a lone `&`, newline and carriage return (this
  only tightens the rule).
- "Trusted tools" are grants, created from settings through `grants.create`, not a separate list
  in the spec.
- `AskUserQuestion` is classed `read`: it has no side effect and only raises a question.
- Only half of the open-egress rule can be checked statically ("no roots"). The trusted-MCP half is
  left to runtime policy.
- `Budget.monthly_cap_usd`: §7.4 has per-task caps but no period, so monthly is a guess.

**Runs, schedules and events**
- `abandoned` means ending without an agent outcome: a fire merged by `run_once` catch-up, or a
  run that can't be resumed. `RUN_STATE_TRANSITIONS` documents the legal transitions, and tests
  cover them.
- The monitor schedule lives in the (versioned) spec. `enabled`, `next_fire_at` and
  `last_fired_at` are scheduler state (`ScheduleState`), so pausing a monitor doesn't create a
  task version. v1 allows one schedule per monitor.
- `schedule.missed` carries a `count` and a `skipped_by_policy` reason.
- `run.resumed` carries `ambiguity_resolved`, and `run.status` has a `stopping` detail.
- Added `schedules.coverage` (§8.4 health view) and `threads.mark_read`. Unread counts need a
  per-device read marker, which §6 lacks; the storage is M2's to design.

### Out of scope here

- Next-fire and DST computation: M5, with its fake-clock suite. Core only validates schedules and
  documents the semantics.
- Bash pattern matching: M6.
- SQL and migrations: M2.
- Crypto and ciphertext test vectors: M9.
- The spike runtime and the Rust shell's `RUNTIME_METHODS`: the shell moves to
  `schema/callers.json` in M7.
