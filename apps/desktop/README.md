# Homerun desktop app

The macOS app (docs/design.md §4, §5.1): a Tauri v2 shell that spawns and supervises `homerund`
and a React UI in its webview. Milestone 7 covers:

- chat with streaming, steering and stop;
- history and the thread list;
- approvals, questions and *Did this happen?*;
- tasks, schedules and monitors, with their health and coverage;
- per-task grants and settings.

Menu-bar residency, the login item, the signed updater and quit confirmation are milestone 8.

```
Homerun.app
├── homerun (shell, Rust)   src-tauri/: supervisor, keychain, sleep and wake, webview commands
│   └── webview (React)     src/: views over @homerun/app-state, no socket access
└── homerund (runtime)      apps/homerund, compiled with Bun; bundled claude next to it
```

## Running

```sh
pnpm install
pnpm --filter @homerun/desktop tauri dev
```

`tauri dev` stages the sidecars (`scripts/stage-sidecars.ts`), then starts Bun's dev server with
hot reload on port 5178. The sidecars are a development-channel `homerund` compiled from source
and `claude` from the Agent SDK's platform package, so nothing is downloaded. Rust 1.94 is needed
(`rustup toolchain install 1.94.0`).

Debug builds keep the API key in memory, seeded from `ANTHROPIC_API_KEY` if set, because every
rebuild is a new code identity and the keychain would ask again each time. Useful variables:

| Variable | |
|---|---|
| `HOMERUN_DATA_DIR` | Data folder, instead of `~/Library/Application Support/Homerun` |
| `HOMERUN_KEYSTORE=keychain` | Debug builds: use the real keychain |
| `HOMERUN_RUNTIME` | Debug builds: run this `homerund` instead of the bundled one |

**A local `.app`.** `scripts/macos/package.sh` stages a release-channel `homerund` and `claude`
(`scripts/macos/fetch-toolchain.sh`), builds the app, and signs it inside out. By default it
signs ad hoc (`IDENTITY=-`, see `scripts/macos/sign.sh`), then makes a DMG in
`dist/macos/<version>/`. It has been tried on Apple silicon only. Notarized distribution is milestone 11 (§11).

## Layout

**The shell** (`src-tauri/`).

- `shell-core/` is a plain Rust crate with no Tauri, AppKit or keychain code, so its tests run on
  Linux (§5.1, §5.2):
  - `policy.rs`: the supervisor's restart policy as a pure state machine with a fake clock.
    - Backoff of 1–30 s.
    - A crash loop (five exits in three minutes) stops fast restarts and retries every ten
      minutes.
    - A hang is three missed pings; a wake resets the count.
    - Exits that retrying can't fix wait for the user.
    - Stop is staged: stdin closed, then TERM, then KILL.
  - `runtime.rs`: runs that policy with a real child.
    - The launch token goes on stdin, and stderr goes to a rotating `logs/homerund.log`.
    - The shell connects twice, as `shell` and as `webview`.
  - `allowlist.rs`: the webview allowlist, compiled from `packages/core/schema/callers.json`.
    Anything else is refused before it reaches the socket.
  - `keys.rs`: the API-key flow (§7.2). A key is checked with `secrets.verify`, stored, then
    handed over with `secrets.set`.
  - `tests/supervisor.rs` drives all of it against `fake_homerund`: spawn, forward, crash and
    backoff, crash loop, blocking exits, hang, stop.
- `src/`: the Tauri app.
  - `commands.rs` is the whole webview surface, and `capabilities/default.json` grants exactly
    those commands, with no `core:default`.
  - `keychain.rs`: the data-protection keychain, with the legacy keychain as a fallback for
    builds without a profile (§11).
  - `power.rs`: sleep and wake, reported on the shell connection (§8.4).
  - `main.rs`: single instance and window lifecycle. Closing the window keeps the runtime; the
    Dock icon reopens it; quitting stops the runtime cleanly.

**The UI** (`src/`) is React DOM over `@homerun/app-state`, which holds all client logic (§9.8).

- `platform/` is the only code that knows about Tauri. `tauri.ts` uses `invoke` and a `Channel`.
  `bridge.ts` is a WebSocket twin used by the end-to-end test.
- `screens/`: onboarding, the thread and its composer, input cards, the inbox, tasks and the task
  editor, monitors (on the task page), health, and settings.
- `ui/Markdown.tsx` renders app-state's markdown tree. It never renders HTML, and images are
  shown as links (§13).

## Tests

```sh
pnpm --filter @homerun/desktop typecheck
pnpm --filter @homerun/desktop test        # component tests
pnpm --filter @homerun/desktop test:e2e    # end to end
cd src-tauri && cargo test -p homerun-shell-core
```

- **Component tests** (`test/components/`). Bun test with happy-dom and Testing Library, driving
  the real `AppClient` over app-state's `FakeTransport`. They cover:
  - onboarding and key changes;
  - streaming, steering, stop, held and not-delivered messages;
  - approvals, including an edited Always allow;
  - questions and *Did this happen?*;
  - the task editor, monitors and grants;
  - runtime banners.
- **End to end** (`test/e2e/`). Playwright drives the production views in Chrome through
  `bridge-server.ts`, a Bun stand-in for the Rust shell. It does the shell and webview hellos
  with the launch token, forwards only the `webview` allowlist, and verifies and hands over the
  key. It runs against a real `homerund` in two modes:
  - The fake engine (`fake-script.ts`) covers onboarding, a steered and stopped stream, a task
    made in the editor, an edited Always allow and its revocation, a question, a message left
    undelivered, and a monitor with pause, resume and a reply.
  - Replay runs homerund's cassettes with the real bundled `claude`: no key, no network and no
    spend.
  - `HOMERUN_E2E_CHANNEL=chrome` uses an installed Chrome instead of Playwright's Chromium, which
    is what CI does.
- **Real-key check** (`test/e2e/live.manual.ts`, never in CI). The same views and bridge against
  the real API, with the key from `.env.local` typed into onboarding:
  ```sh
  HOMERUN_E2E_CHANNEL=chrome HOMERUN_E2E_SHOTS=/tmp/hr-live pnpm --filter @homerun/desktop test:live
  ```
  It covers:
  - a wrong key refused by the real API, then the real one accepted;
  - a chat streaming on Haiku;
  - Allow once, then Always allow with an edited pattern, and revoking the grant;
  - an AskUserQuestion card;
  - `kill -9` of `homerund` mid-stream. The bridge restarts it after 1 s, the supervisor's first
    backoff step, and the thread must match a fresh load from history.

  The bridge meters the API traffic. It refuses requests past `HOMERUN_E2E_LIVE_CAP_USD` (default
  $0.10), and `HOMERUN_E2E_LIVE_LEDGER` appends each run's spend to a file. One run costs about
  $0.04. Traces and videos are off, because they would record the key.
- **CI.** The `desktop`, `desktop-e2e` and `shell` jobs run on every pull request. The Tauri crate
  and an unsigned `.app` build nightly on macOS.

**Checked by hand on macOS** before a release. The end-to-end test runs in Chrome against the
stand-in, so it can't cover these:

1. `pnpm tauri dev` opens the window, and onboarding appears with no key.
2. A key is verified and saved; Settings shows it with its last four characters.
3. After a restart, the key is read from the keychain without a prompt (release build).
4. A chat streams, steers and stops. An approval and a question can be answered.
5. Close the window: runs continue. Click the Dock icon: the window returns.
6. `kill -9` the `homerund` process: the banner shows it restarting, and the thread resumes.
7. Sleep the Mac for a few minutes with a monitor on. After wake, its coverage shows the sleep
   (§8.4).
8. Quit: `homerund` exits within a few seconds, and no `claude` is left running.
