# Homerun desktop app

The macOS app (docs/design.md §4, §5.1): a Tauri v2 shell that spawns and supervises `homerund`
and a React UI in its webview. Milestone 7 covers:

- chat with streaming, steering and stop;
- history and the thread list;
- approvals, questions and *Did this happen?*;
- tasks, schedules and monitors, with their health and coverage;
- per-task grants and settings.

Milestone 8 keeps it running in the background (§5.1, §11):

- a menu-bar item, with no Dock icon while no window is open;
- the login item;
- quit confirmation;
- local notifications;
- the signed updater.

Command-line access approval is §16 row 8a.

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

Run the CLI through pnpm (`pnpm tauri …` or `pnpm exec tauri …`), not `node_modules/.bin/tauri`.
The `tauri` crate is 2.12.0, but `@tauri-apps/api` is 2.11.1, the newest 2.x on npm. Called
directly, `tauri build` fails its version-mismatch check. Pin the api to 2.12.x once npm has it.

Debug builds keep the API key in memory, seeded from `ANTHROPIC_API_KEY` if set, because every
rebuild is a new code identity and the keychain would ask again each time. Useful variables:

| Variable | |
|---|---|
| `HOMERUN_DATA_DIR` | Data folder, instead of `~/Library/Application Support/Homerun` |
| `HOMERUN_KEYSTORE=keychain` | Debug builds: use the real keychain |
| `HOMERUN_RUNTIME` | Debug builds: run this `homerund` instead of the bundled one |

Update-test builds (`UPDATER_ENDPOINT`, see "Releasing an update") also honour a few `HOMERUN_TEST_*`
switches, which `scripts/macos/update-test.sh` sets. A release build ignores them: the
test flag is compiled into the bundle's config, not read from the environment.

**A local `.app`.** `scripts/macos/package.sh` stages a release-channel `homerund` and `claude`
(`scripts/macos/fetch-toolchain.sh`), compiles the release CLI (below), builds the app, and signs
it inside out. By default it
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
  - Milestone 8's decisions, each unit tested:
    - `summary.rs` and `tray.rs`: the menu model, and Pause All and Resume;
    - `quit.rs`: whether quitting asks, and what it says;
    - `login.rs`: the login item's status;
    - `notify.rs`: notification posting, withdrawal and dedupe;
    - `update.rs`: the check schedule, the version gate and install on quit;
    - `prefs.rs`: the shell's own settings.
  - Milestone 8a's (§5.2):
    - `cli_access.rs`: the access prompt's text (client, version and hostname are sanitised and
      shortened) and the queue that shows one prompt at a time;
    - `cli_tool.rs`: the `~/.local/bin/homerun` link, its status, install and remove.
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
  - `tray.rs`, `lifecycle.rs`, `login_item.rs`, `notifications.rs`, `updater.rs`, `macos.rs`:
    milestone 8's AppKit wiring, described below.
  - `cli_prompts.rs`: the command-line access prompt (milestone 8a), described below.

**The UI** (`src/`) is React DOM over `@homerun/app-state`, which holds all client logic (§9.8).

- `platform/` is the only code that knows about Tauri. `tauri.ts` uses `invoke` and a `Channel`.
  `bridge.ts` is a WebSocket twin used by the end-to-end test.
- `screens/`: onboarding, the thread and its composer, input cards, the inbox, tasks and the task
  editor, monitors (on the task page), health, and settings.
- `ui/Markdown.tsx` renders app-state's markdown tree. It never renders HTML, and images are
  shown as links (§13).

## In the background (milestone 8)

**Menu bar and Dock** (§5.1). The menu-bar item's count is the approvals and questions waiting
for you, hidden at zero. Its menu:

- the runtime status, with *Restart Runtime* in a crash loop;
- *Waiting for You* and *Running* submenus, each row opening its thread;
- *Open Homerun*;
- *Pause All Monitors*. *Resume Monitors* re-enables only those it paused;
- the update item;
- *Quit Homerun*.

The Dock icon shows only while a window is open. A launch from Finder or Spotlight, or a second
launch, reopens the window.

**Quit** (§5.1). ⌘Q, Dock → Quit, menu-bar Quit and AppleScript `quit` all pass through one
`applicationShouldTerminate:` hook. Tao doesn't implement that method, so `macos.rs` adds it
with `class_addMethod`, only if it is absent. Homerun asks first while a run is active or input
is pending. The native alert says:

- that runs continue on the next launch;
- that monitors won't run while Homerun is quit.

Logout, restart and shutdown never ask and never wait for an update install. An AppleScript
`quit` returns "User canceled (-128)" to the script, because the hook cancels the system's quit
and quits by itself once the runtime has stopped; the app still quits.

**Login item** (§11). `SMAppService.mainApp`, registered from onboarding's last step, *Keep
Homerun running* (pre-checked), or from Settings → *Running in the background*. Settings reads
the live status, so turning it off in System Settings → Login Items shows as *Turned off in
System Settings*, with a button to that pane. A login launch is detected from the launch Apple
event and starts in the menu bar with no window, unless onboarding isn't finished.

**Notifications** (§8.2, §9.7). `homerund` composes them from fixed templates. They never carry
tool input or anything the runtime holds as a secret. The runtime sends them to the shell
connection only, after the event is committed, at most once per key. The shell posts them with
`UNUserNotificationCenter`.

Clicking one opens its thread, or Health. There are no action buttons, so no approval is ever
answered from a notification. Nothing is shown while Homerun's window is in front. The kinds:

- approvals, questions and *Did this happen?*, withdrawn once answered anywhere;
- a monitor that reported a change;
- a monitor whose check failed or that was paused;
- missed checks after sleep;
- the daily digest;
- from the shell itself: a runtime crash loop, or a runtime that can't start.

An unsigned `tauri dev` build can't post: macOS refuses, and the shell logs it.

**Updates** (§11, §14). `tauri-plugin-updater` with native TLS only. The shell checks 60 s after
launch and every 6 hours after that; *Check for Updates…* checks at once. It downloads in the
background (Settings can turn that off), verifies the payload, and keeps it in
`<data dir>/updates/`. It then offers *Restart to Update* in the menu and a banner in the window.

*Restart now* confirms like Quit when runs are active. Otherwise the update installs on the next
quit, never on logout. Before installing, the shell checks the minisign signature again against
the key compiled into it. Runs in progress resume after the restart (§5.4), and the keychain
doesn't ask again, because the code identity is the same.

A build without a real public key carries a placeholder and never updates (fail closed). Only
newer versions install, and the manifest's `homerun` extension can hold two gates:

- `min_update_from` sends older installs to the download page;
- `protocol.min` above the running protocol adds a note that older command-line tools need
  updating.

## Command-line access (milestone 8a)

The `homerun` command-line tool is signed in from the app (§5.2). `homerun login` asks the
runtime for access with `cli.request_access`; the runtime tells the shell connection
(`cli.access_requested`), and `cli_prompts.rs` shows a native alert:

- *Allow the Homerun CLI to control your agents?*, naming the client, its version and the Mac's
  hostname;
- **Don't Allow** is the default button (Return), and **Allow** needs a click;
- one prompt at a time; others wait in order;
- the alert closes by itself when the request expires (2 minutes), when the CLI gives up
  (`cli.access_withdrawn`), or when the runtime goes away. None of these approves.

The answer goes back on the shell connection as `cli.approve` or `cli.deny`; the webview can't
call either. Settings → *Command-line access* lists the approved tools with their hostname and
when each was last used; **Revoke** signs one out and closes anything it has open.

**Install command-line tool** (Settings). The release CLI lives inside the app, at
`Homerun.app/Contents/MacOS/homerun-cli`. Installing makes the symlink
`~/.local/bin/homerun` to it, with no admin rights. The shell:

- offers nothing in a development build, or while the app runs from a disk image or App
  Translocation (move it to Applications first);
- repoints a link to another copy of Homerun, or to one that has been moved or deleted;
- never touches a file or link at that path that isn't Homerun's;
- replaces its own link atomically.

If `~/.local/bin` isn't on your `PATH`, Settings shows the line to add to `~/.zshrc`.

**How the CLI is built and signed.** `package.sh` asks `sign.sh --runtime-requirement` for the
designated requirement `homerund` will have once signed: a throwaway copy is signed exactly as
step 3 signs it. Ad hoc that is a `cdhash`; with Developer ID it is the team's requirement for
`com.angilyu.homerun.homerund`. It compiles `apps/cli` with that requirement and the app's
version compiled in, with no `bunfig.toml` or `.env` autoload, and adds it to `externalBin` for
this build only (`tauri dev` doesn't have it). `sign.sh` step 3b then signs it hardened as
`com.angilyu.homerun.cli`, with `allow-jit` only (`entitlements/cli.plist`). After signing,
`package.sh` checks the bundled `homerund` against the same requirement (the CLI's own peer check)
and fails the build if it doesn't pass. The CLI adds about 62 MB to the app (25 MB compressed),
since it is a second Bun executable.

`scripts/macos/cli-test.sh [Homerun.app]` (nightly) packages an ad-hoc app if none is given, then
runs `apps/cli`'s macOS tests against it:
- its signature and entitlements;
- every development switch refused;
- approvals refused (questions only);
- the peer check passing for the bundled `homerund` and failing for any other listener before a
  byte is sent;
- the keychain calls, against a throwaway keychain.

## Releasing an update

The manifest and payload are hosted on GitHub Releases:
`https://github.com/angilyu/homerun/releases/latest/download/latest.json`.

**The signing key.** It is made once, outside the repo, with a passphrase:

```sh
mkdir -p ~/.homerun-release && chmod 700 ~/.homerun-release
pnpm --dir apps/desktop exec tauri signer generate -w ~/.homerun-release/updater.key
security add-generic-password -s homerun-updater-key -a passphrase -w   # prompts for it
```

- Keep a copy of the key and passphrase in your password manager.
- Put the public half (`updater.key.pub`) in `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey`, replacing the placeholder.
- The private key never goes in the repo, CI logs or chat. `scripts/check-no-secrets.sh` flags
  minisign secret keys and `*.key` files. CI signing is milestone 11.

**A release.**

```sh
UPDATER_KEY=~/.homerun-release/updater.key VERSION=0.9.0 \
  IDENTITY="Developer ID Application: …" TEAM_ID=… PROVISIONING_PROFILE=… \
  NOTARY_PROFILE=homerun-notary scripts/macos/package.sh
gh release create v0.9.0 dist/macos/0.9.0/{Homerun.dmg,Homerun.app.tar.gz,Homerun.app.tar.gz.sig,latest.json}
```

- `package.sh` signs the payload with `scripts/macos/updater-artifacts.sh`, which reads the
  passphrase from the keychain and refuses a key inside the repo.
- `MIN_UPDATE_FROM`, `PROTOCOL_MIN` and `NOTES` fill in `latest.json`.

**The update test.** `scripts/macos/update-test.sh [adhoc|devid]` builds 0.90.0 and 0.90.1 with
an ephemeral key, which is deleted afterwards. It serves the manifest on 127.0.0.1, runs the mock
API in place of the model, and checks:

1. *Restart now* mid-run:
   - the run waiting on a question is recovered by the new version and completes once answered;
   - the bundled `homerund` is the new one;
   - `codesign --verify` passes;
   - the API key is read back;
   - no keychain prompt (devid).
2. Install on an idle quit.
3. Keeping awake (§8.1):
   - a busy run holds `PreventUserIdleSystemSleep` through a `caffeinate` child of `homerund`;
   - the assertion goes when the run ends, and when `homerund` is killed.

It takes about 4 minutes, and the ad-hoc variant runs nightly. `devid` keeps its mock key under a separate keychain service,
`com.angilyu.homerun.update-test`, never the real item. That item holds only the mock key and
can stay; the `security` CLI can't see data-protection items, so remove it with Keychain Access
if you want.

## Dependencies added in milestone 8

Measured on aarch64-apple-darwin, normal edges:

- unique crates: 208 → 250 (+42), of which 26 are new to `Cargo.lock`;
- source of the new crates: 15.3 MB;
- stripped shell binary: 4.66 → 5.84 MB (+1.18 MB);
- `Homerun.app`: +1.7 MB.

No npm packages were added.

| Addition | Why | Brings |
|---|---|---|
| `tauri-plugin-updater` =2.13.0, `default-features = false, features = ["native-tls"]` | the signed updater | `reqwest` and hyper over Security.framework TLS, `tar`, `flate2`, `tempfile` (rustix), `minisign-verify`, `osakit` |
| `tauri` feature `tray-icon` | the menu-bar item | `tray-icon`, `objc2-core-graphics` |
| `objc2-service-management` 0.3 | `SMAppService`, as in the spike | tiny binding |
| `objc2-user-notifications` 0.3 | notifications with click routing. `tauri-plugin-notification` uses the deprecated `NSUserNotification` and can't route clicks on macOS | tiny binding |
| `objc2`, `block2`, `minisign-verify` (direct) | the quit hook, the notification delegate, re-verifying before install | already in the tree |

Unique crates by updater features:

| Features | Crates |
|---|---|
| native-tls (chosen) | 250 |
| + system-proxy | 252 |
| rustls | 255 |
| defaults | 257 |

`system-proxy` is left out. Updates therefore ignore a PAC or proxy set only in System Settings;
add the feature if that matters.

The largest new crate sources:

| Crate | Size | Pulled in by |
|---|---|---|
| rustix | 3.1 MB | tempfile |
| futures-util | 1.3 MB | |
| tower-http | 1.1 MB | |
| tokio-util | 0.9 MB | |
| hyper | 0.9 MB | |
| objc2-core-graphics | 0.9 MB | tray |
| reqwest | 0.8 MB | |

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
  - runtime banners;
  - command-line access: tokens with hostname and last use, Revoke, and each state of the
    command-line tool (`cli-access.test.tsx`).
- **End to end** (`test/e2e/`). Playwright drives the production views in Chrome through
  `bridge-server.ts`, a Bun stand-in for the Rust shell. It does the shell and webview hellos
  with the launch token, forwards only the `webview` allowlist, and verifies and hands over the
  key. It runs against a real `homerund` in two modes:
  - The fake engine (`fake-script.ts`) covers onboarding, a steered and stopped stream, a task
    made in the editor, an edited Always allow and its revocation, a question, a message left
    undelivered, and a monitor with pause, resume and a reply. `cli-access.spec.ts` runs
    `homerun login` from source (a file token store and no peer check). The bridge plays the
    access prompt: Don't Allow, then Allow. The token shows in Settings, Revoke signs it
    out, and the CLI is then refused.
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
  and an unsigned `.app` build nightly on macOS, followed by `cli-test.sh` (the bundled CLI,
  below) and `update-test.sh adhoc`.

## Manual checks

These need a real Mac, a person, or both, so no test covers them. Use a Developer ID build with
the provisioning profile (`IDENTITY=… TEAM_ID=… PROVISIONING_PROFILE=… scripts/macos/package.sh`, see `scripts/macos/sign.sh`) unless a
step says otherwise, installed in `/Applications`.

**Basics (milestone 7)**
1. `pnpm tauri dev` opens the window, and onboarding appears with no key.
2. A key is verified and saved; Settings shows it with its last four characters.
3. After a restart, the key is read from the keychain without a prompt (release build).
4. A chat streams, steers and stops. An approval and a question can be answered.
5. `kill -9` the `homerund` process: the banner shows it restarting, and the thread resumes.
   Do it again with the screen locked (over ssh, or with `sleep 30; kill -9 …`): the restarted
   runtime's `"secrets handed over"` line in `homerund.log` still lists `anthropic_api_key`.
6. Sleep the Mac for a few minutes with a monitor on. After wake, its coverage shows the sleep
   (§8.4).

**Menu bar and Dock**
7. The menu-bar item's count is pending approvals plus questions.
   - The submenus list them and the running runs, and each row opens its thread.
   - *Pause All Monitors* then *Resume Monitors* leaves a monitor that was already paused
     still paused.
8. Close the window: the Dock icon goes, and runs continue. Open Homerun again from the menu,
   Spotlight or Finder: the window and the Dock icon come back.

**Quit**
9. With a run active, ⌘Q, Dock → Quit and menu-bar Quit each show the alert:
   - Cancel keeps everything running;
   - Quit stops `homerund` within a few seconds and leaves no `claude` running;
   - the run continues on the next launch.

   With nothing active, all three quit at once.
10. With a run active, log out, or restart the Mac: nothing asks or blocks, and the run
    continues after you log in and open Homerun.

**Notifications** (a signed build)
11. Onboarding's *Turn on notifications* shows the macOS prompt; if it's denied, Settings says
    so.
12. With the window in the background, each of these posts, and clicking it opens its thread:
    - an approval, with the tool and class but not the command;
    - a question;
    - a monitor report;
    - a paused monitor;
    - a crash loop: `kill -9` `homerund` five times in three minutes.

    Nothing posts while the window is in front, and an answered approval's notification
    disappears.

**Login item**
13. Finish onboarding with *Open Homerun when you log in* checked. System Settings → General →
    Login Items lists Homerun, with the developer's name.
14. Turn it off there. Settings → *Running in the background* shows *Turned off in System
    Settings* and a button that opens that pane. Turn it back on from Homerun.
15. **Launch at login** (§16.1 item 9). With the item on:
    - quit Homerun, log out and log back in;
    - `pgrep -fl Homerun.app/Contents/MacOS/homerun` finds the shell and `homerund`;
    - the menu-bar item is there, with no window and no Dock icon;
    - the latest `"msg":"launch"` line in `~/Library/Application Support/Homerun/logs/homerund.log`
      has `"at_login":true`.

    If `at_login` is false, record it: the detection needs its fallback (§5.1).

**Updates**
16. `scripts/macos/update-test.sh devid` passes. It needs an unlocked Mac for its whole run:
    signing uses the login keychain, and a locked screen locks the data-protection keychain.
17. With the real key, publish two versions as a draft pre-release and check:
    - the banner and *Restart now*;
    - install on quit;
    - Settings → Updates.

**A clean Mac** (§16.1 items 6 and 10)
18. Build a notarized DMG:
    `IDENTITY=… TEAM_ID=… PROVISIONING_PROFILE=… NOTARY_PROFILE=homerun-notary scripts/macos/package.sh`.
    Keep the Mac unlocked: `notarytool` reads its profile from the data-protection keychain, which
    refuses reads while the screen is locked ("No Keychain password item found").
19. Run `scripts/macos/tart-clean-vm.sh dist/macos/<version>/Homerun.dmg`. It installs the DMG
    in a fresh VM with quarantine kept and reports:
    - Gatekeeper's verdict;
    - whether the runtime starts;
    - that no power assertion is held while idle;
    - that the Command Line Tools dialog never appears.
20. The Tart image ships with the Developer ID rules off, so the quarantined launch can't pass
    without a person. To click it through:
    - run step 19 with `KEEP_VM=1`;
    - stop the VM (`tart stop <vm>`) and open it again with a window (`tart run <vm>`);
    - choose *App Store & Known Developers* in Privacy & Security;
    - install the DMG again with quarantine;
    - open Homerun and click **Open** on the first-launch prompt.

**Command-line access (milestone 8a)** (a signed build in `/Applications`; keep the Mac
unlocked, since a locked screen locks the keychain)
21. Settings → *Command-line access* → **Install command-line tool**. `ls -l ~/.local/bin/homerun`
    points into `/Applications/Homerun.app/Contents/MacOS/homerun-cli`. Removing it deletes
    only that link.
22. `homerun login` in Terminal:
    - the alert appears, naming `homerun-cli`, its version and this Mac;
    - Return denies, and the CLI exits 77;
    - run it again and click **Allow**: the CLI prints that it is approved.
23. The token is in the login keychain: Keychain Access shows a `com.angilyu.homerun.cli` item
    that `homerun` reads without a prompt. `security find-generic-password -s com.angilyu.homerun.cli`
    finds it (don't add `-w`, which would print the token).
24. `homerun status` works; Settings shows the tool as *used just now*. **Revoke** there, and a
    running `homerun watch` stops at once; the next command says access was revoked.
25. `homerun login`, then quit Homerun while the alert is up: the CLI stops waiting and the
    alert closes. Leave one up for two minutes: it closes by itself, and the CLI says the
    request expired.
26. The peer check: run `homerun status` while a copy of Homerun signed by someone else (or an
    ad-hoc build) is running. It refuses to send the token and exits 77.
27. With the screen locked (over ssh), `homerun status` fails with a message about the locked
    keychain rather than asking for access again.
