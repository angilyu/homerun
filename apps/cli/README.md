# homerun (CLI)

`homerun` drives the local runtime (`homerund`) from a terminal: chat, send, watch
threads, list and stop runs, create tasks. It talks JSON-RPC over the runtime's
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
| `runs list [--thread T] [--task TASK] [--state S,…\|active] [-n N]`, `runs show RUN` | Runs |
| `stop RUN\|THREAD` | Stop a run, or the active run on a thread |
| `tasks list [--kind session\|monitor] [--archived]`, `tasks show TASK`, `tasks create --spec FILE\|-` | Tasks. A spec is checked with core's `upgradeSpec` before it is sent, so errors name the field |
| `input list [--thread T]` | Unanswered input requests, and where each can be answered |
| `blob SHA256 [-o FILE]` | A stored tool input or output (over 4 KB), to stdout or a 0600 file |
| `version`, `help [COMMAND]` | |

IDs print as 8-character prefixes. Any id argument takes the full id or a unique
prefix of at least 4 characters. Run `homerun help COMMAND` for all options.

Not in milestone 3:
- `answer`: the runtime can't apply answers yet (milestones 4 and 6). A run that
  stops for input makes `send` exit 75, and `input list` shows where it can be
  answered.
- Scheduling, grants and task updates, which the runtime doesn't implement yet.

## Output

- **Human** (default):
  - For `send` and `chat`, the assistant's text alone goes to stdout, so
    `homerun send … > answer.txt` captures just the answer. Tool calls, results,
    notes and the final `— done · $cost` line go to stderr.
  - For `threads show` and `watch`, the transcript goes to stdout, with `you›` and
    `claude›` labels.
  - Text streams from `message.delta`. The final message adds only the part not
    already printed.
  - A tool result shows at most 3 lines. A large one names its blob:
    `homerun blob <sha>`.
  - Colour only on a terminal; `NO_COLOR=1`, `--no-color` or `TERM=dumb` turn it off.
- **`--json`**:
  - Request/response commands print the method's result, verbatim, as one JSON
    document. `status --json` combines `hello`, `ping`, active runs and pending input.
  - Streaming commands (`send`, `watch`) print NDJSON: each `ThreadEvent` exactly
    as the runtime sent it, and nothing else. The exit code carries the outcome.
  - `chat` has no JSON mode.

## Interrupts

- `send`, `watch`: Ctrl-C **detaches** and exits 130. The run keeps going, and the CLI
  prints how to stop it. `send --stop-on-interrupt` stops the run first.
- `chat`:
  - Ctrl-C during a run stops the run. At the prompt, Ctrl-C or Ctrl-D exits.
  - On a terminal, a line typed during a run steers it.
  - From a pipe, each line is sent after the previous run ends, and chat exits at
    end of input. A run that stops for input ends it with 75, as `send` does.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | OK, or the run succeeded |
| 1 | Error, or the run failed, was cancelled or abandoned; an id that matches nothing |
| 64 | Usage error, an ambiguous id, or a development switch in a release build |
| 69 | homerund isn't running (or the connection closed) |
| 75 | The run is waiting for input, or the message is held until the run resumes |
| 77 | Not authorized: a bad or unreadable dev token, or a release build |
| 130 | Interrupted (detached) |

## Finding the runtime

The same resolution as homerund's, from `@homerun/client`:
- The data dir is `HOMERUN_DATA_DIR`, or `~/Library/Application Support/Homerun`.
- The socket is `<data dir>/run/homerund.sock`, or the `$TMPDIR/hr-<uid>/` fallback
  when that path is too long for a unix socket.
- The token is `dev-token` next to the socket. It is read fresh on every run (it
  rotates each time homerund starts), and refused unless it is owned by you and
  not readable by anyone else.

The CLI connects, then sends `hello` as role `cli_dev` with the token.

## Builds and access

The build channel fails closed, like homerund's:
- Running from source is **development**.
- A compiled binary is **release** unless it was built with exactly
  `--define HOMERUN_CLI_BUILD='"development"'`.

A **development** build connects as `cli_dev`. That role may approve, but only
development runtimes accept it, and no M3 command approves anything.

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
  questions, never approvals (`INPUT_ANSWER_RIGHTS.cli`).

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
