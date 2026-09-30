# `@homerun/client`

How a local process finds and talks to `homerund` (docs/design.md §5.2). The runtime, the
`homerun` CLI, the tests, the replay harness and the development shell all import it, so they
cannot disagree about where the socket is.

- `paths.ts`:
  - `dataDir(env)`: `HOMERUN_DATA_DIR`, else `~/Library/Application Support/Homerun`
    (`%LOCALAPPDATA%\Homerun` on Windows).
  - `chooseRunDir(dataDir)`: `<data>/run/homerund.sock`. When that path would exceed the
    104-byte `sun_path`, it falls back to `$TMPDIR/hr-<uid>/`. On Windows there is no socket
    file: `localEndpoint(dataDir)` reads the pipe name the runtime published in
    `run\endpoint`, and `newPipeName()` makes a fresh `\\.\pipe\homerun-<128 bits>`.
  - `readDevToken(runDir)`: reads the development token that a development `homerund` writes at
    every start. It refuses the file unless it is a regular file owned by this user with mode
    0600 (no group or other bits), or on Windows one whose ACL allows nobody else.
    `readDevTokenFile(path)` applies the same checks to an explicit path (the CLI's
    `--dev-token-file`), and the endpoint file gets them too.
  - Every function takes the platform, so the Windows rules are tested on every OS.
- `build.ts`: `resolveBuildChannel(defined, compiled)`, the fail-closed build channel. A
  compiled binary is release unless it was built with an explicit development define. The same
  rule applies to `homerund` (`HOMERUND_BUILD`) and the CLI (`HOMERUN_CLI_BUILD`).
- `client.ts`: `RpcClient`, JSON-RPC 2.0 with one frame per line.
  - `open()` connects and completes `hello`. `connect()` then `handshake()` does the same in two
    steps, so a caller can tell "nothing is listening" apart from "the token was refused".
  - With `validate`, it parses every result with its core schema.
  - Its errors are typed: `RpcCallError` (a JSON-RPC error), `RuntimeUnavailableError`
    (nothing listening), `ConnectionClosedError` and `RpcProtocolError`.

The package runs on Bun (`Bun.connect`, which opens a named pipe given its `\\.\pipe\` path)
and exports TypeScript source, like `@homerun/core`. Its Windows ACL checks come from
[`@homerun/win32`](../win32).

```sh
pnpm --filter @homerun/client typecheck
pnpm --filter @homerun/client test
```
