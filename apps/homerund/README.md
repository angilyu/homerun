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
| `src/runs/` | Run lifecycle (§5.7): `manager` (one active run per thread, steering), `scheduler` (3 sessions + 2 monitors), `driver` (one run), `recovery` (§5.4), `process-groups` |
| `src/rpc/` | Unix-socket JSON-RPC server, `hello` and auth, handlers. The client, the data dir and socket paths and the build channel rule live in [`@homerun/client`](../../packages/client) |
| `test/unit/` | Fast tests against the fake engine |
| `test/replay/` | Record/replay harness (§16.2) and the committed cassettes |
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
| `--dev-auto-approve` / `HOMERUN_DEV_AUTO_APPROVE=1` | Approve `needs_approval` tools. Input requests are milestone 4 |
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
  no tool process survives;
- stop during a tool call;
- isolation.

Every scenario also checks generic invariants:
- every `tool.call` of a finished run has exactly one `tool.result`;
- no stored deltas;
- event sequence order, and nothing after `run.end`;
- no finished run still holds a process group.

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
