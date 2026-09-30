# `@homerun/win32`

The Win32 calls `homerund` and the `homerun` CLI make on Windows (docs/design.md §5.2, §18
row 59), through `bun:ffi`, with no native addon and no dependencies. Nothing is loaded until a
call is made, so importing the package on macOS or Linux is free; the calls throw there.

- `sd.ts`: pure security-descriptor code, tested on every OS. The SDDL for the pipe (this user
  and SYSTEM, network logons denied, protected), for private directories and files, and
  `privacyProblems`, which says why a descriptor isn't private.
- `security.ts`: reading and setting a handle's or a path's owner and DACL.
- `pipe.ts`: opening a pipe and `GetNamedPipeServerProcessId`.
- `process.ts`: job objects, Toolhelp snapshots, process creation times, image paths, and the
  user a process runs as (`currentUserSid`, `processUserSid`).
- `power.ts`: `SetThreadExecutionState`.
- `cred.ts`: Credential Manager generic credentials.
- `wintrust.ts`: `WinVerifyTrust` and the signer's common name, for the CLI's
  `authenticode:` peer requirement.
- `logon.ts`: `LogonUserW` and impersonation, for the cross-user test only.

```sh
pnpm --filter @homerun/win32 typecheck
pnpm --filter @homerun/win32 test    # sd.test.ts everywhere; windows.test.ts on Windows only
```

On Windows, `windows.test.ts` checks the struct layouts against the real system: a job that
kills its tree, a pipe's server pid, a private ACL written and read back, a Credential Manager
round trip, and `WinVerifyTrust` on an unsigned file and on PowerShell. CI runs it in job
`windows-runtime`.
