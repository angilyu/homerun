# homerund

The local Homerun runtime (docs/design.md §5). It takes a prompt for a task thread or a
one-off chat and runs it through the Agent SDK's `query()` with the bundled `claude`, isolated
from `~/.claude` (§5.3). It streams deltas, persists `thread_events` to SQLite, and serves
JSON-RPC over a 0700 unix socket (§5.2). It also survives being killed (§5.4), and it
runs monitors on their schedules (§8).

Types, the event vocabulary, the protocol and the caller roles come from `@homerun/core`.
They are not redefined here.

## Layout

| Path | What |
|------|------|
| `src/main.ts` | CLI entry: `homerund serve`, `homerund version`, exit codes |
| `src/runtime.ts` | Startup sequence: open and migrate the DB, kill stale process groups and escaped tool processes, sweep caches, recover runs, serve |
| `src/config.ts` | Data dir layout, the bundled `claude`, limits, development-only switches |
| `src/store/` | SQLite (`db.ts`), forward-only migrations with a `VACUUM INTO` backup (`migrate.ts`, `migrations/`), rows, `thread_events`, blobs over 4 KB, the SDK `SessionStore` mirror |
| `src/agent/` | `AgentEngine` seam. `claude/` holds the real engine: query options, clean env, process-group spawn, process-tree kill, SDK message → event translation. `fake-engine.ts` is for unit tests. `policy.ts` holds tool classes and permissions |
| `src/runs/` | Run lifecycle (§5.7): `manager` (one active run per thread, steering), `scheduler` (3 sessions + 2 monitors), `driver` (one run), `recovery` (§5.4), `ambiguity` (the answer to "Did this happen?"), `resume` (results for open calls before a resume), `process-groups` |
| `src/schedule/` | The scheduler (§8): `clock` (wall time and timers; `FakeClock` for tests), `cron-next` and `zone` (next fire in a timezone, with the DST rules), `fire-scheduler` (claims fires, catch-up, downtime, retries, pauses) |
| `src/monitors/` | Monitor runs (§8.3): `sources` and `feed` (what a rule check observes), `rules` (comparators), `check-runner` (the check step), `model-check`, `complete` (the check result, monitor state, act), `digest` (the health digest) |
| `src/power/` | Keeping the computer awake while a run is in progress (§8.1) |
| `src/rpc/` | Unix-socket JSON-RPC server, `hello` and auth, handlers. The client, the data dir and socket paths and the build channel rule live in [`@homerun/client`](../../packages/client) |
| `test/unit/` | Fast tests against the fake engine |
| `test/replay/` | Record/replay harness (§16.2) and the committed cassettes |
| `test/crash/` | Crash-at-every-boundary harness (§16.2) with a simulated `claude` |
| `test/fixtures/mcp-fixture.ts` | A minimal stdio MCP server used by tests |

## Data dir

The default is `~/Library/Application Support/Homerun`, or `HOMERUN_DATA_DIR` if set:

```
homerun.db          SQLite, the source of truth
backups/            pre-migration VACUUM INTO copies
claude-config/      CLAUDE_CONFIG_DIR for every claude (a disposable cache, swept at start)
shell-home/         HOME for tool shells
tmp/                TMPDIR (claude-resume-* dirs are swept at start)
workspaces/  logs/
run/homerund.sock   0700 dir; falls back to $TMPDIR/hr-<uid>/ when the path is too long
run/dev-token       development builds only (0600)
```

## RPC methods

Params, results and callers are defined in `@homerun/core` (`src/protocol/methods.ts`).

- `hello`, `ping`; `secrets.set`/`secrets.clear` (shell only).
- `threads.create`, `threads.list`, `threads.history`, `threads.subscribe`/`unsubscribe`.
  `threads.list` pages on `updated_before`, and a page never ends inside a group of threads
  with the same `updated_at`, so paging can't skip one. Its `unread_count` is always 0 until
  read markers arrive (milestone 7).
- `messages.send`: starts a run, steers the active one, or is held while the run waits for input.
- `runs.get`, `runs.list`, `runs.stop`.
- `tasks.create`, `tasks.get`, `tasks.list`, `tasks.update`, `tasks.archive`; `tasks.run_now`
  (monitors only: returns the active run if there is one; BUDGET_EXCEEDED at the monthly cap).
- `schedules.list`, `schedules.set_enabled`, `schedules.coverage`; `monitors.state.get`,
  `monitors.state.set`, `monitors.state.reset` (CONFLICT unless `expected_version` is current);
  `health.digest`, `health.settings.get`, `health.settings.set`. The web client may read these
  but not change a task, a schedule, monitor state or the digest settings (§9.9).
- Notifications: `health.digest_ready` to every client; `power.will_sleep` and `power.did_wake`
  from the shell.
- `input.list_pending`; `input.answer` for "Did this happen?" (below). Approvals and
  questions return UNAVAILABLE with `not_implemented` until milestone 6.
- `blobs.get`: a stored tool input or output over 4 KB, in pages (`offset`, `length`).

## Crash resume (§5.4, milestone 4)

At start, before any run resumes, the runtime:
1. Kills what a killed runtime or `claude` left running (§5.1). It kills each recorded
   process group that is still alive, and the tool processes that escaped it:
   - the process tree;
   - every process still in the dead `claude`'s session. `claude` is spawned detached, so
     its pid is its session id;
   - the Bash tool's shells, which call `setsid` themselves and so leave that session. They
     are found by this data dir's `claude-config` path in their command (the snapshot they
     source), unless a live `claude` still owns them (`orphanedTools`).

   The same happens when `claude` dies on its own while the runtime keeps running.
2. Recovers each interrupted run from `thread_events`:
   - a `tool.call` with no `tool.result` for a read-class tool gets `interrupted_retryable`;
   - any other such call parks the run in `waiting_input`, with one *"Did this happen?"*
     request per call (`required_authority: "full"`);
   - otherwise the run is requeued with a continuation note. The note names each finished
     call the model never saw in the transcript.

`claude` dying on its own mid-run goes through the same recovery.

**Answering.** `input.answer` with `{ type: "ambiguous_tool_call", outcome: "completed" | "not_run" }`:
- Who may answer: the shell, `webview`, `ios` and `cli_dev`, in the app. The web client, the
  release CLI and a lock-screen action are refused with `AUTHORITY_INSUFFICIENT`
  (`INPUT_ANSWER_RIGHTS`, full authority).
- The first answer wins. Later ones get `already_resolved`, with who answered.
- One transaction records `input.resolved` and the call's `tool.result` (`resolved_completed` or
  `resolved_not_run`), and adds a sentence to the run's continuation note.
- After the run's last request is answered, messages held while it waited are released, and the
  run is requeued (`resume_reason: ambiguity_resolved`).

**Resuming.** Before `claude` resumes a stored session, `prepareResume` gives every `tool_use`
still open in the transcript a `tool_result`, in the entry shape `claude` writes itself. The
result is the user's answer, the recorded result (the SDK mirror can lose the last one), or
"did not start" for a call the gate never allowed. Otherwise `claude` would write
"interrupted" itself, which the model reads as "run it again". The note always follows as an
explicit continuation message, before any held messages.

`claude` mirrors its transcript a little after the fact: a tool can start, and even finish its
side effect, before anything of the conversation is stored. A session with no stored
conversation cannot be resumed (`claude` exits with "No conversation found"). So a run resumes
its own session only if the store holds a conversation for it (`hasConversation`). Otherwise it
continues from the thread's previous session with one, or a new session, and gets its messages
again: those it had before it parked, then the note, then the held ones. A follow-up run skips
such a session in the same way.

A run stopped while it waits gets an "outcome unknown" result for each open call, so the
thread's next run resumes a well-formed transcript. Messages held while it waited are never
delivered, and nothing sends them later: they stay held on the cancelled run, and a later run
takes only its own inputs. Clients show them as not delivered and offer to resend them. The
rule is `HeldMessages` in `@homerun/core`: a held message was delivered if a `run.resumed` of
its run follows it. So `run.resumed` is written only once a resume can start. A resume that
fails its setup (its folder is gone, say) ends without one, and its held messages show as
not delivered too.

`HOMERUN_DEV_AMBIGUITY_MODE=truncate` (development only) applies the §5.4 truncation
fallback instead. The resume starts with `resumeSessionAt` at the entry before the assistant message
that made the first answered call, and the note says what happened to each call it hides.
The point is stored in `runs.resume_at` (migration 0002) until `claude` writes the new
branch, so a crash in between truncates again. Known limit: messages the model had already
received after that point are not re-sent.

A note not yet delivered when the runtime is killed again is merged into the next one, never
replaced. The note is delivered with a fresh id each launch, so a crash in the middle of
delivering it can show the model the same note twice.

## Scheduler and monitors (§8, milestone 5)

**Fires.** Every schedule is evaluated when the runtime starts, every 15 s, at each wake, and
whenever a task or schedule changes. Evaluating a schedule claims each slot since
`last_evaluated_at` exactly once, in one transaction: a `schedule_fires` row per slot, keyed
by `(schedule_id, scheduled_for)`, so a crash can neither lose nor repeat a fire. The fire's
run is inserted with the dedupe key `fire:<schedule>:<slot>:<attempt>` in the transaction
that starts it. Cron is evaluated in the schedule's own timezone with the §8 DST rules: a time
in the spring-forward gap fires at the first valid instant after it, and a time in the fall-back
overlap fires once. Timers are armed at most one tick ahead, so a timer set before a sleep never
fires late by the length of the sleep.

**Missed fires.** A slot is missed when it falls in a `downtime` interval:
- *asleep*: from the shell's `power.will_sleep` and `power.did_wake`, or, without a shell, from a
  gap of more than 45 s between ticks;
- *not running*: from the previous runtime life's last heartbeat (written every minute) or its
  clean stop to this start. The new life and its downtime are recorded in one transaction.

The catch-up policy then picks what runs late (§8.1): `run_once` the latest missed slot,
`run_all` the last `max_catchup`, `skip` none. Each group of missed slots becomes one
`schedule.missed` event on the monitor's thread, with its cause, count and how many were
caught up, and `schedules.coverage` counts it per day. A late run is not counted as having run
on time. An on-time slot that comes due while the monitor's previous fire is still waiting is
merged into it (`skipped_by_policy`).

**Keeping awake.** While any run is running (not while it waits for input, §5.6), the runtime
holds one `caffeinate -i -w <pid>` (§8.1). With `-w` it exits when homerund does, so a crash never
leaves the Mac unable to sleep. It is best-effort: if caffeinate is missing, cannot start or
exits while held, homerund logs one warning and stops trying until it restarts; runs are never
failed or delayed by it. Elsewhere this is a no-op for now.

**Checking sleep and wake by hand.** The shell's observer (`apps/desktop/src-tauri/src/power.rs`)
has unit tests only; to see it work on a real Mac:
1. Build and start the desktop app (it spawns homerund), with a monitor on a `*/5` schedule.
2. Run `pmset sleepnow`, wait past a fire time, then wake the Mac.
3. In `~/Library/Application Support/Homerun/logs/homerund.log`, expect a `power.will_sleep`
   line before the sleep and a `power.did_wake` line after it, and no
   `asleep, from a gap between ticks` line for the same span. `shell.log` has a
   `... not delivered` line if forwarding failed.
4. `sqlite3 ~/Library/Application\ Support/Homerun/homerun.db "SELECT * FROM downtime ORDER BY start_at DESC LIMIT 3"`
   shows a row with `cause = asleep, source = os` covering the sleep, and
   `homerun schedules coverage TASK` counts the fire as missed while asleep.

**Monitor runs** (§8.3). A monitor run is a check, then an act step only if the check found a
change:
- A *rule check* is evaluated by the runtime with no model call. Sources: `http` (a JSON path, a
  CSS selector, a regex, or the whole body), `feed` (RSS or Atom, parsed here), `file_hash`
  under the task's roots. `homerun_tool` sources are refused until Homerun's own tools exist.
  Comparators: `changed`, `equals`, `above`, `below` (edge-triggered: they report crossing the
  line, not staying past it), `new_items`.
- The feed parser (`feed.ts`) is ours, not a dependency. It decodes only the predefined and
  numeric entities, never expands declared ones (no XXE or entity bombs), skips a DOCTYPE's
  internal subset, and refuses more than 5 MB, 64 levels of nesting or 100,000 elements. An
  entry's id is its `guid`, `rdf:about` or Atom `id`, else its link, else a hash of its title
  and date.
- A *model check* is one small `query()` with `check.model` that must return a `CheckResult`
  (structured output). With a `source`, the runtime fetches the observation and the model
  judges it with no tools (3 turns). Without one, it may use the task's tools, but only calls
  the policy allows outright (12 turns). Either way the answer arrives as a call to `claude`'s
  own `StructuredOutput` tool, which the engine lets through without the policy gate. The check
  is capped at the task's `max_run_usd`; the act step gets what is left.
- The first check records a baseline and reports no change, except a threshold comparator
  whose condition already holds.
- The check's result is stored on the run as evidence (`runs.get`, `check_result`). A quiet check
  writes nothing to the thread. A change starts the act step in the same run, with the
  evidence as its input.
- Monitor state advances only when the run succeeds, in the transaction that ends it. If the
  user edited the state meanwhile (`monitors.state.set` bumps its version), the edit wins and
  the run's new state is dropped.

**Failures.** A failed fire is retried twice, after 1 and 5 minutes, as new attempts of the same
fire. Three failed fires in a row pause the schedule (`paused_reason: failures`), and reaching
the task's monthly cap pauses it too (`budget_cap`); each writes `schedule.paused` to the
thread. Until push notifications arrive (milestone 9), missed and failed fires are reported by
these events, `schedules.list` (`missed_since_last_run`), the health digest and the CLI.

**Health digest.** Once a day at the configured time (default 08:00, device timezone; late if
the Mac was asleep), the runtime stores a digest and sends `health.digest_ready`: per monitor,
fires due, runs, changes, failures, misses by cause, fires caught up, cost; and when the Mac
was asleep or Homerun was not running. `health.digest` computes one for any period up to 31 days.

## Running

```sh
pnpm install
cd apps/homerund
bun run src/main.ts serve --no-launch-token --dev-auto-approve   # development
```

- Packages come from registry.npmjs.org: the repo-root `.npmrc` overrides any
  user-level registry, and `scripts/check-registry.sh` (run in CI) fails if
  `pnpm-lock.yaml` names another registry host.
- In production the shell writes a launch token on stdin line 1. It is the
  `shell` role credential (§5.2). The runtime serves until stdin closes.
- `--no-launch-token` is development-only. Connect with the token in
  `run/dev-token` instead, and stop the runtime with SIGTERM.
- The API key is never read from disk. The shell sends it with `secrets.set`,
  and the runtime keeps it in memory only.
- Exit codes:
  - 0: clean stop;
  - 1: startup failure;
  - 2: stdin closed before the token;
  - 3: another runtime is already serving this data dir;
  - 64: usage, or a development-only switch in a release build.

### Dev shell

Until the desktop app exists, `scripts/dev-shell.ts` stands in for the shell:

```sh
pnpm --filter @homerun/homerund dev [--no-key] [-- <serve switches>]
```

- It starts `homerund serve` from source and writes a fresh launch token to its stdin.
- It then sends the API key with `secrets.set` on the shell's connection. The key
  comes from `ANTHROPIC_API_KEY` in its own environment (which is removed before
  homerund is spawned), or from a hidden prompt. It never reads a file.
- `--no-key` starts without a key, for use with `HOMERUN_ANTHROPIC_BASE_URL` and a
  replay server.
- Ctrl-C closes homerund's stdin, and the runtime shuts down gracefully.
- Drive it with the development CLI ([`apps/cli`](../cli)), e.g. `pnpm homerun status`.

### Build channel

The build channel fails closed:
- Running from source (`bun run`, `bun test`) is **development**.
- A compiled executable (`bun build --compile`) is **release** unless it was
  built with an explicit `--define HOMERUND_BUILD='"development"'`. Any other
  defined value is also release.
- `bun run build` produces a release binary. `bun run build:dev` produces a
  development one (`dist/homerund-dev`).

A release build:
- refuses every switch below with exit code 64 and
  `<switch> is only available in development builds; this is a release build`,
  before it reads the launch token;
- writes no `run/dev-token`;
- refuses a `cli_dev`/`dev_token` `hello` with UNAUTHENTICATED.

`test/unit/build-gate.test.ts` compiles the binary both ways and checks this.

Development-only switches:

| Switch | Effect |
|--------|--------|
| `--dev-auto-approve` / `HOMERUN_DEV_AUTO_APPROVE=1` | Approve `needs_approval` tools. Approval requests are milestone 6 |
| `HOMERUN_DEV_AMBIGUITY_MODE=inject\|truncate` | How an answer to "Did this happen?" is applied (below). The default is `inject` |
| `--dev-mcp-overrides <file>` / `HOMERUN_DEV_MCP_OVERRIDES` | JSON `{ name: { command, args?, env? } }` that replaces a spec's MCP server launch |
| `HOMERUN_ANTHROPIC_BASE_URL` | Point claude at a proxy or at the replay server |
| `HOMERUN_FORCE_MODEL`, `HOMERUN_CHAT_MODEL`, `HOMERUN_CHAT_MAX_BUDGET_USD` | Model and budget overrides |
| `HOMERUN_SHUTDOWN_GRACE_MS` | How long a shutdown waits for runs |

Other settings:
- `HOMERUN_MAX_SESSIONS` / `HOMERUN_MAX_MONITORS`: concurrency. The defaults are 3 and 2.
- `HOMERUN_CLAUDE_PATH`: overrides the bundled `claude`. In development it is
  found in the SDK's platform package.
- `HOMERUN_LOG_LEVEL`.

## Tests

```sh
pnpm --filter @homerun/homerund typecheck
pnpm --filter @homerun/homerund test:unit     # fake engine, no network
pnpm --filter @homerun/homerund test:replay   # real claude against recorded API exchanges, no key
pnpm --filter @homerun/homerund test:crash    # kill at every event boundary, simulated claude (two to three minutes)
scripts/check-no-secrets.sh                   # from the repo root
```

CI runs all of these on Linux (`ubuntu-latest`; `.github/workflows/ci.yml`): job `homerund`
runs the secret scan, typecheck, unit and replay tests, and job `homerund-crash` runs the crash
tests on a sample of boundaries in parallel. `.github/workflows/nightly.yml` runs the full
crash sweep on main every day at 09:00 UTC, and on demand. The code is POSIX-only (process groups, `ps`, unix sockets) and is tested on macOS and Linux; liveness checks ignore zombies, which `kill(pid, 0)` still reports as alive.

### Fake-clock suite (§16 row 5)

The scheduler takes a `Clock`; `FakeClock` moves wall time and fires timers only when a test
says so, and can "sleep" the Mac (time jumps, timers do not fire) or change the device
timezone. `test/unit/schedule/rig.ts` runs a real `Runtime` on a temporary data dir with the
fake engine, so the tests reach fires, runs, events and monitor state through the same code as
production. Covered:
- `cron-next.test.ts`: the next-fire function against a minute-by-minute oracle across zones and
  DST transitions, plus the spring-forward gap and fall-back overlap rules spelled out.
- `fires.test.ts`: on-time fires and power assertions; a sleep across several fires under `run_once`, `run_all`
  (bounded by `max_catchup`) and `skip`; shell sleep/wake versus gap detection; the wall
  clock stepping forwards or backwards.
- `lifecycle.test.ts`: downtime while not running, including a crash with no clean stop; DST
  in the schedule's zone; a travelling device timezone versus a fixed schedule zone; busy
  monitors and merged slots; retries and pauses; state advancing only on success; a user edit
  winning; `tasks.run_now`.
- `race.test.ts`: two connections claiming or promoting the same slot; a crash between inserting
  a fire's run and marking the fire; the web client refused.
- `model-check.test.ts`, `digest.test.ts`, `shell-power.test.ts`, and
  `test/unit/monitors/rules.test.ts` (sources and comparators against a local HTTP server).
- `test/unit/monitors/feed.test.ts`: hand-made feeds in real-world shapes (RSS 2.0 with the
  usual namespaces, RSS 1.0, Atom, no guids) and hostile ones (XXE, an entity bomb, deep
  nesting, oversized or truncated input).
- `test/unit/power.test.ts`: keeping awake when caffeinate is missing, not executable or exits
  at once.

### Replay harness (§16.2)

`test/replay/replay-server.ts` stands in for the Messages API through
`HOMERUN_ANTHROPIC_BASE_URL`. Each scenario in `scenarios.test.ts` starts a real
`homerund` and a real `claude`, then drives them over the socket.

In replay mode, each request is matched by fingerprint to the cassette:
- The fingerprint covers the model, the tool names and a skeleton of each
  message. Machine paths are normalised.
- A mismatch fails with a diff, and so does an unused entry.
- Tool use / tool result pairing is enforced.

The scenarios:
- text chat;
- Bash tool, with a large output going to blobs;
- MCP tool;
- steering;
- kill and resume;
- kill mid-tool: the call is ambiguous and the run is parked in `waiting_input`;
  no tool process survives; a lock-screen answer is refused; stopping the run gives the
  call an "outcome unknown" result;
- stop during a tool call;
- isolation;
- `ambiguity-completed`: the user answers "completed". The run resumes with the injected
  result and a held message, and the call is not run again;
- `kill-claude-mid-tool`: `claude` alone is killed, and its orphaned shell with it. The user
  answers "not run", and the call runs again exactly once;
- `ambiguity-truncate`: the truncate fallback;
- `cancel-parked`: a parked run is stopped, and the thread's next turn resumes cleanly;
- `monitor-model-no-change`: a model check with an HTTP source (a local page, normalised to
  `status.example.com`) records a baseline, then sees no change. Each check is one request
  offering only `claude`'s `StructuredOutput` tool, and the thread stays empty;
- `monitor-model-changed-act`: the page changes, the check reports it, the act step writes
  the report, and the monitor state advances with the run.

Replay skips a scenario whose cassette is missing.

Every scenario also checks generic invariants:
- every `tool.call` of a finished run has exactly one `tool.result`;
- no stored deltas;
- event sequence order, and nothing after `run.end`;
- no finished run still holds a process group.

### Crash harness (§16.2)

`test/crash/` kills homerund at every event boundary, systematically. Real `claude` would
need a cassette per boundary, so this harness uses `sim-claude.ts` instead. It is an engine
that behaves like `claude` where recovery depends on it:
- it mirrors transcript entries through the session store, sometimes lagging a step, or (the
  `lagging` scenario) storing nothing until after the first side effect;
- its hooks write `tool.call` and `tool.result`;
- it resumes from the stored chain (and `resumeSessionAt`), and fails as `claude` does when
  the session has nothing stored;
- when it resumes a `tool_use` with no result, it writes its own "interrupted" result and
  runs the call again, as real `claude` does.

Its tools append to a ledger file, which is the ground truth for "did this happen?".

A boundary is any commit homerund makes (`Store.commitObserver`), or the point just before or
just after a tool's side effect. For each scenario (serial calls; parallel destructive calls in
one message; the same in truncate mode; a lagging mirror), the harness does the following. Each life is a
child process (`child.ts`).
1. It counts the boundaries of a clean run and names each one's kind (`boundaries.ts`).
2. For each boundary k, it SIGKILLs homerund at k. A second life recovers, answers "Did this
   happen?" truthfully from the ledger, and finishes the run. Before answering, the user also
   sends a message, which is held.
3. For each k, it kills `claude` alone at k.
4. For each first crash that left an ambiguous call, it crashes again at every boundary of
   the recovery life.

After each trial it checks invariants:
- every side effect happened exactly once;
- every call has one result;
- every request was resolved once, and none is pending;
- no input is left undelivered, the user's message is in the transcript once, and so is the
  held message, which no client would show as not delivered;
- every run is terminal with one `run.end`, and the last one succeeded;
- the final transcript has no open `tool_use` and no "interrupted" result, and it agrees
  with the ledger about which calls ran.

`test/crash/monitor.test.ts` does the same for the scheduler (§8.2, §8.4). A monitor was last
checked at 10:05 and Homerun then stayed stopped until 11:05 while the watched file changed.
The life under test claims the missed slots (`run_all`, max 3) and the on-time one, runs each
check, acts once on the change and saves the monitor state. It is killed at every commit and
around the act's side effect; later lives on the same data dir (`monitor-child.ts`) recover.
However the crash fell, each slot is claimed and run once, the missed slots are reported once,
the act's side effect happens once, and the state ends at the new file's hash. The sweep runs
twice: once as above, and once with the act's mirror storing nothing until its Write happened,
so a crash can leave an act session with no stored conversation; the act step then starts a new
session, never the thread's previous one.

#### Full and sampled sweeps

`HOMERUN_CRASH_SWEEP` chooses which boundaries a sweep kills at (`test/crash/sampler.ts`):

| Mode | Boundaries | Where |
|---|---|---|
| `full` (the default) | every boundary, as described above | locally, and nightly on main |
| `sample` | per phase of each sweep: the first and the last boundary, one boundary of every kind, then random others up to a budget. The second crash follows one of the ambiguous first crashes | CI on every pull request and push |
| `exhaustive` | `full`, and the second crash after every first crash, not only the ambiguous ones | by hand |

A boundary's kind is what happened there: a commit is named by the event types it appended and
the other tables it changed (for example `commit:tool.call+threads` or
`commit:runs+schedule_fires`), and the points around a tool's side effect are
`tool:before_effect` and `tool:after_effect`. The budgets (`BUDGET` in `crash.test.ts` and
`monitor.test.ts`) keep the sampled crash tests near a minute on CI.

The random part is seeded by `HOMERUN_CRASH_SEED`, else `GITHUB_SHA`, else the time, so each
commit tries a different subset and, over many commits and the nightly run, all of them. The
log prints the seed and every boundary chosen. To reproduce a failure from CI:

```sh
HOMERUN_CRASH_SWEEP=sample HOMERUN_CRASH_SEED=<seed from the log> pnpm --filter @homerun/homerund test:crash
```

The same seed draws the same boundaries as long as the scenarios' boundaries are unchanged.

#### Re-recording

Re-record only when a scenario or the request shape changes. Recording costs
real money: about 1–2 cents per scenario on Haiku, mostly the cache write of
claude's system prompt.

```sh
# ANTHROPIC_API_KEY=... in .env.local at the repo root (gitignored, mode 600)
pnpm --filter @homerun/homerund record            # all scenarios
cd apps/homerund && HOMERUN_REPLAY=record bun test test/replay -t "steering"   # one
```

In record mode:
- The key is injected only by the replay server. `homerund` and `claude` never
  see it.
- Recording aborts once the spend passes `RECORD_CAP_USD` ($0.25).
- Cassettes never store headers. The writer refuses any text with
  `x-api-key`/`authorization`.
- The key value, home, user name and temp paths are scrubbed from cassettes.

Before committing cassettes, run `scripts/check-no-secrets.sh`, which
`test/unit/secret-scan.test.ts` also runs. It fails on any `sk-ant-…` string
other than the known mock values.

Set `HOMERUN_REPLAY_VERBOSE=1` to stream homerund's stderr, and
`HOMERUN_REPLAY_KEEP=1` to keep scene data dirs.
