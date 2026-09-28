# Homerun

A local-first agent that runs your tasks on your own machine — and that you
control from anywhere.

- Architecture: [`docs/design.md`](docs/design.md)
- Design review and resolutions: [`docs/design-review.md`](docs/design-review.md)

Current phase: **milestone 3** — the [`homerun` CLI](apps/cli/README.md), which
drives the runtime ([`apps/homerund`](apps/homerund/README.md), milestone 2) with
no UI (`docs/design.md` §16). The shared contracts are in
[`packages/core`](packages/core/README.md) (milestone 1). Milestone 0, the Agent
SDK and packaging spike, is recorded in
[`docs/spike-results.md`](docs/spike-results.md).

To try it: `pnpm install`, then `pnpm --filter @homerun/homerund dev` in one
terminal and `pnpm homerun chat` in another.
