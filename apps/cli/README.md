# homerun (CLI)

`homerun` drives the local runtime (`homerund`) from a terminal: chat, send, watch
threads, list and stop runs, manage tasks, schedules and monitors, and read the
monitors' health digest. It talks JSON-RPC over the runtime's
unix socket (design §5.2), and every result and event it gets is checked against
the `@homerun/core` schemas.

Milestone 3: it authenticates with homerund's **development token**, so it only
works in development builds (see [Builds](#builds-and-access)).

## Running

```sh
pnpm install
pnpm --filter @homerun/homerund dev        # homerund plus the dev shell, which sets the API key
pnpm homerun status                        # from the repo root, in another terminal
pnpm homerun send --new "What's in this directory?"
pnpm homerun chat
```

- `pnpm homerun …` runs `bun apps/cli/src/main.ts …` from the repo root, so any
  relative path you give it (`tasks create --spec`, `blob -o`) is resolved from there.
- `bun run build` in `apps/cli` produces `dist/homerun` (release). `bun run build:dev`
  produces `dist/homerun-dev` (development).

## Commands

| Command | |
|---------|--|
| `status` | Whether homerund is reachable; its version, the role, active runs, pending input |
| `chat [THREAD] [--title T]` | Interactive chat, in a new thread or continuing THREAD |
| `send THREAD\|--new [--title T] [TEXT\|-] [--detach] [--stop-on-interrupt]` | Send a message and stream the run. If the thread already has an active run, the message steers it |
| `watch THREAD [--history N]` | The last N events (default 10), then follow live until Ctrl-C |
| `threads list [-n N] [--task TASK]`, `threads new [--title T]`, `threads show THREAD [-n N] [--before SEQ]` | Threads and their history (`show`: the last 50 events by default) |
| `runs list [--thread T] [--task TASK] [--state S,…\|active] [-n N]`, `runs show RUN` | Runs. `show` adds a scheduled run's slot and attempt, and a monitor check's result and evidence |
| `stop RUN\|THREAD` | Stop a run, or the active run on a thread |
| `tasks list [--kind session\|monitor] [--archived]`, `tasks show TASK`, `tasks create --spec FILE\|-` | Tasks. A spec is checked with core's `upgradeSpec` before it is sent, so errors name the field |
| `tasks update TASK --spec FILE\|- [--expected-version N]`, `tasks archive TASK` | Edit or archive a task. `update` fails (exit 1) if the task changed since version N, by default the version it just read. Archiving pauses its schedule |
| `tasks run-now TASK` | Run a monitor now, outside its schedule, and print the run's id (or its active run's). Refused (exit 1) at its monthly cap or once archived |
| `schedules list [--task TASK]` | Schedules: on or paused (by hand, after 3 failed fires, at the monthly cap, archived), the next fire, fires missed since the last run |
| `schedules enable\|disable SCHEDULE\|TASK` | Resume or pause a schedule. Takes the schedule's id or its task's |
| `schedules coverage TASK [--days N]` | Per day in the schedule's timezone: fires due, run on time, missed asleep, missed while Homerun was not running, merged (§8.4) |
| `monitors [list]` | Monitors, their schedule, and their last run's outcome |
| `monitors state TASK`, `monitors set-state TASK --state FILE\|- [--expected-version N]`, `monitors reset-state TASK` | A monitor's state (§8.3), edited by hand. An edit bumps the version, and a check already running then discards its result. `reset-state` clears it, so the next check records a new baseline |
| `health [digest] [--days N]` | The health digest over the last N days (default 1): per monitor, runs, changes, failures, misses by cause, fires caught up late, cost; then when the Mac slept or Homerun was not running |
| `health settings [--on\|--off] [--time HH:MM] [--timezone ZONE]` | When the daily digest is made. Without options, shows it |
| `input list [--thread T]` | Unanswered input requests, and where each can be answered |
| `answer REQUEST --completed\|--not-run` | Answer "Did this happen?" for a call a crash interrupted (development builds: `cli_dev`). Exit 0 when applied; 1 when it was already answered, with who answered |
| `blob SHA256 [-o FILE]` | A stored tool input or output (over 4 KB), to stdout or a 0600 file |
| `version`, `help [COMMAND]` | |

IDs print as 8-character prefixes. Any id argument takes the full id or a unique
prefix of at least 4 characters. Run `homerun help COMMAND` for all options.

`answer` (milestone 4) answers only "Did this happen?": after a crash, a
destructive call that may or may not have run parks its run until the user says
whether it happened (homerund's README, "Crash resume"). The run then resumes with
the answer as the call's result. If the run is stopped instead, messages sent while
it waited were never delivered: `threads show` and `watch` mark each one
"not delivered" and print a `homerun send` command that resends it. Nothing
resends them on its own. Answering approvals and questions arrives with
milestone 6: until then a run that stops for them makes `send` exit 75, and
`input list` shows where each request can be answered.

Milestone 5 adds tasks, schedules, monitors and health. Missed and abandoned fires
have no push notification until milestone 9: `schedules list` counts them, the
monitor's thread records each group (`threads show`), and `health` sums them.
Commands that change a task, a schedule or a monitor's state are refused to the
web client by the runtime (§9.9); the CLI is never a web caller.

Not yet: grants, which the runtime doesn't implement.

## Builds and access

The build channel fails closed, like homerund's:
- Running from source is **development**.
- A compiled binary is **release** unless it was built with exactly
  `--define HOMERUN_CLI_BUILD='"development"'`.

A **development** build connects as `cli_dev`. That role may approve and may
answer "Did this happen?", but only development runtimes accept it. `answer` is
its only command that answers anything so far.

Development-only switches:

| Switch | Effect |
|--------|--------|
| `--socket PATH` / `HOMERUN_SOCKET` | Use this socket instead of the data dir's |
| `--dev-token-file PATH` | Read the development token from here |

A **release** build:
- Refuses the switches above with exit 64 and
  `<switch> is only available in development builds; this is a release build`,
  before anything else.
- Runs `version` and `help`.
- Exits 77 for every command that needs the runtime, without opening the socket or
  the dev token. A release CLI needs a `cli_token` approved in the Homerun app,
  which arrives with the desktop app (§5.2). Even then it will only answer
  questions: never approvals, and never "Did this happen?", which needs full
  authority (`INPUT_ANSWER_RIGHTS.cli`).

## Tests

```sh
pnpm --filter @homerun/cli typecheck
pnpm --filter @homerun/cli test:unit     # arguments, ids, rendering, the release refusals
pnpm --filter @homerun/cli test:e2e      # the CLI spawned against homerund with the fake engine; both builds compiled
pnpm --filter @homerun/cli test:replay   # the CLI driving real claude against recorded cassettes, no key
```

None of them need an API key. The e2e tests start homerund in-process on a temporary
data dir, play the shell to set a mock key, and spawn the CLI from source.
`test/e2e/build-gate.test.ts` compiles the CLI both ways and checks the rules above.
