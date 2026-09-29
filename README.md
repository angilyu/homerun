# Homerun

A local-first agent that runs your tasks on your own machine — and that you
control from anywhere.

Homerun is a desktop app (macOS first, then Windows) that runs Claude agents,
built on the Claude Agent SDK, on the user's own computer. It has two kinds of
task:
- **sessions:** you chat with an agent that works on your files and tools;
- **monitors:** a schedule checks something and tells you when it changes.

An iOS app and a web client control the desktop remotely, through a blind relay
that carries only end-to-end encrypted frames. The agent never runs in the cloud,
and your data stays on your machine. Users bring their own Anthropic API key.

## Status

| Milestone | | Status |
|---|---|---|
| 0 | Spike: Agent SDK behaviour and macOS packaging | Done, with three open items ([design §16.1](docs/design.md#161-milestone-0-prove-the-risky-parts-first)) |
| 1 | Shared contracts ([`packages/core`](packages/core/README.md)) | Done |
| 2 | The runtime, `homerund` ([`apps/homerund`](apps/homerund/README.md)) | Done |
| 3 | The `homerun` CLI ([`apps/cli`](apps/cli/README.md)) | Done |
| 4 | Crash resume | Done |
| 5 | Scheduler and monitors | Done |
| 6 | Approvals and questions | Done |
| 7 | The desktop app ([`apps/desktop`](apps/desktop/README.md)) | Done |
| 8 | Packaging: menu bar, login item, signed updater | **Next** |

Later milestones (relay, iOS and web, distribution) are listed in
[design §16](docs/design.md#16-build-plan).

## Repository layout

| Path | What it is |
|---|---|
| [`apps/homerund`](apps/homerund/README.md) | The runtime: agent runs, storage (SQLite), crash resume, the local socket |
| [`apps/cli`](apps/cli/README.md) | `homerun`, the command-line client |
| [`apps/desktop`](apps/desktop/README.md) | The macOS app: a Tauri shell that supervises `homerund`, and the React UI |
| [`packages/app-state`](packages/app-state/README.md) | The platform-neutral client state layer the app's views render (and, later, the web and iOS clients) |
| [`packages/core`](packages/core/README.md) | Task spec, events and the IPC protocol as Zod schemas, plus JSON Schema and test vectors |
| [`packages/client`](packages/client/README.md) | How a local process finds and talks to `homerund`: the runtime, the CLI and the test harnesses share it |
| `spikes/` | Milestone 0 experiments: SDK behaviour, signing, packaging, native MCP servers |
| `scripts/` | Repository checks (`check-no-secrets.sh`, `check-registry.sh`) and the macOS build, signing and notarization scripts (`scripts/macos/`) |
| [`docs`](docs/) | The design document and the milestone 0 results |

## Quick start

Requires macOS or Linux, [Bun](https://bun.sh) 1.4.2, pnpm 11.5.0 and Node 22
or later.

```sh
pnpm install
pnpm --filter @homerun/desktop tauri dev    # the app (macOS, Rust 1.94)
```

Or, without the app, the runtime with a dev shell standing in for it:

```sh
pnpm --filter @homerun/homerund dev
```

The dev shell takes the API key from `ANTHROPIC_API_KEY`, or asks for it. In
another terminal, from the repository root:

```sh
pnpm homerun status
pnpm homerun chat
```

See the [app README](apps/desktop/README.md), the
[CLI README](apps/cli/README.md) for all commands, and the
[runtime README](apps/homerund/README.md) for the dev shell's options.

## Documentation

- [`docs/design.md`](docs/design.md) — the architecture: what Homerun does and
  how, the build plan, and a [decision log](docs/design.md#18-decision-log).
  It is the authoritative spec.
- [`docs/spike-results.md`](docs/spike-results.md) — the milestone 0 test
  record and measurements.
- Each package and app README covers its own interfaces and rules.

## Tests

```sh
pnpm -r typecheck
pnpm --filter @homerun/core test
pnpm --filter @homerun/core schema:check    # generated JSON Schema and vectors are current
pnpm --filter @homerun/client test
pnpm --filter @homerun/homerund test:unit    # fake engine, no network
pnpm --filter @homerun/homerund test:replay  # real claude against recorded API exchanges, no key
pnpm --filter @homerun/homerund test:crash   # kill at every event boundary
pnpm --filter @homerun/cli test:unit
pnpm --filter @homerun/cli test:e2e
pnpm --filter @homerun/cli test:replay
pnpm --filter @homerun/app-state test
pnpm --filter @homerun/desktop test           # component tests
pnpm --filter @homerun/desktop test:e2e       # the UI against a real homerund
(cd apps/desktop/src-tauri && cargo test -p homerun-shell-core)
scripts/check-no-secrets.sh
```

No test needs an API key. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
runs these in parallel jobs: the packages, the runtime, its crash tests, the CLI,
the app's state layer and views, the app end to end, and the shell's supervisor.
A nightly job builds the full Tauri app on macOS.
