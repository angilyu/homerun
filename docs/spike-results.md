# Milestone 0 spike results

Pass/fail evidence for the ten checks in [`design.md` §16.1](design.md#161-milestone-0-prove-the-risky-parts-first),
the measurements it asks for, and the design changes the results imply. `design.md` itself is
**not** edited here; every proposed change is listed in [Design impact](#design-impact) with the
section it touches.

> **Identifier renamed.** These results were recorded under the bundle identifier `dev.homerun.app`
> (keychain group `TEAMID.dev.homerun.shared`, data dir `~/Library/Application Support/dev.homerun.app`).
> It is now `com.angilyu.homerun` (see the "Changes from milestone 2" note in `design.md`). The old
> identifier is left as-is below because it is what the evidence was captured with.

Environment: macOS 26.7 on Apple silicon (arm64). Bun 1.4.2 (pinned). `@anthropic-ai/claude-agent-sdk` 0.3.278,
bundled `claude` 2.1.278. Tauri 2 (CLI 2.11.5). Node 24.21.0, uv 0.12.19.

## How to read this

- **Items 1–5 were first run against a scripted mock**, before an API key was available, and then
  **rerun against the real API** (Haiku 4.5 for all five items, Sonnet 5 for items 3 and 4). See
  [Real-API rerun](#real-api-rerun). The mock runs used the real SDK and the real bundled
  `claude` binary against a **scripted mock Messages API**
  ([`spikes/sdk/src/mock-api.ts`](../spikes/sdk/src/mock-api.ts)). The mock speaks the documented
  SSE format and enforces the API's `tool_use`/`tool_result` pairing rule (it returns the real 400
  error for an unanswered `tool_use`). The *model* is scripted, so these results show what the SDK
  and `claude` do (transcripts, hooks, resume, process lifetime). They don't show what a real model
  would decide. Those results are labelled **pass (mock API)**, and the real-API results **PASS (real API)**.
  Every request `claude` sent is saved as evidence, so the SDK-side claims can be checked directly. The real-API
  runs read `ANTHROPIC_API_KEY` from `.env.local` (gitignored; Bun loads it). The recording proxy redacts
  `x-api-key`/`authorization` and scrubs the key value from everything it writes.
- **No Apple Developer ID was available.** Builds are signed with a *self-signed* code-signing
  identity ([`make-selfsigned-identity.sh`](../scripts/macos/make-selfsigned-identity.sh)): stable
  designated requirement, no Team ID, kept in a private throwaway keychain. There are also
  ad-hoc-signed copies. Notarization, Gatekeeper on a clean machine, the keychain access group and
  the Team-ID-based keychain partition are **blocked on the user's certificate**. They are fully
  scripted and marked below.
- Evidence paths refer to `.spike/` (gitignored). Each item lists the command that regenerates its
  evidence.

## Summary

| # | Check (§16.1) | Result | One-line evidence |
|---|---|---|---|
| 1 | Bun binary drives bundled `claude` via `pathToClaudeCodeExecutable`, `settingSources: []`, private `CLAUDE_CONFIG_DIR`; nothing from `~/.claude` loads | **PASS (mock API)** · **PASS (real API, Haiku)**, with caveats | Isolated runs saw no user/project hooks, skills, agents, commands, MCP servers or settings env; the negative control loads all of them. Caveats: built-in skills are still listed, and the Bash tool sources the user's *login shell* profile (F9) |
| 2 | `sessionStore` round trip through SQLite; kill; resume from the store alone | **PASS (mock API)** · **PASS (real API, Haiku)** | SIGKILL mid-tool, local JSONL deleted, resumed from `sdk_transcripts` only, same session id, recalled the secret word |
| 3 | `defer` from `PreToolUse`; process exits; resume hours later with the answer | **PASS (mock API) for defer → exit → resume** (Bash approval and `AskUserQuestion`), 6/6 immediate resumes. **PASS (real API)** on Haiku and Sonnet 5 (immediate resume); the F3 mitigation also passes on both. **Long gap: see [item 3](#3-defer-and-resume-later)** (**PASS (mock API) after a 189-minute gap**: bash approval, `AskUserQuestion` and the parallel batch all resumed). Needs **design changes** in §5.6 (F3, F6) | `stop_reason: tool_deferred`, exit code 0, no `claude` left running, victim file untouched until approval |
| 4 | Kill mid-tool-call; resume; ambiguous call detected; "did / did not happen" injected | **PASS (mock API)** · **PASS (real API, Haiku and Sonnet 5)**, both **with a required design change** to §5.4. The real models confirm F7, and Haiku adds F10 (background Bash) | Detection works from `thread_events` and from the store. Three injection methods work. **But `claude` auto-answers the dangling call as "interrupted" on resume, and a naive resume re-ran the side effect** (F7). The tool process also outlives both a runtime and a `claude` SIGKILL (F8) |
| 5 | Steering message mid-run is seen at the next step | **PASS (mock API)** · **PASS (real API, Haiku)** | Pushed while Bash ran; delivered inside the next `tool_result` as a system-reminder; the model acted on it in the same run |
| 6 | One bundle, all binaries hardened-runtime, JIT entitlements on runtime and Node only; notarizes; Gatekeeper launches it on a clean machine | **FAIL as written** (claude needs `allow-jit` too; Node also needs `disable-library-validation`) + **BLOCKED** (notarization and clean-machine Gatekeeper need the Developer ID) | 5 binaries, all `flags=runtime`, `codesign --verify --deep --strict` OK. Self-signed bundle is rejected by `spctl` as expected. Clean VM: quarantined launch held at the Gatekeeper prompt (expected, blocked on Developer ID) |
| 7 | Runtime reads/writes a keychain item in the shared access group | **BLOCKED** (Team ID + provisioning profile) | Legacy login keychain read/write from the bundle: OK. Data-protection keychain: `errSecMissingEntitlement` (-34018) without an access-group entitlement, which needs a provisioning profile |
| 8 | Auto-update to a newly signed build; no keychain prompt; in-progress run resumes | **Update + resume: PASS. "No keychain prompt": FAIL for self-signed and ad-hoc, BLOCKED for Developer ID** | 0.0.1 → 0.0.2 mid-tool-call: run `completed`, `resumes=1`, both steps done. The post-update keychain read **shows a prompt** (timed out at 5 s) in both variants; the creating binary reads with no prompt |
| 9 | `SMAppService.mainApp`: launches at login; shows as "Homerun" in Login Items | **PARTIAL**: registration PASS; launch at login **untested** (needs a logout/login) | Background Task Management lists it as `Name: Homerun`, `enabled, allowed`; `Developer Name: (null)` without a Team ID |
| 10 | Bundled Node runs an `npx` MCP server with a native add-on; bundled `uv` runs a `uvx` server; from inside the signed app on a clean machine | **PASS on this machine** (signed bundle, scrubbed PATH) and **PASS on a clean macOS 26.6.2 VM** with quarantine removed (self-signed build; a Gatekeeper-approved launch is blocked on the Developer ID) | `better-sqlite3` server returned `sqlite 3.53.2` via bundled `node`; `mcp-server-time` via bundled `uv`. The clean VM also found two new issues: lost writes under a data dir named `dev.homerun.app` (entry 26) and a CLT install dialog from `uvx` (entry 27) |

Measurements (details in [Measurements](#measurements)):

| | Value |
|---|---|
| Install size (with Node + uv) | app **443 MB** on disk · DMG **205 MB** · updater payload **180 MB** |
| Install size without Node, uv, npm | app 276 MB · DMG 135 MB · updater 122 MB |
| Idle memory, runtime only (`homerund`) | 64 MiB RSS · 32 MB footprint |
| Idle memory, whole app (shell + 3 WebKit processes + runtime) | 241 MiB RSS · 85 MB footprint |
| Memory per active run | **≈215 MiB RSS / ≈120 MB footprint** with a clean shell. **≈260–300 MiB RSS / ≈150–190 MB footprint** with the user's own zsh profile (this machine's conda hook starts a `python` per shell) |

## Real-API rerun

Items 1–5 were rerun on the real Messages API with `claude-haiku-4-5`, and items 3 (with the F3
mitigation) and 4 with `claude-sonnet-5`. Same binaries, same harness, `maxBudgetUsd` 0.25 (Haiku) or 1.00
(Sonnet) per query. Results are namespaced so they don't overwrite the mock evidence:
`.spike/results/item<N>-real-<model>.json`. Total reported spend for all real runs was about **$0.28**
(sum of `total_cost_usd`; SIGKILLed runs report none).

```sh
# .env.local holds ANTHROPIC_API_KEY (never printed; the proxy redacts it)
for it in 1 2 3a "3b 3b-immediate" 3m 4 5; do
  HOMERUN_SPIKE_NS=real-haiku HOMERUN_MODEL=claude-haiku-4-5 HOMERUN_MAX_BUDGET_USD=0.25 bun run spikes/sdk/src/orchestrate.ts $it
done
for it in 3a "3b 3b-immediate" 3m 4; do
  HOMERUN_SPIKE_NS=real-sonnet HOMERUN_MODEL=claude-sonnet-5 HOMERUN_MAX_BUDGET_USD=1 HOMERUN_CHILD_SHELL=/bin/bash bun run spikes/sdk/src/orchestrate.ts $it
done
# item 4 again with the recommended shell, with and without background tasks
HOMERUN_SPIKE_NS=real-haiku-bash HOMERUN_MODEL=claude-haiku-4-5 HOMERUN_CHILD_SHELL=/bin/bash bun run spikes/sdk/src/orchestrate.ts 4
HOMERUN_SPIKE_NS=real-haiku-bash-nobg HOMERUN_MODEL=claude-haiku-4-5 HOMERUN_CHILD_SHELL=/bin/bash \
  HOMERUN_PROBE_EXTRA_ENV='{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}' bun run spikes/sdk/src/orchestrate.ts 4
```

| # | Mock API | Real API | Notes from the real runs |
|---|---|---|---|
| 1 | PASS | **PASS (real API)**, Haiku | Isolated and store-resumed runs: no canary markers, and the Bash tool printed `canary=.` (no settings env). The negative control fired all 11 markers and printed `canary=local-settings-env.`. The real `HOME` run showed no leaks. `apiKeySource: ANTHROPIC_API_KEY` |
| 2 | PASS | **PASS (real API)**, Haiku | SIGKILL mid-`sleep 30`, local JSONL deleted, 14 store entries. The resumed session answered `zebra3094` with the same session id |
| 3 | PASS | **PASS (real API)**, Haiku and Sonnet 5 | Bash and `AskUserQuestion` deferred (`stop_reason: tool_deferred`, exit 0, victim untouched). The resume ran the `rm` and answered `BLUE`. The parallel case reproduces F3 exactly: 3 × `defer`, only `echo c` reported |
| 3m | (mechanics only) | **PASS (real API)**, Haiku and Sonnet 5 | F3 mitigation: see below |
| 4 | PASS | **PASS (real API)**, Haiku and Sonnet 5 | Ambiguous call detected from `thread_events` and the store after a runtime SIGKILL. Strategy outcomes are in the table below. The `claude` SIGKILL leaves the tool shell running and the side effect happens (F8), seen on Sonnet and on Haiku with `/bin/bash` |
| 5 | PASS | **PASS (real API)**, Haiku | Steering pushed 0.5 s into `sleep 8`. The model then ran `echo STEERED` and replied `PINEAPPLE` in the same run (1 result) |

**What a real model does, as the review asked:**

- **Item 4, re-run after each strategy.** The side-effect log counts executions. Same results on Haiku (user's zsh,
  and `/bin/bash` with background tasks disabled) and on Sonnet 5:

  | Strategy | Haiku | Sonnet 5 | Re-ran the command? |
  |---|---|---|---|
  | naive resume ("continue") | re-ran | re-ran | **yes**: the model sees `claude`'s synthetic "[Request interrupted by user for tool use]" and retries (F7) |
  | `message` (decision as a user message) | `ACK-DID-HAPPEN` | `ACK-DID-HAPPEN` | **no** |
  | `inject-did` (decision as the `tool_result`) | no call; "already completed…" | no call; "already completed … nothing left to run" | **no** |
  | `inject-did-not` | re-ran | re-ran | yes, as intended |
  | `truncate` + message | `ACK-DID-HAPPEN` | `ACK-DID-HAPPEN` | **no** |

  After `inject-did` the empty-stream resume produced no turn, so the harness sent "continue". Haiku then
  replied, a little confused, "I'm not sure what you'd like me to continue with…" (once), and Sonnet said the task
  was done. **Design impact entry 7 stands**: inject, then resume with a short explicit message such as "The
  interrupted command completed; continue with the task", not a bare "continue".
- **F3, re-issue of dropped siblings after a parallel defer (no mitigation).** Both Haiku and Sonnet 5
  **re-issued** the two dropped calls after the reported one ran (`echo c`, then `echo a`, `echo b`; all three
  files created). They did this only because the user's prompt still listed all three: the dropped `tool_use`s are
  absent from the transcript, so the model is rediscovering them, not resuming them. Also, the runtime has already
  recorded three pending input requests, and two of them now belong to calls that no longer exist.
- **F3 mitigation (deny siblings, defer one), end to end** (`probe --policy defer-one:Bash`, `orchestrate.ts 3m`).
  - Phase A: hooks `defer, deny, deny`. `stop_reason: tool_deferred`, and `deferred_tool_use` is the *first* call,
    the one we chose. No files created. Both deny results are persisted in the store (2 entries).
  - On resume: all three `tool_use`s are in the transcript sent to the model, with the two deny messages.
  - After the approval ran `echo a`, **both models re-issued `echo b` and `echo c`** as new calls. All three files
    exist. Sonnet explained: "the initial parallel batch only ran the first call…".
  - **PASS on both models.** On Haiku the deferred call was again approved via `canUseTool` without `PreToolUse`
    (F6, twice for the same id). The stored decision was applied there, so it still passed.
  - The mock shows the same mechanics, but its scripted model treats a denied call as done and doesn't re-issue it.
- **Item 5, acting on steering.** Yes: Haiku ran the steered `echo STEERED` and ended with `PINEAPPLE`.
- **Can parallel tool use be disabled?** **No supported switch in this SDK/CLI.**
  - SDK 0.3.278 `Options` has no `tool_choice` or `disable_parallel_tool_use`, and no pass-through for Messages API
    request fields.
  - The `claude` 2.1.278 binary contains no `disable_parallel_tool_use` string; `tool_choice` is used internally
    only.
  - The closest setting, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1`, limits how many calls *execute* at once, not how
    many the model emits. With it set, Haiku still emitted three calls in one message, all three got `defer`, and only
    the last was reported (`.spike/results/parallel-conc1-real-haiku.txt`).
  - So the deny-siblings mitigation is required (entry 10). A prompt instruction such as "one tool call per message"
    would only reduce how often it happens.
- **New: F10, Haiku backgrounded the command.** In one item-4 run (`real-haiku-bash`), Haiku called Bash with
  `run_in_background: true`. The tool call returned at once ("Command running in background with ID …"), so after
  the runtime was killed there was **no ambiguous call** (the store had `tool_use` and `tool_result`), while the
  `sleep` was still running as an orphan. With `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
  (`real-haiku-bash-nobg`), the command ran in the foreground and item 4 behaved as above. `claude` also has
  `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`, which can background long commands automatically. See entry 24.
- **Timing artefact, F9.** In the first Haiku run (`real-haiku`, user's zsh), the `claude` SIGKILL landed while
  the login-shell snapshot was still sourcing the user's profile (conda). This was more than 3 s after
  `PreToolUse`, so the command never started and nothing survived. With `/bin/bash` the snapshot is fast, and the
  kill hit the running command as intended.
- Model quirk for item 1: in the negative control, Haiku did not append the `BANANA-*` token from the leaked
  `CLAUDE.md`. The pass relies on the hook and MCP markers, the settings env and the init lists, not on the
  model's obedience.

## Repository layout

```
spikes/homerund-m0/       the milestone 0 spike runtime, compiled with `bun build --compile`
                          (was apps/homerund; moved in milestone 2, when apps/homerund became the real runtime)
  src/main.ts             serve (socket + stdin token), run supervisor, keychain, selftests
  src/agent/run.ts        query() wrapper: isolation options, env scrubbing, hooks
  src/store/              SQLite schema (§6 subset) + SessionStore adapter on sdk_transcripts
  src/keychain.ts         Security.framework via bun:ffi
  src/mcp-probe.ts        spawn an MCP server with bundled node/uv, call one tool
apps/desktop/             Tauri v2 shell: sidecar supervision, updater, SMAppService, autotests
spikes/sdk/               probe CLI + orchestrator for items 1–5, mock Messages API, logging proxy
spikes/packaging/         update-flow, memory, shell-idle, socket-auth, F4 signing comparison (A/B/hybrid),
                          components-e22 (on-demand Node/uv from Application Support)
spikes/signing/           entitlement matrix
spikes/mcp-native/        tiny MCP server using better-sqlite3 (the item 10 fixture)
scripts/macos/            fetch-toolchain, package, sign (inside-out), verify, notarize,
                          make-selfsigned-identity, tart-clean-vm
```

### One-time setup

```sh
pnpm install
scripts/macos/fetch-toolchain.sh                 # stage claude, node(+npm), uv, homerund (sha256-pinned)
pnpm --filter @homerun/spike-sdk build           # .spike/bin/probe (Bun-compiled SDK driver)
scripts/macos/make-selfsigned-identity.sh        # optional: stable non-ad-hoc identity in .spike/signing/
# Builds (self-signed; use IDENTITY=- for ad-hoc, or a real "Developer ID Application: …" identity):
export IDENTITY=<sha1 printed by make-selfsigned-identity.sh> SPIKE_KEYCHAIN=$PWD/.spike/signing/homerun-spike.keychain-db
VERSION=0.0.1 scripts/macos/package.sh && VERSION=0.0.2 scripts/macos/package.sh
```

Corporate network note: npm and PyPI were reachable only through a mirror.
Set `HOMERUN_NPM_REGISTRY` and `HOMERUN_UV_INDEX_URL` for items 10 and F4. The runtime passes them to the
bundled `npx`/`uvx` as `npm_config_registry` / `UV_INDEX_URL` (see §5.5 impact).

---

## Item details

### 1. Isolation from the developer's `~/.claude`

**Command:** `bun run spikes/sdk/src/orchestrate.ts 1` → `.spike/results/item1.json`, `.spike/logs/final-item1.log`,
request bodies in `.spike/mock-api/1-*/`.

The probe is Bun-compiled (`.spike/bin/probe`) and calls `query()` with
`pathToClaudeCodeExecutable` set to the unpacked binary. Under `bun build --compile` the SDK cannot resolve its
optional-dependency binary, so this option is mandatory, as expected. The in-app runtime does the same with
`Contents/MacOS/claude`. No temp-dir extraction.

Setup: a fake `HOME` with a canary in every place Claude Code reads. User and project `settings.json`
(hooks writing marker files, `env` canaries), `settings.local.json`, `CLAUDE.md` containing a
`BANANA-*` token, skills, agents, slash commands, user and project `.mcp.json` servers.

| Run | Options | Result |
|---|---|---|
| `1-iso` | `settingSources: []`, private `CLAUDE_CONFIG_DIR`, explicit `tools`, `strictMcpConfig`, `mcpServers: {}` | No hook markers, no canary env (`canary=.`), no BANANA in any request, no user/project MCP servers, skills, agents or commands |
| `1-iso-resume` | same, resumed from the SQLite store | same: nothing leaks on the resume path |
| `1-control` (negative control) | SDK defaults | Loads **all** canaries: 3 hooks fire, `canary=local-settings-env`, user and project MCP servers, skills, agents, commands, CLAUDE.md |
| `1-realhome` | isolated options with the *real* `HOME` | None of the developer's own skills (`repo-analyze`) or MCP servers (`icm`) appear |

Caveats (not leaks of `~/.claude`, but relevant to §5.3):
- **Built-in skills and commands still appear** in `system/init`, even with `skills: []`
  (`deep-research`, `dataviz`, `update-config`, `verify`, `debug`, `code-review`, `simplify`, `batch`, …). They
  ship inside the `claude` binary. They are inert unless the `Skill` tool is in `tools`, which Homerun never
  enables, but the tool list must stay explicit.
- **The Bash tool runs in the user's login shell** (`zsh -c -l`, sourcing `~/.zprofile`/`~/.zshrc`; this machine's
  conda hook ran). `claude` snapshots that environment into `CLAUDE_CONFIG_DIR/shell-snapshots/`. `~/.claude`
  does not load, but the user's shell profile does. See F9.

### 2. `sessionStore` round trip through SQLite

**Command:** `bun run spikes/sdk/src/orchestrate.ts 2` → `.spike/results/item2.json`.

The adapter is [`sqlite-session-store.ts`](../spikes/homerund-m0/src/store/sqlite-session-store.ts): `append`, `load`,
`listSessions`, `listSessionSummaries`, `delete`, `listSubkeys` on the §6 `sdk_transcripts` table, plus a `uuid`
column with a unique index (F2).

1. Turn 1 tells the model a secret word. Turn 2 starts `sleep 30`; the probe is **SIGKILLed** mid-tool.
2. Every local transcript under `CLAUDE_CONFIG_DIR/projects/` is deleted, and the orphaned processes are reaped.
3. Resume with `resume: <sessionId>` + `sessionStore` only. Same session id; the model answered the secret word
   (`zebra7513`). The store held 31 entries.

Also observed: the resume **re-ran the killed `sleep 30`**. This is the item 4 behaviour: a naive resume
retries a dangling call.

### 3. Defer and resume later

**Commands:**
```sh
bun run spikes/sdk/src/orchestrate.ts 3a            # defer; the process exits → .spike/results/item3-phaseA.json
bun run spikes/sdk/src/orchestrate.ts 3b 3b-3h      # hours later: resume with the answer → .spike/results/item3-3b-3h.json
```

Phase A (`item3-phaseA-for-3h.json`, deferred at 2026-09-28T00:07:13Z) covers three sessions:
- **bash**: `PreToolUse` returns `defer` for `rm victim.txt`. Result `stop_reason: "tool_deferred"` with
  `deferred_tool_use`; process exit code 0; no `claude` process left; `victim.txt` still exists.
- **ask**: same for `AskUserQuestion` (Red/Blue).
- **parallel**: the model emits 3 Bash calls in one message. `PreToolUse` returns `defer` for **all three**,
  but the result's `deferred_tool_use` names **only the last one** (F3).

Phase B resumes each session with the stored answer and supplies it through the hook/`canUseTool`, keyed by
`tool_use_id`:

| Gap | Result |
|---|---|
| ≈1 minute (`item3-3b-immediate.json` and six repeats `item3-3b-r1..6.json`) | **6/6 pass**: bash approval ran the deferred `rm`; ask answered "Blue" → model replied `BLUE` |
| **3 hours** (`item3-3b-3h.json`) | **Pass** (mock API), 189.3 min between defer (00:07Z) and resume (03:16Z), empty input stream. bash: the deferred `rm` ran, `victim.txt` deleted; ask: answered "Blue" → `BLUE`. Decision path: `PreToolUse` re-fired for the same `tool_use_id` in both and `canUseTool` was not called, so F6 did not occur in this run. parallel: resumed and completed; as with the ≈1 min runs, only the mock's script brought back the dropped calls (F3 still applies) |

Findings that change §5.6:
- **F3, parallel defer loses calls.** On resume only the reported `tool_use` stays in the model's context. The
  other two were **dropped from the transcript sent to the API** (see the saved request body). The mock then
  re-issued them; a real model may not. A deferred parallel batch is not reliably resumable.
- **F6, `PreToolUse` does not always re-fire on resume.** In some resumes the SDK skipped `PreToolUse` for the
  deferred call and went straight to `canUseTool`, sometimes twice for the same `toolUseID`. This happened in 1/5
  early ask resumes, 2/6 bash resumes and 1/4 repeat runs. `PostToolUse` still fired. An early version of the
  probe blanket-allowed in `canUseTool`, and that failed the check: the stored decision has to be applied in
  **both** callbacks.
- The resume must send *something* on the input stream. An empty stream resumes the deferred call, but see item 4
  for the injected-result case.

### 4. Kill mid-tool-call, detect the ambiguous call, inject the user's decision

This was the highest-risk item. **Command:** `bun run spikes/sdk/src/orchestrate.ts 4` → `.spike/results/item4.json`.
A logging proxy (`spikes/sdk/src/proxy.ts`) records what `claude` sends to the API: `.spike/item4/proxy-*/`.

Prompt: run `sleep 15 && echo ran >> side-effect.log` exactly once. Kill 3 s after the `PreToolUse` `tool.call`
event.

**What a crash leaves behind:**

| Killed | Tool process | Side effect | Store | Detection |
|---|---|---|---|---|
| runtime (probe) SIGKILL | `claude` **orphaned** (ppid 1), keeps running and completes the tool | happened (1) | ends in an assistant `tool_use` with no `tool_result` | `ambiguous` finds it from `thread_events` (`tool.call` without `tool.result`) and from a store scan |
| `claude` SIGKILL | The Bash shell is **orphaned** (ppid 1) and completes. In an earlier run the kill landed before the shell started and there was no side effect | happened (1) in the final run | same dangling `tool_use` | same |

So after a crash the side effect is **genuinely unknown**: timing decides it, which is why §5.4 asks the user.

**How the SDK resumes a transcript that ends in a dangling `tool_use`** (F7): on resume, `claude` **itself
synthesizes and persists** a `tool_result` for the dangling call:
`is_error: true`, content `"[Request interrupted by user for tool use]"`, `toolDenialKind: "interrupted"`, followed
by a user text *"Continue from where you left off."* and, if nothing else is sent, a synthetic assistant message
*"No response requested."*. Consequences:
- After the first resume the transcript is well-formed, so **ambiguity must be detected before resuming**, from
  our own `thread_events` (preferred) or from a store scan for a `tool_use` with no `tool_result`. Both work.
- To the model, "interrupted" reads as "didn't finish". **A naive resume ("continue") re-ran the command and
  duplicated the side effect.**

**Injection strategies** (each resumes the same crashed session):

| Strategy | How | Re-ran the command? | Notes |
|---|---|---|---|
| `naive` | resume + "continue" | **yes (duplicate)** | the failure case |
| `message` | resume + a user message: "…confirms it DID complete (its side effect happened). Do not run it again." | no | model sees `claude`'s synthetic "interrupted" result *and* our message; relies on the model following it |
| `truncate` | `resumeSessionAt: <uuid before the tool_use>` + a message describing the outcome | no | removes the call from context; the model never sees a dangling call |
| `inject-did` | write a `tool_result` entry into the store (shaped like `claude`'s own synthetic entry: `parentUuid`/`sourceToolAssistantUUID` = the `tool_use` entry) saying "Homerun crashed while this ran; the user confirms it **did** complete", then resume | no | exact tool-granular answer; `claude` accepts it and does not synthesize its own |
| `inject-did-not` | same, "did **not** happen, run it again if still needed" | yes, once (intended) | |

After an injected result, an **empty** input stream does not continue the turn (timed out at 60 s); a short
prompt (e.g. "continue") is needed. Recommended mechanism: **`inject` the user's decision as the tool's
`tool_result`**, then resume with a brief continuation message. `truncate` is the fallback if a future SDK
version rejects foreign entries. Writing into the transcript relies on the SDK's entry format, so an SDK-upgrade
test must cover it.

Also (F8): when the runtime dies, `claude` and its tool processes keep running unsupervised. When `claude`
dies, its tool shell keeps running. See Design impact §5.1/§5.4.

### 5. Steering

**Command:** `bun run spikes/sdk/src/orchestrate.ts 5` → `.spike/results/item5.json`.

A streaming-input run starts `sleep 8`. While the tool runs, a second user message is pushed into the input
stream: "also run `echo STEERED`, then reply PINEAPPLE". `claude` delivered it **inside the next
`tool_result`** as a system-reminder ("The user sent a new message while you were working: …"). The model ran
`echo STEERED` and replied `PINEAPPLE`. One result, three turns. (The runtime sets `includePartialMessages`;
delta streaming wasn't a pass criterion here and isn't separately evidenced.)

### 6. Bundle, hardened runtime, entitlements, notarization, Gatekeeper

**Commands:**
```sh
scripts/macos/verify.sh dist/macos/0.0.2/Homerun.app        # → .spike/results/item6-verify-selfsigned.txt
HOMERUN_DATA_DIR=/tmp/hr-mcp apps/desktop/src-tauri/binaries/homerund-aarch64-apple-darwin mcp-selftest npx \
  "/tmp/homerun-spike-mcp-native-0.0.1.tgz#homerun-spike-mcp-native"   # populates the better-sqlite3 add-on the matrix loads
spikes/signing/entitlement-matrix.sh                        # → .spike/results/entitlement-matrix.tsv
NOTARY_PROFILE=homerun-notary scripts/macos/notarize.sh dist/macos/0.0.2/Homerun.app dist/macos/0.0.2/Homerun.dmg   # BLOCKED: needs Apple account
scripts/macos/tart-clean-vm.sh dist/macos/0.0.2/Homerun.dmg # clean-VM Gatekeeper + item 10 → .spike/results/tart-clean-vm/report-run5-pass.txt
```

Bundle: `Contents/MacOS/{homerun (Tauri shell), homerund, claude, node, uv}` and `Contents/Resources/npm`. Tauri's
bundler cannot give each helper its own entitlements, so [`sign.sh`](../scripts/macos/sign.sh) re-signs
inside-out after bundling: helpers, then the app.
`codesign --verify --deep --strict`: **OK**. All five binaries have `flags=0x10000(runtime)`.

**Entitlement matrix** (each helper ad-hoc re-signed with hardened runtime and each candidate set, then
exercised):

| Binary | Needs | Evidence |
|---|---|---|
| `homerund` (Bun 1.4.2) | `allow-jit` | fails with none; `allow-unsigned-executable-memory` not needed |
| `claude` (Bun-built) | **`allow-jit`** | With no entitlements `claude mcp list` works, but **every real turn crashes**: `ReferenceError: SharedArrayBuffer is not defined` (JavaScriptCore disables SAB without JIT), exit 1. With `allow-jit` the turn completes. Evidence: `.spike/results/claude-entitlement-{none,jit}.txt` |
| `node` | `allow-jit` + **`disable-library-validation`** | JIT alone fails; loading the `better-sqlite3` `.node` add-on (downloaded by npx, not signed by us) needs `disable-library-validation` |
| `uv` | none | |
| shell (`homerun`) | none | |

**Vendor signatures (F4).** `claude` is signed by Anthropic (Developer ID, Q6L2SF6YDW) with a broad
entitlement set: JIT, unsigned-executable-memory, apple-events, audio-input. `node` is signed by the Node.js Foundation
with **`get-task-allow`**, which notarization rejects. `uv` is signed by OpenAI (2DC432GLL2).
[`spikes/packaging/f4.sh`](../spikes/packaging/f4.sh) builds each option and runs the in-bundle selftest on
it (`.spike/results/f4/`):
- **A: keep the vendor signatures** (`THIRD_PARTY=keep`). The bundle verifies and every helper launches as a
  child of the hardened runtime. But Apple's notarization requirements reject `get-task-allow`, so `node`'s
  vendor signature would fail notarization. This is Apple's documented rule; it was not submitted, because that
  needs the account. The helpers also keep entitlements we didn't choose.
- **B: re-sign everything with our identity** (`THIRD_PARTY=resign`). The bundle verifies, all helpers launch, and
  we choose the entitlements.
- **H: hybrid, recommended** (`THIRD_PARTY=hybrid`, `F4_VARIANTS=H spikes/packaging/f4.sh`). `node` and `uv` are
  re-signed with our identity; `claude` keeps Anthropic's signature untouched (`Authority=Developer ID Application:
  Anthropic PBC (Q6L2SF6YDW)`, `flags=0x10000(runtime)`, secure timestamp present, entitlements include
  `allow-jit`). Results: strict deep verify OK. The in-bundle selftest passes: `claude --version` and
  `claude mcp list`, a node JIT loop, the `npx` server with the `better-sqlite3` add-on (`sqlite 3.53.2`), the
  `uvx` time server, and keychain set/get. `syspolicy_check notary-submission` reports the same single issue for A,
  B and H: "Adhoc Signed App" (`.spike/results/f4/H-*.txt`).

Recommendation: **H** (see [Design impact entry 14](#11-distribution-macos)). A cannot notarize with Node's
signature anyway.

Gatekeeper: `spctl --assess` on a quarantined copy of the self-signed bundle → `rejected`, and
`syspolicy_check distribution` → "Notary Ticket Missing". This is the expected result without a Developer ID and
notarization. **Blocked on the user's certificate.**

**Clean VM** (`tart-clean-vm.sh`, Tart `macos-tahoe-vanilla`, macOS 26.6.2; see [item 10](#10-mcp-servers-via-bundled-node-and-uv)
for the functional part). The DMG is copied in with a Safari-style `com.apple.quarantine` flag, mounted, and the
app is `ditto`ed to `/Applications`, which keeps the flag as a Finder drag would.
- The vanilla image ships with **Gatekeeper disabled** (`spctl --status`: assessments disabled). The harness
  enables it (`spctl --global-enable`) before installing; the first run without that step launched the
  quarantined self-signed app with no prompt, which proves nothing.
- `spctl --assess`: `rejected`, `origin=Homerun Spike Self-Signed`; `syspolicy_check distribution`: "Notary Ticket
  Missing". **Expected, blocked on the Developer ID.**
- Quarantined `open`: the app is translocated and syspolicyd logs `Prompt shown (7, 0), waiting for response`. The
  process sits at `_dyld_start` until someone answers. Expected for a non-notarized build.
- Harness trap, fixed: that pending evaluation outlives both its process and the prompt UI (`CoreServicesUIAgent`).
  Every later launch of the same code, even with quarantine removed, logs "waiting on another evaluation" and
  also sits at `_dyld_start`. The harness now kills the translocated process as well and restarts syspolicyd
  before its quarantine-removed phase (`.spike/results/tart-clean-vm/phase2-pending-evaluation.txt`).
  Not tested: whether a user who answers the prompt and relaunches is affected (answering should resolve the
  evaluation). It matters for scripted tests.

### 7. Keychain access group

**Command:** `…/homerund keychain-selftest [--data-protection] [--group TEAMID.dev.homerun.shared] --account X`
→ `.spike/results/item7.txt`.

| Keychain | Result from the signed bundle's `homerund` |
|---|---|
| Legacy login keychain (file-based) | set + get `errSecSuccess` |
| Data-protection keychain, default group | set `errSecMissingEntitlement` (-34018) |
| Data-protection keychain, `TEAMID.dev.homerun.shared` | -34018 |

On macOS the data-protection keychain requires a `keychain-access-groups` (or application-identifier) entitlement.
For Developer ID distribution that is a *restricted* entitlement and needs an **embedded provisioning profile**,
and a profile can only be embedded in a **bundle** (Apple TN3125, "Inside Code Signing: Provisioning Profiles"). `homerund` is currently a bare Mach-O in `Contents/MacOS/`.
[`sign.sh`](../scripts/macos/sign.sh) has the `TEAM_ID` + `PROVISIONING_PROFILE` path scripted. **Blocked on the
Team ID and a Developer ID provisioning profile**; see Design impact §11.

### 8. Auto-update mid-run

**Commands:**
```sh
spikes/packaging/update-flow.sh selfsigned                                                   # → .spike/results/item8-selfsigned/
spikes/packaging/update-flow.sh adhoc "$PWD/dist/macos/adhoc-0.0.1" "$PWD/dist/macos/adhoc-0.0.2"   # → .spike/results/item8-adhoc/
```

Flow:
1. Install 0.0.1 into `/private/tmp/hr8-<label>/inst`.
2. Serve 0.0.2's signed updater payload and `latest.json` locally.
3. 0.0.1 stores the API key in the keychain and starts a run (`sleep 25 && echo step1 >> progress.log`, then `echo step2`).
4. 12 s in (mid-tool-call), the Tauri updater downloads, verifies and installs 0.0.2 in place and restarts.
5. 0.0.2's shell spawns 0.0.2's `homerund`, which reads the keychain and resumes the interrupted run from the store.

| | self-signed (stable DR, no Team ID) | ad-hoc (cdhash DR) |
|---|---|---|
| Update installed, both binaries 0.0.2, `codesign --verify` OK | yes | yes |
| Run resumed and completed (`resumes=1`, `runtime_version=0.0.2`, `progress.log` = step1, step2) | **yes** | **yes** |
| 0.0.1 startup keychain read | not found (fresh), 73 ms | not found (fresh), 73 ms |
| **0.0.2 startup keychain read** | **timed out at 5 s ⇒ prompt shown** | **timed out at 5 s ⇒ prompt shown** |
| Control: the *creating* binary reads the same item | – | `status 0`, no prompt (`.spike/results/item8-control.txt`) |

How prompts are detected: the legacy keychain **ignores `kSecUseAuthenticationUIFail`** and blocks in
`SecItemCopyMatching` behind a modal "Homerun wants to access…" dialog until a human answers. `homerund` therefore
reads the key in a child process of itself (same code identity, so same ACL result) with a 5 s timeout, and logs
`ms` and `prompted`, never the value.

> **Note for the user:** earlier iterations of this test showed keychain dialogs on this Mac's screen. Two runs
> recorded a successful post-update read after ≈6–7 s, which was someone clicking the dialog. Those runs were
> discarded, and the timed read above replaced them.

The self-signed build keeps the same designated requirement across versions
(`identifier "dev.homerun.homerund" and certificate leaf = H"fcbb…"`) and still prompts. The likely reason:
since macOS 10.12 legacy keychain items carry a **partition list**. For Apple-issued signatures the partition is
`teamid:<TEAMID>`, which survives updates. Without a Team ID (self-signed or ad-hoc) it is the binary's
**cdhash**, which changes with every build. A Developer ID build should therefore not prompt, even on the legacy
keychain. That is **unverified here and blocked on the certificate**. The §11 plan (shared access group,
data-protection keychain) avoids the question entirely but depends on item 7.

### 9. Login item

**Commands:** `spikes/packaging/run-app.sh <app> <data> login-register|login-status|login-unregister`, then
`sfltool dumpbtm` → `.spike/results/item9-btm-registered.txt`, `item9-shell.log`.

`SMAppService.mainApp.register()` → status `enabled`. Background Task Management lists `Name: Homerun`,
`Type: app`, `Disposition: enabled, allowed, notified`, `Bundle Identifier: dev.homerun.app`,
`Developer Name: (null)` (no Team ID). Unregistered afterwards.
**Launch at login was not tested**: it needs a logout/login, which would end this session. Manual test:
register, log out, log in, check `pgrep -f Homerun.app/Contents/MacOS/homerun` and System Settings → General →
Login Items. Repeat with the Developer ID build to confirm the developer name shows.

### 10. MCP servers via bundled Node and uv

**Command** (from inside the signed 0.0.2 bundle, `PATH=/usr/bin:/bin`):
```sh
HOMERUN_SELFTEST_NPX_PKG="/tmp/homerun-spike-mcp-native-0.0.1.tgz#homerun-spike-mcp-native" \
  spikes/packaging/run-app.sh /private/tmp/hr10/Homerun.app /private/tmp/hr10/d selftest   # → .spike/results/item10-selftest-0.0.2.txt
```
(`cd spikes/mcp-native && npm pack --pack-destination /tmp` produces the tarball.)

- **npx:** bundled `node` + bundled npm's `npx-cli.js` installed the fixture and its `better-sqlite3` native add-on
  into a Homerun-private npm cache, then answered `sqlite_version` → `{"sqlite":"3.53.2","node":"v24.21.0",
  "execPath":".../Contents/MacOS/node"}`.
- **uvx:** bundled `uv tool run --from mcp-server-time==2026.8.18` answered `get_current_time`. On first use uv
  **downloaded a CPython build (25 MB)** into Homerun's private uv dir.
- helpers.check: `claude --version`, `claude mcp list` (empty: isolated config), `node` JIT + WebAssembly loop, and
  `uv --version` all start as children of the hardened `homerund`.

**Clean machine: PASS, with quarantine removed** ([`scripts/macos/tart-clean-vm.sh`](../scripts/macos/tart-clean-vm.sh)
→ `.spike/results/tart-clean-vm/report-run5-pass.txt`). The VM is Tart's `macos-tahoe-vanilla` (macOS 26.6.2)
with Gatekeeper enabled. It has no toolchain: `node`, `npx`, `uv`, `uvx` and `claude` are absent,
`xcode-select -p` has no developer directory, and `/usr/bin/python3` is only the CLT install stub. The quarantined
launch stops at the Gatekeeper prompt ([item 6](#6-bundle-hardened-runtime-entitlements-notarization-gatekeeper)),
so the harness removes `com.apple.quarantine` (`xattr -dr`), restarts syspolicyd, and relaunches with `open -n`:
- ping; helpers.check: `claude --version` 2.1.278, `claude mcp list` (empty), `node` v24.21.0, `uv` 0.12.19, all exit 0;
- keychain set/get: `errSecSuccess`;
- **npx:** `{"sqlite":"3.53.2","node":"v24.21.0","execPath":"/Applications/Homerun.app/Contents/MacOS/node"}`;
- **uvx:** `mcp-server-time` answered `get_current_time` (`isError:false`), after uv downloaded its CPython;
- the runtime exited 0 on shell shutdown.

The same selftest on a debug VM (0.0.3 = 0.0.2 plus exit logging, unquarantined) passed 10 of 10 cold runs with
this data dir. Two new problems appeared only on the clean machine:
- **Lost writes under `…/dev.homerun.app`** ([entry 26](#added-by-the-clean-machine-run)). With the default data dir,
  5 of 10 cold runs lost log lines from both the shell and the runtime after npm dropped `better_sqlite3.node` into it;
  0 of 10 with `…/Homerun`. So phase 2 uses `HOMERUN_DATA_DIR=~/Library/Application Support/Homerun`.
- **The "Install Command Line Developer Tools" dialog** opens during the first `uvx` run ([entry 27](#added-by-the-clean-machine-run)).
  `uvx` still succeeds. The harness reports it as `clt-prompt after run`; it was `none` before launch.

A Gatekeeper-approved launch (quarantine kept) needs a notarized Developer ID build; rerun the same script on it.

Tooling: the `cirruslabs/cli` Homebrew tap failed to install here, so Tart 2.32.1 was installed from its GitHub
release (sha256-checked) into `~/.local/bin`. `sshpass` wasn't installable (outdated CLT), so the harness falls
back to OpenSSH's `SSH_ASKPASS`. `KEEP_VM=1` leaves the VM running for debugging. The base image (≈50 GB) stays in
Tart's cache for the Developer ID run.

### Other checks done along the way

- **Local socket (§5.2):** `spikes/packaging/socket-auth.ts` → `.spike/results/socket-auth.json`. Socket dir `0700`,
  socket `0600`. No handshake → closed after 2 s. Wrong token → `401` and close. A method before `hello` → `401`.
  Correct token → `pong`. Graceful exit on stdin EOF.
- **Socket path length:** `sun_path` is 104 bytes on macOS. `~/Library/Application Support/dev.homerun.app/run/homerund.sock`
  fits for typical user names, but test data dirs under long paths did not.

---

## Measurements

**Commands:**
```sh
bun run spikes/packaging/memory.ts dist/macos/0.0.2/Homerun.app                  # → .spike/results/memory.json
HOMERUN_CHILD_SHELL=/bin/bash bun run spikes/packaging/memory.ts <app>           # → memory-shell_bin_bash.json
spikes/packaging/shell-idle.sh dist/macos/0.0.2/Homerun.app                      # → .spike/results/shell-idle.json
du -sh / ls -l on dist/macos/0.0.2                                               # → .spike/results/sizes.json
```

**Install size** (arm64 only, not yet universal):

| | Full | Without node, uv, npm |
|---|---|---|
| `Homerun.app` on disk | 443 MB | 276 MB |
| DMG (UDZO) | 205 MB | 135 MB |
| Updater `.tar.gz` | 180 MB | 122 MB |

Components: `claude` 208 MB, `node` 116 MB, `homerund` 60 MB, `uv` 35 MB, npm 16 MB, Tauri shell 7 MB.

**Idle memory** (20 s after launch, no runs):

| Process | RSS | Footprint |
|---|---|---|
| Tauri shell | 95 MiB | 24 MB |
| WebKit (WebContent + Networking + GPU) | 81 MiB | 30 MB |
| `homerund` | 64 MiB | 32 MB |
| **Total** | **241 MiB** | **85 MB** |

`homerund` returns to 69 MiB RSS after runs finish.

**Memory per active run** (signed `homerund` + mock API; each run is one `claude` process running a Bash
`sleep`; peak of the whole process tree minus idle):

| Bash shell | 1 run | 3 concurrent runs (per run) | `claude` alone |
|---|---|---|---|
| user's login zsh (default) | +259 MiB RSS, +153 MB footprint | +297 MiB RSS, +190 MB footprint | ≈206 MiB RSS |
| `/bin/bash` (`HOMERUN_CHILD_SHELL`) | +217 MiB RSS, +120 MB footprint | +214 MiB RSS, +118 MB footprint | ≈208 MiB RSS |

The extra ≈45–80 MiB per run with zsh is this machine's `~/.zshrc` conda hook, which starts a `python` process
for each Bash tool shell. At the §5.3 default of 3 sessions + 2 monitors, a busy Homerun is ≈1.3 GB RSS with a
clean shell.

---

## Design impact

Each entry: what the spike showed, the section of `design.md` to revise, and the proposed change.

### §5.3 Agent loop (isolation, SDK mapping)

1. **F1: `sessionStore` is a mirror, not the primary store.** `claude` writes its local JSONL under
   `CLAUDE_CONFIG_DIR/projects/` first, and the SDK mirrors the entries to the adapter.
   *Change:* set `sessionStoreFlush: "eager"`. Treat `CLAUDE_CONFIG_DIR/projects` as a cache that may be deleted
   (item 2 proves resume works without it). Clean it after each run.
2. **F2: mirror writes are best-effort and can repeat.** *Change to §6 `sdk_transcripts`:* add
   `uuid TEXT` with a unique index on `(project_key, session_id, subpath, uuid)` and insert with
   `INSERT OR IGNORE` (implemented in `schema.sql`).
3. **F5: every resume creates a temporary config dir** that is orphaned if the process is killed.
   *Change:* sweep stale temp dirs under Homerun's `CLAUDE_CONFIG_DIR` at runtime start.
4. **F9: the Bash tool uses the user's login shell** (`$SHELL -c -l`, profile sourced, snapshot written to
   `CLAUDE_CONFIG_DIR/shell-snapshots`). It leaks the user's environment and aliases into runs, adds startup
   latency and ≈45–80 MiB per run on this machine, and makes runs behave differently per user. `SHELL=/bin/sh`
   fell back to zsh. It appears to accept only bash or zsh: `SHELL=/bin/bash` was honoured and no user profile
   `python` ran; that user had no bash profile, so it is not a complete isolation guarantee.
   *Recommendation:* the **default** is a clean `/bin/bash` with a Homerun-controlled `HOME`. Add to the
   "Isolation" list: the runtime sets `SHELL=/bin/bash` for `claude`, points the tool shell's `HOME` at a
   Homerun-owned directory that holds an empty `.bash_profile`/`.bashrc`, and sets `BASH_ENV` to empty. The user's
   real `HOME` stays in a separate variable for tools that need to find project files. A **per-task opt-in**, "use
   my shell environment", runs with the user's `$SHELL` and real `HOME`. The UI labels it, because it also loads the
   user's aliases, `PATH` and secrets from their profile. The same default is used for measurement: the ≈215 MiB
   per-run figure is with `/bin/bash`. Real-API runs of item 4 on this machine show why: with the user's zsh profile,
   the snapshot step alone took more than 3 s (conda activation) before the command started.
5. **Built-in skills/commands are always listed**, even with `skills: []`. *Change:* note that the explicit
   `tools` list (never including `Skill`) is what keeps them inert.
6. §5.3 already calls for the explicit tool list and `strictMcpConfig`. Keep both: item 1's negative control
   shows every default source loads without them.

### §5.4 Crash resume: replace the "Open spike" bullet

7. **F7: `claude` auto-answers a dangling `tool_use` as "interrupted"** on resume and persists it, and a naive
   resume **re-runs the side effect**. *Change the resume procedure to:*
   1. At runtime start, before resuming any run, find ambiguous calls from `thread_events` (`tool.call` with no
      `tool.result`), with a store scan as a cross-check.
   2. `read`/`idempotent` tools: resume with a message saying the call was interrupted and may be retried.
   3. Other tools: keep the run in `waiting_input` **without resuming** (resuming would let `claude` write its own
      "interrupted" result). Ask "did it happen?"
   4. Apply the answer by appending a `tool_result` for that `tool_use_id` to `sdk_transcripts`. Did →
      "completed; do not re-run". Did not → "did not run". Then resume with a short continuation message.
      Fallback: `resumeSessionAt` the entry before the call, plus a message.
   5. Cover the entry format in the SDK-upgrade test suite; it is SDK-internal.

   **Confirmed on the real API** (Haiku and Sonnet 5): the naive resume re-runs the command, while `message`,
   `inject-did` and `truncate` all do not. After an injected result, resume with an explicit continuation such as
   "the interrupted command completed; continue the task", not a bare "continue" (Haiku asked what to continue).
8. **F6 impact on §5.4 step 1:** `tool.call` cannot be written from `PreToolUse` alone, because that hook is
   sometimes skipped on resume. *Change:* write `tool.call` from whichever of `PreToolUse`/`canUseTool` runs first
   (idempotent on `tool_use_id`), and `tool.result` from `PostToolUse`/`PostToolUseFailure`.

### §5.1 Process model / §5.4: process lifetime

9. **F8: children outlive their supervisors.** A SIGKILLed runtime leaves `claude` running (reparented to
   launchd), and it finishes the in-flight tool. A SIGKILLed `claude` leaves its tool shell running. *Change:*
   start each `claude` in its own process group and record `pid`/`pgid` in `runs`. On runtime start, kill any
   recorded group that is still alive **before** the ambiguity check, so no ghost finishes a tool after the user
   answers "did not happen". Stopping a run kills the whole group. On macOS, children of a crashed app are not
   killed automatically.

### §5.6 Input requests: `defer`

10. **F3: never defer a parallel batch.** With several tool calls in one assistant message, every call gets
    `defer`, but the result names one, and on resume the others are **gone from the model's context**.
    *Change:* when `PreToolUse` must defer and the message has sibling tool calls, **deny** the siblings with
    "not run; re-issue after the pending approval" and defer only one. Alternatively, keep the process alive
    until all are answered. Add a test.

    **Tested end to end on the real API** (Haiku and Sonnet 5, `orchestrate.ts 3m`): the chosen call is the one
    reported. The denied siblings stay in the transcript with their deny message, and after approval the model
    re-issues them as new calls, each going through the policy again. There is no supported way to turn off
    parallel tool use (see [Real-API rerun](#real-api-rerun)), so this mitigation is required.

    Implementation note: the SDK streams each `tool_use` of a batch as its own assistant entry, and its
    `PreToolUse` fires **before the next sibling has streamed**. So the runtime can't know up front whether siblings
    will follow. The rule has to be stateful per API message: the first gated call defers, and any later gated
    call from the same message is denied. Only the deferred call becomes an `input_requests` row. Not tested: an
    ungated sibling (for example `Read`) that streams after the deferred call.
11. **F6: `PreToolUse` may not re-fire for the deferred call on resume**, and `canUseTool` may be called twice.
    *Change:* the stored decision is applied, idempotently and keyed by `tool_use_id`, in both `PreToolUse` and
    `canUseTool`. `canUseTool` never blanket-allows. "Supplies the decision" in §5.6 should say this.
12. Resuming a deferred call works with an empty input stream. Resuming after an **injected** result needs a
    message. Specify both in the resume API.

### §11 Distribution (macOS)

13. **JIT entitlements are needed on three binaries, not two.** The bundled `claude` is Bun-built and needs
    `com.apple.security.cs.allow-jit`: without it every turn fails on `SharedArrayBuffer`. Node also needs
    `com.apple.security.cs.disable-library-validation` to load npm native add-ons. `allow-unsigned-executable-memory`
    is not needed by Bun ≥ 1.4.2 or Node 24. *Change §11 bullet 5 and §16.1 item 6* to: "JIT on the runtime,
    `claude` and Node; library-validation off on Node only; nothing on the shell or `uv`."
14. **Hybrid signing for third-party binaries (F4 variant H).** Re-sign `node` and `uv` with our Developer ID
    and minimal entitlements, and **keep Anthropic's signature on `claude`** (option A for `claude` only).
    - `node` must be re-signed: its vendor signature carries `get-task-allow`, which blocks notarization.
    - `uv` is re-signed so it carries our Team ID and no entitlements.
    - `claude` is left unmodified, so we never alter Anthropic's binary, and its signature already includes
      `allow-jit` (entry 13).
    - Trade-off: `claude` keeps entitlements we didn't choose (`allow-unsigned-executable-memory`,
      `disable-library-validation`, apple-events, audio-input). The shell's `NSAppleEventsUsageDescription` and
      microphone strings would be needed only if `claude` used those.

    *Change §11:* signing is inside-out with a custom script (`sign.sh`, `THIRD_PARTY=hybrid`), because Tauri's
    bundler cannot set per-helper entitlements. The script verifies `claude`'s Anthropic designated requirement
    before bundling instead of re-signing it.

    Verified ad-hoc as variant H: strict verify, in-bundle selftest, and the pre-notarization check (only
    "Adhoc Signed App"). `sign.sh` checks that `claude` still satisfies Anthropic's requirement and is hardened.
    Every real-API run in this report used this same file (`cmp`-identical, Anthropic signature), so real turns under
    their signature and entitlements are proven, including the SharedArrayBuffer/JIT case. **Still needs the certificate:** whether the notary service accepts nested code signed by
    another Team's Developer ID. It should, because `claude` is hardened and timestamped. Check at the first real
    submission; the fallback is option B for `claude` after confirming with Anthropic (§3.4).
15. **The keychain access group needs a bundled helper and a provisioning profile.** `keychain-access-groups` is
    restricted under Developer ID and requires an embedded provisioning profile, which a bare Mach-O cannot carry.
    *Recommendation: option 2.* All keychain access lives in the shell, and the runtime never calls
    Security.framework.
    - The shell is the bundle's main executable. It carries the app's `embedded.provisionprofile` and the
      `keychain-access-groups` entitlement, so no nested helper app is needed.
    - At startup, and whenever the key changes, the shell reads the key from the data-protection keychain and sends
      it to `homerund` as a `secrets.set` message over the already-authenticated local channel (§5.2: token on
      stdin, 0700 socket dir, peer check). `homerund` holds it only in memory and puts it only in `claude`'s
      environment.
    - While the shell is not running (for example, a login-item launch without UI), runs that need the key wait in
      `waiting_input`, "Open Homerun to unlock". The shell can also start at login without UI.
    - *Change §5.1/§5.2/§11:* move keychain ownership from the runtime to the shell, add `secrets.set` /
      `secrets.clear` to the runtime protocol, and never write the key to disk or logs. Entry 16 then applies to the
      shell: keychain reads are off the main thread and time out.
    - The spike's `homerund keychain-*` code remains only as test tooling. Item 7 still needs the Team ID to prove
      the access group, now from the shell.
16. **Keychain reads must never block the runtime.** The legacy keychain shows a modal dialog and blocks the
    calling thread, ignoring `kSecUseAuthenticationUIFail`. *Add:* read with a timeout off the serving path
    (implemented), surface "keychain access needs your approval" in the UI, and never read on startup before the
    socket is serving.
17. **Fallback if item 7 is not solved:** with a Developer ID build, the legacy keychain's `teamid:` partition
    should prevent the post-update prompt (item 8 analysis). Keep the item 8 test in CI for every release.
18. Two Tauri packaging facts for the release pipeline:
    - Tauri refuses to start if its executable path contains a symlink (e.g. `/tmp` → `/private/tmp`).
    - A crash during launch leaves AppKit's "reopen windows?" alert, which blocks the next unattended launch. Clear
      `~/Library/Saved Application State/dev.homerun.app.savedState` in test harnesses.

### §5.2 Transport

19. **Socket path limit.** `sun_path` is 104 bytes. *Add:* if `<data dir>/run/homerund.sock` would exceed it, fall
    back to a short per-user path such as `$TMPDIR/hr-<uid>/homerund.sock`, mode 0700, and fail loudly otherwise.

### §5.5 Tools (bundled Node / uv)

20. **Registries must be configurable.** On managed networks the public npm and PyPI registries may be blocked.
    *Add* per-install settings for the npm registry and the uv index (`npm_config_registry`, `UV_INDEX_URL`),
    passed only to the bundled `npx`/`uvx`.
21. **`uvx` downloads a CPython (≈25 MB) on first use.** *Decide:* accept a first-run download, pre-fetch it in the
    background after install, or bundle one (tens of MB more on disk; not measured).

### §14 Updates / install size

22. **The update payload is 180 MB**, of which `claude` is 208 MB uncompressed and changes with every SDK bump.
    *Recommendation:* ship **Node (with npm) and uv as on-demand, signed components**, downloaded the first time
    the user installs a third-party MCP server that needs `npx`/`uvx`. This saves 58 MB on the download and 167 MB
    on disk for users who never add one. Also measure a universal build, which roughly doubles the helpers.
    - **What is published.** Per architecture and version: a `.tar.zst` of the same binaries we would have bundled,
      re-signed inside-out with our Developer ID (entry 14), and notarized as a zip to get a ticket, since
      stand-alone Mach-Os can't be stapled. Alongside it goes a **component manifest**: name, version, URL,
      `sha256` of the archive, and the `CDHash` of every Mach-O. The manifest is signed with the same ed25519 key
      as the Tauri updater (minisign format), and that public key is compiled into the shell.
    - **Download and verify (in `homerund`).** Fetch the manifest and check its signature. Download the archive
      with the runtime's own HTTP client. Check its `sha256`, then extract it into a staging directory. For each
      Mach-O, run `codesign --verify --strict -R '=anchor apple generic and certificate leaf[subject.OU] = "<our
      TEAMID>" and cdhash H"<manifest cdhash>"'` (or `SecStaticCodeCheckValidity` with that requirement). Only then
      rename the directory atomically to
      `~/Library/Application Support/dev.homerun.app/components/<name>/<version>/`. Keep the previous version until
      the new one has passed a smoke test (`node -e`, `uv --version`).
    - **Launch.** The component is spawned only by the hardened runtime, by absolute path, via the
      `HOMERUN_{NODE,UV,NPM}` path hooks the spike already has. It is never on the user's `PATH`. The directory is
      owned by the user and mode 0700.
    - **Quarantine.** Files written by our own process are not quarantined, because Homerun does not set
      `LSFileQuarantineEnabled`. The installer still removes `com.apple.quarantine` explicitly after verification,
      in case a proxy or MDM tool adds it.
    - **Tested** (`spikes/packaging/components-e22.sh` → `.spike/results/e22/`): node and uv from the hybrid bundle
      were installed under `~/Library/Application Support/…/components/` and launched as children of the hardened
      `homerund`.
      - **plain** (no xattr): the `npx` server with the native add-on and the `uvx` server both ran.
      - **quarantined** (xattr as a browser sets it): both servers were **SIGKILLed at exec** by Gatekeeper, since
        our spike signature is ad-hoc and not notarized. With a notarized Developer ID component, Gatekeeper should
        allow it after an online check. That needs the certificate, and the plan above doesn't rely on it.
      - **tampered**: a flipped byte in a `__TEXT` page of `node` and a changed byte in `uv`'s unhashed tail
        padding **both still launched and served**. Kernel code-signing enforcement checks pages lazily and did not
        stop either one. Pre-launch verification caught them: `sha256` for both, and `codesign` for `node`.
        **Pre-launch verification is therefore required, not optional.** Pin both the archive `sha256` and each
        binary's `CDHash`, and re-verify on every runtime start (cheap: 0.41 s for `sha256` plus `codesign --verify` of both binaries).
    - *Change §5.5/§14:* the bundle ships `claude` plus the runtime only. Node/uv are components with the lifecycle
      above, the update manifest lists component versions, and the MCP install UI shows a one-time "downloading
      tools (≈60 MB)" step.

### Added by the real-API rerun

24. **F10: background Bash defeats ambiguity detection** (§5.4, §5.3). A real model (Haiku) chose
    `run_in_background: true`. The tool call completed at once, so a crash left no ambiguous call, only an orphaned
    process doing the work. `claude` can also auto-background long commands (`CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`).
    *Change:* set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the `claude` environment (§5.3 isolation list). Tested:
    with it, item 4 behaves correctly on Haiku. If background tasks are wanted later, they need their own lifecycle in
    `runs` (the process group is killed on restart per entry 9, and the run is told its job was lost).
25. **Parallel tool use cannot be disabled** in SDK 0.3.278 / `claude` 2.1.278. `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`
    only serializes execution. *Change §5.6:* rely on the deny-siblings rule (entry 10). Track an SDK feature
    request for `disable_parallel_tool_use` passthrough.

### Added by the clean-machine run

26. **The data dir must not be named `dev.homerun.app`** (§5.5 components path, §6 storage, §11 identifier). Tauri
    derives the data dir from the bundle identifier, giving `~/Library/Application Support/dev.homerun.app`, and
    macOS treats a directory ending in `.app` as an app bundle (`mdls`: `kMDItemContentType =
    com.apple.application-bundle`). On the clean VM, once npm put `better_sqlite3.node` inside it, XProtect scanned
    the "bundle", tccd handled a `kTCCServiceSystemPolicyAppBundles` (App Management) request from Homerun, and the
    shell's next `open(O_WRONLY|O_CREAT|O_APPEND)` of its log **failed with EPERM**. Across 10 interleaved cold
    selftests, **5 of 10 lost writes** from both the shell and the runtime with `…/dev.homerun.app`, and **0 of 10**
    with `…/Homerun`; with the latter, all 10 completed and both MCP probes passed. Four runs on the development
    machine lost nothing, so it doesn't show up there. The same directory will hold `homerun.db`, SDK transcripts
    and the §5.5 components, so this is a data-loss risk, not a logging nit. Tauri's own CLI (2.11.5) warns that an
    identifier ending in `.app` "conflicts with the application bundle extension on macOS".
    *Change:* choose the data dir explicitly, decoupled from the identifier: `~/Library/Application Support/Homerun`
    (the runtime and the shell already honour `HOMERUN_DATA_DIR`; make it the default). State the location in §6 and
    update the §5.5 components path to `…/Homerun/components/<name>/<version>/`. Also consider a bundle identifier
    that doesn't end in `.app` before the first public release (e.g. `dev.homerun.desktop`), since changing it
    later affects the keychain items and access group (§11), the login item and the updater. The spike did not test
    whether a new identifier alone avoids the problem; the decoupled data dir is the tested fix.
    Evidence: `.spike/results/tart-clean-vm/datadir-app-suffix-ab.txt`, `eperm-fs_usage-excerpt.txt`.
27. **First `uvx` use opens the "Install Command Line Developer Tools" dialog on a clean Mac** (§5.5, entries 21
    and 22). While installing its managed CPython, uv runs `install_name_tool -id …/libpython3.14.dylib`. It looks
    next to itself first (`Contents/MacOS/install_name_tool`: ENOENT), then runs `/usr/bin/install_name_tool`,
    which on a Mac without the CLT is Apple's stub: it exits 1 and opens the install dialog. `uvx` still succeeds.
    Seen in the formal run (`clt-prompt after run`) and in a uvx-only run on the debug VM. With a no-op
    `install_name_tool` first on the MCP child's `PATH`, `uvx` still returned `ok:true` and no dialog appeared.
    *Change:* the uv component ships an `install_name_tool` next to `uv` (a real one, or a no-op that exits 0 since
    uv's only call rewrites a dylib's install name to the same path; re-sign it with the component). More
    generally, the MCP child `PATH` must not reach `/usr/bin` CLT stubs (`git`, `python3`, `make`, `clang`,
    `install_name_tool`…): use a curated directory of allowed tools instead of `/usr/bin`. With the entry 21
    decision (download CPython in the background right after the uv component installs), the dialog would
    otherwise appear at that moment, unprompted.

### §16.1 itself

23. Item 6's wording "JIT on the runtime and Node only" should change per entry 13. Items 7 and 8 should say
    "Developer ID build", since neither can pass without a Team ID.

---

## Still open

| What | Blocked on | How to finish |
|---|---|---|
| Item 6 notarization + Gatekeeper | Developer ID + notary credentials | `xcrun notarytool store-credentials homerun-notary …`, `IDENTITY="Developer ID Application: …" VERSION=0.0.1 NOTARY_PROFILE=homerun-notary scripts/macos/package.sh`, then `scripts/macos/tart-clean-vm.sh dist/macos/<v>/Homerun.dmg` (Tart and the base image are already installed and cached; expect `accepted` and a launch with quarantine kept) |
| Item 7 access group | Team ID + Developer ID provisioning profile with `keychain-access-groups` | `TEAM_ID=… PROVISIONING_PROFILE=… scripts/macos/sign.sh`, then `homerund keychain-selftest --data-protection --group <TEAMID>.dev.homerun.shared`. Needs design entry 15 |
| Item 8 "no prompt" | Developer ID build | package 0.0.1 and 0.0.2 with the Developer ID, `spikes/packaging/update-flow.sh devid` → expect `prompted:false` |
| Item 9 launch at login | a logout/login | manual steps in item 9 |
| Item 10 with quarantine kept | the notarized Developer ID build (item 6) | the same `tart-clean-vm.sh` run: phase 1 then covers item 10 with the default data dir (expect entry 26's lost writes until it is fixed) |
| Entries 26, 27 fixes | milestone 1 | move the default data dir; add the `install_name_tool` shim and curated `PATH`; rerun `tart-clean-vm.sh` and expect `clt-prompt after run: none` |
