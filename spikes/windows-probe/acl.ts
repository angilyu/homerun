/**
 * Milestone 8b probe, round 2 (plan §4, P2), Windows only: who can open a pipe with the runtime's
 * DACL, `D:P(D;;GA;;;NU)(A;;GA;;;<user>)(A;;GA;;;SY)`?
 *
 *   P2.loopback  Round 1 connected over `\\localhost\pipe\…` despite the NETWORK deny. A raw pipe
 *                server in a child process impersonates such a client and reports its token: if
 *                it has no NETWORK group, SMB loopback reused the caller's own logon session and
 *                the result says nothing about a real remote client. Also tries the same open
 *                against a pipe created with PIPE_REJECT_REMOTE_CLIENTS.
 *   P2.otherUser A throwaway local user, logged on in-process with LogonUserW (interactive,
 *                network, batch) and impersonated on this thread, opens: the runtime-style pipe
 *                (expect denied); a default-DACL pipe (the baseline); and a pair that differ only
 *                in the NETWORK deny, both admitting that user. A network-logon token (what the
 *                SMB server impersonates for a remote client) must be refused by the first and
 *                admitted by the second: the deny ACE, not something else, keeps it out.
 *
 * Prints one JSON object; never fails the job on a "no".
 *
 *   bun spikes/windows-probe/acl.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { ptr } from "bun:ffi";
import {
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID,
  READ_CONTROL,
  WRITE_DAC,
  adv,
  fromWide,
  k32,
  logonKinds,
  open,
  processUserSid,
  sddlOf,
  setDacl,
  tokenGroups,
  tokenUser,
  wide,
} from "./ffi";

const out: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  out[k] = v;
};
const safe = async (k: string, f: () => unknown) => {
  try {
    note(k, await f());
  } catch (e) {
    note(k, `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
};
const close = (h: bigint) => {
  if (h !== INVALID && h !== 0n) k32.CloseHandle(h);
};

function listen(name: string): Promise<net.Server> {
  return new Promise((res, rej) => {
    const s = net.createServer((c) => {
      c.on("data", (d) => c.write(d));
      c.on("error", () => {});
    });
    s.once("error", rej);
    s.listen(name, () => res(s));
  });
}

async function secured(name: string, sddl: string): Promise<{ server: net.Server; set: string }> {
  const server = await listen(name);
  const { h, err } = open(name, READ_CONTROL | WRITE_DAC);
  if (h === INVALID) return { server, set: `open error ${err}` };
  const e = setDacl(h, sddl);
  const set = e === 0 ? sddlOf(h) : `SetSecurityInfo error ${e}`;
  close(h);
  return { server, set };
}

/**
 * Child: one raw pipe instance (default security), optionally with PIPE_REJECT_REMOTE_CLIENTS.
 * Blocks in ConnectNamedPipe, reads a byte, impersonates the client, writes back what its token
 * and the pipe say about it, and exits.
 */
function rawServer(name: string, reject: boolean) {
  const PIPE_ACCESS_DUPLEX = 3;
  const PIPE_REJECT_REMOTE_CLIENTS = 8;
  const h = k32.CreateNamedPipeW(wide(name), PIPE_ACCESS_DUPLEX, reject ? PIPE_REJECT_REMOTE_CLIENTS : 0, 1, 4096, 4096, 0, null) as bigint;
  if (h === INVALID) {
    writeSync(2, `CreateNamedPipeW error ${k32.GetLastError()}\n`);
    process.exit(2);
  }
  // Synchronously: the next call blocks this thread until a client connects.
  writeSync(1, "ready\n");
  if (!k32.ConnectNamedPipe(h, null) && k32.GetLastError() !== 535 /* ERROR_PIPE_CONNECTED */) process.exit(3);
  const one = Buffer.alloc(1);
  const n = new Uint32Array(1);
  k32.ReadFile(h, one, 1, ptr(n), null);
  const r: Record<string, unknown> = {};
  const cn = Buffer.alloc(1024);
  r.clientComputerName = k32.GetNamedPipeClientComputerNameW(h, cn, cn.length) ? fromWide(Number(ptr(cn))) : `error ${k32.GetLastError()}`;
  const sid = new Uint32Array(1);
  r.clientSessionId = k32.GetNamedPipeClientSessionId(h, ptr(sid)) ? sid[0] : `error ${k32.GetLastError()}`;
  if (adv.ImpersonateNamedPipeClient(h)) {
    const tok = new BigUint64Array(1);
    if (adv.OpenThreadToken(k32.GetCurrentThread() as bigint, 8 /* TOKEN_QUERY */, 1, ptr(tok))) {
      const groups = tokenGroups(tok[0]!);
      r.clientUser = tokenUser(tok[0]!);
      r.clientLogonKinds = logonKinds(groups);
      k32.CloseHandle(tok[0]!);
    } else r.clientToken = `OpenThreadToken error ${k32.GetLastError()}`;
    adv.RevertToSelf();
  } else r.impersonate = `error ${k32.GetLastError()}`;
  const reply = Buffer.from(JSON.stringify(r));
  k32.WriteFile(h, reply, reply.length, ptr(n), null);
  k32.FlushFileBuffers(h);
  k32.CloseHandle(h);
  process.exit(0);
}

/** Open `paths` in turn (retrying while the pipe isn't there yet), send a byte, read the reply. */
async function talk(paths: string[]): Promise<Record<string, unknown>> {
  const r: Record<string, unknown> = {};
  for (const p of paths) {
    let h = INVALID;
    let err = 0;
    for (let i = 0; i < 100; i++) {
      ({ h, err } = open(p, GENERIC_READ | GENERIC_WRITE));
      if (h !== INVALID || (err !== 2 && err !== 231)) break;
      await Bun.sleep(50);
    }
    if (h === INVALID) {
      r[p] = `open error ${err}`;
      continue;
    }
    const n = new Uint32Array(1);
    k32.WriteFile(h, Buffer.from("x"), 1, ptr(n), null);
    const buf = Buffer.alloc(8192);
    const ok = k32.ReadFile(h, buf, buf.length, ptr(n), null);
    close(h);
    r[p] = ok ? { connected: true, ...JSON.parse(buf.subarray(0, n[0]!).toString()) } : `read error ${k32.GetLastError()}`;
    break;
  }
  return r;
}

async function loopback(reject: boolean) {
  const base = `hr-probe-raw-${randomBytes(12).toString("hex")}`;
  const c = spawn(process.execPath, [import.meta.path, "--raw-server", base, reject ? "1" : "0"], { windowsHide: true });
  let stderr = "";
  c.stderr.on("data", (d) => (stderr += d));
  const killer = setTimeout(() => c.kill(), 15_000);
  const ready = await new Promise<boolean>((res) => {
    c.stdout.on("data", (d) => String(d).includes("ready") && res(true));
    c.on("exit", () => res(false));
  });
  if (!ready) return { serverReady: false, stderr };
  const r = await talk([`\\\\localhost\\pipe\\${base}`, `\\\\.\\pipe\\${base}`]);
  const code = await new Promise((res) => c.on("exit", res));
  clearTimeout(killer);
  return { ...r, serverExit: code, ...(stderr ? { stderr } : {}) };
}

function ps(command: string, env: Record<string, string>) {
  const p = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  return { code: p.status, ...(p.stderr.trim() ? { stderr: p.stderr.trim().split(/\r?\n/).slice(0, 4) } : {}) };
}

async function otherUser(me: string) {
  const r: Record<string, unknown> = {};
  const user = `hrprobe${randomBytes(3).toString("hex")}`;
  // Never printed. New-LocalUser, unlike `net user`, doesn't prompt about passwords over 14 chars.
  const pw = `Hr${randomBytes(12).toString("base64url")}a1!Z`;
  const env = { HR_PROBE_USER: user, HR_PROBE_PW: pw };
  // In Users (S-1-5-32-545), as a normal account would be: that group may log on locally.
  r.create = ps(
    "New-LocalUser -Name $env:HR_PROBE_USER -Password (ConvertTo-SecureString $env:HR_PROBE_PW -AsPlainText -Force) -AccountNeverExpires | Out-Null; Add-LocalGroupMember -SID S-1-5-32-545 -Member $env:HR_PROBE_USER",
    env,
  );
  const servers: net.Server[] = [];
  try {
    const tokens: Array<[string, bigint]> = [];
    const logons: Record<string, unknown> = {};
    for (const [label, type] of [["interactive", 2], ["network", 3], ["batch", 4], ["networkCleartext", 8]] as const) {
      const t = new BigUint64Array(1);
      if (adv.LogonUserW(wide(user), wide("."), wide(pw), type, 0, ptr(t))) {
        tokens.push([label, t[0]!]);
        logons[label] = { user: tokenUser(t[0]!), kinds: logonKinds(tokenGroups(t[0]!)) };
      } else logons[label] = `LogonUserW error ${k32.GetLastError()}`;
    }
    r.logons = logons;
    if (!tokens.length) return r;
    const them = tokenUser(tokens[0]![1]);
    const tag = randomBytes(12).toString("hex");
    const pipes: Record<string, string> = {
      runtimeDacl: `\\\\.\\pipe\\hr-probe-rt-${tag}`,
      defaultDacl: `\\\\.\\pipe\\hr-probe-def-${tag}`,
      theirsWithNetworkDeny: `\\\\.\\pipe\\hr-probe-nu-${tag}`,
      theirsWithoutNetworkDeny: `\\\\.\\pipe\\hr-probe-ctl-${tag}`,
    };
    const sets: Record<string, string> = {};
    for (const [k, sddl] of [
      ["runtimeDacl", `D:P(D;;GA;;;NU)(A;;GA;;;${me})(A;;GA;;;SY)`],
      ["theirsWithNetworkDeny", `D:P(D;;GA;;;NU)(A;;GA;;;${me})(A;;GA;;;${them})(A;;GA;;;SY)`],
      ["theirsWithoutNetworkDeny", `D:P(A;;GA;;;${me})(A;;GA;;;${them})(A;;GA;;;SY)`],
    ] as const) {
      const s = await secured(pipes[k]!, sddl);
      servers.push(s.server);
      sets[k] = s.set;
    }
    servers.push(await listen(pipes.defaultDacl!));
    r.pipeSddl = sets;
    const results: Record<string, Record<string, string>> = {};
    for (const [label, tok] of tokens) {
      const row: Record<string, string> = {};
      if (!adv.ImpersonateLoggedOnUser(tok)) {
        results[label] = { impersonate: `error ${k32.GetLastError()}` };
        continue;
      }
      try {
        for (const [k, p] of Object.entries(pipes)) {
          for (const [mode, access] of [["rw", GENERIC_READ | GENERIC_WRITE], ["r", GENERIC_READ]] as const) {
            const { h, err } = open(p, access);
            close(h);
            row[`${k}.${mode}`] = h === INVALID ? `denied ${err}` : "CONNECTED";
          }
        }
      } finally {
        adv.RevertToSelf();
      }
      results[label] = row;
      await Bun.sleep(20);
    }
    r.opens = results;
    for (const [, t] of tokens) k32.CloseHandle(t);
  } finally {
    for (const s of servers) s.close();
    r.remove = ps("Remove-LocalUser -Name $env:HR_PROBE_USER", env);
  }
  return r;
}

async function main() {
  const i = process.argv.indexOf("--raw-server");
  if (i >= 0) return rawServer(`\\\\.\\pipe\\${process.argv[i + 1]}`, process.argv[i + 2] === "1");
  const me = processUserSid();
  note("user", me);
  await safe("P2.loopback", () => loopback(false));
  await safe("P2.loopbackRejectRemote", () => loopback(true));
  await safe("P2.otherUser", () => otherUser(me));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

await main();
