import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { endpointPath, filePrivacy, localEndpoint, newPipeName } from "@homerun/client";
import {
  asUser,
  closeHandle,
  currentUserSid,
  ERROR_ACCESS_DENIED,
  GENERIC_READ,
  GENERIC_WRITE,
  LOGON32_LOGON_INTERACTIVE,
  LOGON32_LOGON_NETWORK,
  LOGON32_LOGON_NETWORK_CLEARTEXT,
  logonUser,
  openExisting,
  openPipe,
  pipeServerPid,
  privacyProblems,
  READ_CONTROL,
  readPathSecurity,
  readSecurity,
  Win32Error,
} from "@homerun/win32";
import { AlreadyRunningError, RpcServer } from "../../src/rpc/server";
import { socketRuntime, type SocketRuntime } from "../helpers";

/**
 * The Windows transport (§5.2): a named pipe whose DACL admits this user and SYSTEM and denies
 * network logons, published by name in the private run dir. Real Win32 calls, so Windows only.
 */
const WINDOWS = process.platform === "win32";

let srt: SocketRuntime | undefined;
afterEach(async () => {
  await srt?.close();
  srt = undefined;
});

describe.skipIf(!WINDOWS)("the runtime's pipe (Windows)", () => {
  test("it is private, the name is published, and every instance carries the DACL", async () => {
    srt = await socketRuntime();
    const { socketPath, runDir, dataDir } = srt.rt.config;
    const me = currentUserSid();
    expect(localEndpoint(dataDir, "win32", filePrivacy)).toEqual({ runDir, socketPath });
    for (const d of [dataDir, runDir]) expect(privacyProblems(readPathSecurity(d), me, { protected: true })).toEqual([]);
    for (const f of [endpointPath(runDir), join(runDir, "dev-token")]) expect(privacyProblems(readPathSecurity(f), me)).toEqual([]);

    // Several live connections at once, so each probe lands on a different instance.
    const shell = await srt.shell();
    const handles: bigint[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const h = await openPipe(socketPath, READ_CONTROL);
        handles.push(h);
        expect(privacyProblems(readSecurity(h), me, { networkDeny: true, protected: true })).toEqual([]);
        expect(pipeServerPid(h)).toBe(process.pid);
      }
    } finally {
      for (const h of handles) closeHandle(h);
    }
    expect(await shell.call("ping", {})).toMatchObject({ pong: true });
  });

  test("a second server finds the first and stops; stopping removes the endpoint", async () => {
    srt = await socketRuntime();
    const { runDir } = srt.rt.config;
    const second = new RpcServer({ socketPath: newPipeName(), runDir, handlers: {} });
    await expect(second.start()).rejects.toBeInstanceOf(AlreadyRunningError);
    await srt.close();
    srt = undefined;
    expect(existsSync(endpointPath(runDir))).toBe(false);
  });

  test("a stale endpoint file does not block a new server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-pipe-"));
    try {
      await Bun.write(endpointPath(dir), `${newPipeName()}\n`);
      const name = newPipeName();
      const s = new RpcServer({ socketPath: name, runDir: dir, handlers: {} });
      await s.start();
      expect((await Bun.file(endpointPath(dir)).text()).trim()).toBe(name);
      s.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Another local user is shut out of the pipe and the run dir, whichever way it logs on. This
 * creates and removes a real local account, so it runs only where asked (CI sets
 * HOMERUN_WIN_CROSS_USER=1 on windows-latest). The password is random and never printed.
 */
describe.skipIf(!WINDOWS || process.env.HOMERUN_WIN_CROSS_USER !== "1")("another local user (Windows)", () => {
  function ps(command: string, env: Record<string, string>) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`powershell exited ${r.status}`);
  }

  const denied = (f: () => bigint) => {
    try {
      closeHandle(f());
      return "opened";
    } catch (e) {
      return e instanceof Win32Error ? e.code : String(e);
    }
  };

  test("is denied the pipe, the endpoint and the dev token for every logon type", async () => {
    srt = await socketRuntime();
    const { socketPath, runDir } = srt.rt.config;
    const user = `hrtest${randomBytes(3).toString("hex")}`;
    const env = { HR_TEST_USER: user, HR_TEST_PW: `Hr${randomBytes(12).toString("base64url")}a1!Z` };
    ps(
      "New-LocalUser -Name $env:HR_TEST_USER -Password (ConvertTo-SecureString $env:HR_TEST_PW -AsPlainText -Force) -AccountNeverExpires | Out-Null; Add-LocalGroupMember -SID S-1-5-32-545 -Member $env:HR_TEST_USER",
      env,
    );
    const control = newPipeName();
    const open = Bun.listen({ unix: control, socket: { data() {} } });
    try {
      for (const type of [LOGON32_LOGON_INTERACTIVE, LOGON32_LOGON_NETWORK, LOGON32_LOGON_NETWORK_CLEARTEXT]) {
        const tok = logonUser(user, env.HR_TEST_PW, type);
        try {
          const got = asUser(tok, () => ({
            pipe: denied(() => openExisting(socketPath, GENERIC_READ | GENERIC_WRITE)),
            pipeRead: denied(() => openExisting(socketPath, GENERIC_READ)),
            endpoint: denied(() => openExisting(endpointPath(runDir), GENERIC_READ)),
            devToken: denied(() => openExisting(join(runDir, "dev-token"), GENERIC_READ)),
            control: denied(() => openExisting(control, GENERIC_READ)),
          }));
          const { control: c, ...ours } = got;
          expect({ type, ...ours }).toEqual({
            type,
            pipe: ERROR_ACCESS_DENIED,
            pipeRead: ERROR_ACCESS_DENIED,
            endpoint: ERROR_ACCESS_DENIED,
            devToken: ERROR_ACCESS_DENIED,
          });
          // The control shows the impersonation took: a default-DACL pipe lets Everyone read.
          if (type === LOGON32_LOGON_INTERACTIVE) expect(c).toBe("opened");
        } finally {
          closeHandle(tok);
        }
      }
    } finally {
      open.stop(true);
      ps("Remove-LocalUser -Name $env:HR_TEST_USER", env);
    }
    // Two PowerShell starts and New-LocalUser take several seconds on a cold runner; bun's
    // default 5 s timed out on main (CI run 36761115697).
  }, 60_000);
});
