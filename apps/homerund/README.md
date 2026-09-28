# homerund

The local Homerun runtime (docs/design.md §5). It takes a prompt for a task thread or a
one-off chat and runs it through the Agent SDK's `query()` with the bundled `claude`, isolated
from `~/.claude` (§5.3). It streams deltas, persists `thread_events` to SQLite, and serves
JSON-RPC over a 0700 unix socket (§5.2). It also survives being killed (§5.4).

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
- `runs.get`, `runs.list`, `runs.stop`; `tasks.create`, `tasks.get`, `tasks.list`.
- `input.list_pending`; `input.answer` for "Did this happen?" (below). Approvals and
  questions return UNAVAILABLE with `not_implemented` until milestone 6.
- `blobs.get`: a stored tool input or output over 4 KB, in pages (`offset`, `length`).

## Crash resume (§5.4, milestone 4)

At start, before any run resumes, the runtime:
1. Kills what a killed runtime or `claude` left running (§5.1). It kills each recorded
   process group that is still alive, and the tool processes that escaped it: the process
   tree, plus every process still in the dead `claude`'s session. `claude` is spawned
   detached, so its pid is its session id. A tool shell keeps that session even after
   `claude` dies and it is reparented, so an orphan can be found without any marker.
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

A run stopped while it waits gets an "outcome unknown" result for each open call, so the
thread's next run resumes a well-formed transcript.

`HOMERUN_DEV_AMBIGUITY_MODE=truncate` (development only) applies the design's fallback
instead. The resume starts with `resumeSessionAt` at the entry before the assistant message
that made the first answered call, and the note says what happened to each call it hides.
The point is stored in `runs.resume_at` (migration 0002) until `claude` writes the new
branch, so a crash in between truncates again. Known limit: messages the model had already
received after that point are not re-sent.

A note not yet delivered when the runtime is killed again is merged into the next one, never
replaced. The note is delivered with a fresh id each launch, so a crash in the middle of
delivering it can show the model the same note twice.

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
pnpm --filter @homerun/homerund test:crash    # kill at every event boundary, simulated claude (about a minute)
scripts/check-no-secrets.sh                   # from the repo root
```

CI runs all of these on Linux (`ubuntu-latest`; `.github/workflows/ci.yml`, job `homerund`). The code is POSIX-only (process groups, `ps`, unix sockets) and is tested on macOS and Linux; liveness checks ignore zombies, which `kill(pid, 0)` still reports as alive.

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
- isolation.

Four milestone 4 scenarios are written but wait for their cassettes. Replay skips a scenario
whose cassette is missing:
- `ambiguity-completed`: the user answers "completed". The run resumes with the injected
  result and a held message, and the call is not run again.
- `kill-claude-mid-tool`: `claude` alone is killed, and its orphaned shell with it. The user
  answers "not run", and the call runs again exactly once.
- `ambiguity-truncate`: the truncate fallback.
- `cancel-parked`: a parked run is stopped, and the thread's next turn resumes cleanly.

Every scenario also checks generic invariants:
- every `tool.call` of a finished run has exactly one `tool.result`;
- no stored deltas;
- event sequence order, and nothing after `run.end`;
- no finished run still holds a process group.

### Crash harness (§16.2)

`test/crash/` kills homerund at every event boundary, systematically. Real `claude` would
need a cassette per boundary, so this harness uses `sim-claude.ts` instead. It is an engine
that behaves like `claude` where recovery depends on it:
- it mirrors transcript entries through the session store, sometimes lagging a step;
- its hooks write `tool.call` and `tool.result`;
- it resumes from the stored chain (and `resumeSessionAt`);
- when it resumes a `tool_use` with no result, it writes its own "interrupted" result and
  runs the call again, as F7 found real `claude` does.

Its tools append to a ledger file, which is the ground truth for "did this happen?".

A boundary is any commit homerund makes (`Store.commitObserver`), or the point just before or
just after a tool's side effect. For each scenario (serial calls; parallel destructive calls in
one message; the same in truncate mode), the harness does the following. Each life is a
child process (`child.ts`).
1. It counts the boundaries of a clean run.
2. For each boundary k, it SIGKILLs homerund at k. A second life recovers, answers "Did this
   happen?" truthfully from the ledger, and finishes the run.
3. For each k, it kills `claude` alone at k.
4. For each first crash that left an ambiguous call, it crashes again at every boundary of
   the recovery life. `HOMERUN_CRASH_FULL=1` does this after every first crash.

After each trial it checks invariants:
- every side effect happened exactly once;
- every call has one result;
- every request was resolved once, and none is pending;
- no input is left undelivered, and the user's message is in the transcript once;
- every run is terminal with one `run.end`, and the last one succeeded;
- the final transcript has no open `tool_use` and no "interrupted" result, and it agrees
  with the ledger about which calls ran.

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
