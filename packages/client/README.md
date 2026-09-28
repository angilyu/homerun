# `@homerun/client`

How a local process finds and talks to `homerund` (docs/design.md §5.2). The runtime, the
`homerun` CLI, the tests, the replay harness and the development shell all import it, so they
cannot disagree about where the socket is.

- `paths.ts`:
  - `dataDir(env)`: `HOMERUN_DATA_DIR`, else `~/Library/Application Support/Homerun`.
  - `chooseRunDir(dataDir)`: `<data>/run/homerund.sock`. When that path would exceed the
    104-byte `sun_path`, it falls back to `$TMPDIR/hr-<uid>/`.
  - `readDevToken(runDir)`: reads the development token that a development `homerund` writes at
    every start. It refuses the file unless it is a regular file owned by this user with mode
    0600 (no group or other bits).
- `build.ts`: `resolveBuildChannel(defined, compiled)`, the fail-closed build channel. A
  compiled binary is release unless it was built with an explicit development define. The same
  rule applies to `homerund` (`HOMERUND_BUILD`) and the CLI (`HOMERUN_CLI_BUILD`).
- `client.ts`: `RpcClient`, JSON-RPC 2.0 with one frame per line.
  - `open()` connects and completes `hello`.
  - With `validate`, it parses every result with its core schema.
  - Its errors are typed: `RpcCallError` (a JSON-RPC error), `RuntimeUnavailableError`
    (nothing listening), `ConnectionClosedError` and `RpcProtocolError`.

The package runs on Bun (`Bun.connect`) and exports TypeScript source, like `@homerun/core`.

```sh
pnpm --filter @homerun/client typecheck
pnpm --filter @homerun/client test
```
