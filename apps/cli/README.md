# homerun (CLI)

`homerun` drives the local runtime (`homerund`) from a terminal: chat, send, watch
threads, list and stop runs, manage tasks, schedules and monitors, and read the
monitors' health digest. It talks JSON-RPC over the runtime's
unix socket (design §5.2), and every result and event it gets is checked against
the `@homerun/core` schemas.

A development build authenticates with homerund's **development token**. The release
CLI, which ships inside Homerun.app, asks the app for its own token the first time and
keeps it in the login keychain (milestone 8a; see [Builds and access](#builds-and-access)).

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
| `requests [--thread T] [--run R]` (also `input list`) | Unanswered approvals, questions and "Did this happen?", and where each can be answered |
| `approve REQUEST [--always [--pattern P] [--class C]]`, `deny REQUEST` | Allow or deny a tool call waiting for approval. `--always` also grants the suggested pattern (edited by `--pattern`/`--class`) to the task, where the runtime offers it. Development builds only |
| `answer REQUEST --choice [N=]LABEL… [--text [N=]TEXT…]` | Answer the agent's question (`AskUserQuestion`): an option by label (any case) or number; `N=` says which question when there are several. `--text` where the question takes free text |
| `answer REQUEST --completed\|--not-run` | Answer "Did this happen?" for a call a crash interrupted (development builds) |
| `grants list TASK [--all]`, `grants add TASK --tool T [--pattern P] --class C`, `grants revoke GRANT` | A task's grants (§5.6): what runs without asking. `add` is "Trust this tool" for an MCP tool, or a Bash or WebFetch pattern (development builds) |
| `blob SHA256 [-o FILE]` | A stored tool input or output (over 4 KB), to stdout or a 0600 file |
| `version`, `help [COMMAND]` | |

IDs print as 8-character prefixes. Any id argument takes the full id or a unique
prefix of at least 4 characters. Run `homerun help COMMAND` for all options.

### Approvals and questions (milestone 6)

A run stops for input when a call needs approval (a destructive command, a write
outside the roots, an untrusted MCP tool, a fetch from a tainted run: design §5.5),
when the agent asks a question (`AskUserQuestion`), or after a crash for "Did this
happen?" (§5.4). `send` then prints the request with the command that answers it and
exits 75; `requests` lists what is waiting. A message sent meanwhile is held and
delivered with the answer (§5.7).

- `approve`, `deny` and `answer` exit 0 when the answer was applied, and 1 when
  another device answered first (first answer wins): the message says who, and
  `--json` prints `{"status":"already_resolved",…}`. A request no longer pending
  only matches by its full id.
- On a terminal, `chat` answers inline: after a request it reads the next line as
  the answer when it is one (`y`, `n`, `always`; an option's number or label;
  `completed`, `not run`), and otherwise sends it as a message.
- A run waiting a long time holds no process: homerund lets `claude` exit and
  resumes it when the answer comes (§5.6 `defer`), so an approval can wait overnight.
- Stopped instead of answered, messages held while it waited were never delivered:
  `threads show` and `watch` mark each one "not delivered" and print a `homerun send`
  command that resends it. Nothing resends them on its own.
- There is no `deny --reason` yet: the response schema has no reason field.

Milestone 5 adds tasks, schedules, monitors and health. Missed and abandoned fires
have no push notification until milestone 9: `schedules list` counts them, the
monitor's thread records each group (`threads show`), and `health` sums them.
Commands that change a task, a schedule or a monitor's state are refused to the
web client by the runtime (§9.9); the CLI is never a web caller.


## Builds and access

The build channel fails closed, like homerund's:
- Running from source is **development**.
- A compiled binary is **release** unless it was built with exactly
  `--define HOMERUN_CLI_BUILD='"development"'`.

A **development** build connects as `cli_dev`. That role may approve, grant and
answer "Did this happen?", but only development runtimes accept it.

Development-only switches:

| Switch | Effect |
|--------|--------|
| `--socket PATH` / `HOMERUN_SOCKET` | Use this socket instead of the data dir's |
| `--dev-token-file PATH` | Read the development token from here |
| `--dev-role cli` | Use the release role and token flow below instead of the development token |
| `--dev-token-store PATH` / `HOMERUN_DEV_TOKEN_STORE` | With `--dev-role cli`: keep the token in a 0600 file, not the keychain |
| `--dev-keychain PATH` | With `--dev-role cli`: use this keychain file instead of the login keychain |
| `--dev-peer-requirement REQ` | With `--dev-role cli`: the code requirement homerund must satisfy |
| `--dev-skip-peer-check` / `HOMERUN_DEV_SKIP_PEER_CHECK=1` | With `--dev-role cli`: don't check who is listening, with a warning on every run |

The last four without `--dev-role cli` are a usage error (64). A development build has no
compiled-in requirement, so `--dev-role cli` fails the peer check unless it is given one or
told to skip it: the escape hatch is explicit, and loud.

A **release** build connects as `cli`:
- It refuses every switch above with exit 64 and
  `<switch> is only available in development builds; this is a release build`,
  before anything else. It is compiled with `--no-compile-autoload-bunfig` and
  `--no-compile-autoload-dotenv`, so a `bunfig.toml` or `.env` in the working directory
  can't add a preload or set these switches.
- It answers questions only (§5.2). `approve`, `deny`, `grants add` and
  `answer --completed|--not-run` exit 77 before connecting; homerund refuses them from
  `cli` too, and refuses a `tasks create` or `tasks update` whose policy would need the app.
- Before it sends anything, it checks who is listening on the socket: the same user
  (`getpeereid`), and a process whose code signature satisfies the requirement compiled
  in by `scripts/macos/package.sh` (`LOCAL_PEERPID`, `LOCAL_PEERTOKEN`, then
  `SecCodeCopyGuestWithAttributes` and `SecCodeCheckValidity`). If it can't tell, it
  refuses (77): the check fails closed, including a build with no requirement.
- On Windows (milestone 8b) it connects to the named pipe `run\endpoint` names, after
  opening the pipe once to check it: an ACL that admits only this user, the server's
  pid (`GetNamedPipeServerProcessId`) and user, and its image against the requirement,
  `sha256:<hex of homerund.exe>` or `authenticode:<signer>` (§18 row 61). A release
  Windows CLI ships with milestone 11's installer.
- Its token is a generic password in the login keychain: service
  `com.angilyu.homerun.cli`, labelled "Homerun command-line tool", account `default`
  (or `data:<sha256 of the data dir>` under `HOMERUN_DATA_DIR`). homerund keeps only its
  sha256. On Windows it is a Credential Manager credential,
  `com.angilyu.homerun.cli/<account>`, kept on this machine, which any process of the
  user can read (§18 row 62).

### Getting a token

`homerun login`, or the first command that needs the runtime in a terminal, asks the
app. Homerun asks "Allow the Homerun CLI to control your agents?", naming the CLI's version
and host, with Don't Allow as the default. Until someone answers, the CLI waits
(a spinner on a terminal, one line otherwise; Ctrl-C withdraws the request).
The request expires after 2 minutes. Revoke a token in Settings → Command-line access,
which also closes its connections; `homerun logout` revokes this CLI's token and
deletes the keychain item. Without a terminal, a command with no token exits 77 and
says to run `homerun login`.

Exit codes for access:

| Code | When |
|------|------|
| 0 | Approved, or signed out |
| 64 | A development switch in a release build, or a `--dev-role cli` switch without it |
| 69 | Homerun is not running, closed the connection, or has three requests waiting already |
| 77 | Not approved yet, denied, no answer in 2 minutes, the token was revoked, the peer check failed, the keychain is locked or refused, or a command the release CLI can't run |
| 130 | Ctrl-C while waiting |

## Tests

```sh
pnpm --filter @homerun/cli typecheck
pnpm --filter @homerun/cli test:unit     # arguments, ids, rendering, the release refusals
pnpm --filter @homerun/cli test:e2e      # the CLI spawned against homerund with the fake engine; both builds compiled
pnpm --filter @homerun/cli test:replay   # the CLI driving real claude against recorded cassettes, no key
pnpm --filter @homerun/cli test:macos    # macOS: the real keychain and peer-check calls (nightly)
```

On Windows, CI runs `test:unit`, which there includes the peer check against a real pipe
(one served by the test itself, one with the default ACL, and a name nobody serves) and
the Credential Manager errors. The end-to-end and replay suites run on Linux and macOS
(§17 item 8).

None of them need an API key. The e2e tests start homerund in-process on a temporary
data dir, play the shell to set a mock key, and spawn the CLI from source.
`test/e2e/build-gate.test.ts` compiles the CLI both ways and checks the rules above.
`test/e2e/access.test.ts` drives login, deny, expiry, Ctrl-C, revocation and logout with an
file token store and no peer check (the peer check's logic is unit tested with a fake inspector).
`test/macos/ffi.test.ts` makes the real Security.framework calls against a throwaway keychain
file, never the login keychain. `test/macos/bundled.test.ts` runs only with
`HOMERUN_TEST_APP=path/to/Homerun.app`, as `scripts/macos/cli-test.sh` sets it: the bundled
release CLI against the bundled `homerund`. The checks that need the login keychain or a person
are in [apps/desktop/README.md](../desktop/README.md).
