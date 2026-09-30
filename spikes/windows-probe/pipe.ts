/**
 * Milestone 8b probe (plan §4), Windows only. Answers:
 *   P1  does Bun's node:net named-pipe server work (from source and `bun build --compile`)?
 *   P2  does a post-hoc protected DACL, set through a client handle opened with WRITE_DAC, cover
 *       instances libuv creates later, and keep other users and remote (SMB) clients out?
 *   P3  can a separate process connect with node:net and with Bun.connect({unix}), and learn the
 *       server's pid, user and image through GetNamedPipeServerProcessId on its own handle?
 *   plus SetThreadExecutionState. Prints one JSON object; never fails the job on a "no".
 *
 *   bun spikes/windows-probe/pipe.ts [--cross-user]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import {
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID,
  READ_CONTROL,
  WRITE_DAC,
  k32,
  open,
  processImage,
  processUserSid,
  sddlOf,
  serverPid,
  setDacl,
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

function echo(name: string, msg: string): Promise<string> {
  return new Promise((res, rej) => {
    const c = net.connect(name, () => c.write(msg));
    c.once("data", (d) => {
      res(d.toString());
      c.end();
    });
    c.once("error", rej);
    setTimeout(() => rej(new Error("timeout")), 3000);
  });
}

function close(h: bigint) {
  if (h !== INVALID) k32.CloseHandle(h);
}

async function child(name: string) {
  const r: Record<string, unknown> = {};
  r.nodeNetEcho = await echo(name, "hello").catch((e) => `error ${e}`);
  r.bunConnect = await new Promise((res) => {
    Bun.connect({
      unix: name,
      socket: {
        open(s) {
          s.write("bun");
        },
        data(s, d) {
          res(`echo ${Buffer.from(d).toString()}`);
          s.end();
        },
        error(_s, e) {
          res(`error ${e}`);
        },
        connectError(_s, e) {
          res(`connectError ${e}`);
        },
      },
    }).catch((e) => res(`threw ${e}`));
    setTimeout(() => res("timeout"), 3000);
  });
  const { h, err } = open(name, GENERIC_READ | GENERIC_WRITE);
  if (h === INVALID) r.probeHandle = `error ${err}`;
  else {
    const pid = serverPid(h);
    r.serverPid = pid;
    if (typeof pid === "number") {
      r.serverImage = processImage(pid);
      r.serverUser = processUserSid(pid);
    }
    r.pipeSddlFromClient = sddlOf(h);
    close(h);
  }
  process.stdout.write(JSON.stringify(r));
}

async function main() {
  const i = process.argv.indexOf("--child");
  if (i >= 0) return child(process.argv[i + 1]!);

  note("compiled", !process.execPath.toLowerCase().endsWith("bun.exe"));
  note("bunVersion", Bun.version);
  const me = processUserSid();
  note("user", me);
  const base = `hr-probe-${randomBytes(16).toString("hex")}`;
  const name = `\\\\.\\pipe\\${base}`;
  const plain = `\\\\.\\pipe\\${base}-default`;

  const server = await listen(name).catch((e) => e as Error);
  note("P1.listen", server instanceof Error ? `error ${server.message}` : "ok");
  if (server instanceof Error) return;
  const other = await listen(plain);
  await safe("P1.echo", () => echo(name, "ping"));
  await safe("P1.bunListen", async () => {
    const n = `${name}-bunlisten`;
    const l = Bun.listen({ unix: n, socket: { data(s, d) { s.write(d); } } });
    const r = await echo(n, "x");
    l.stop(true);
    return `ok echo ${r}`;
  });

  await safe("P2.defaultSddl", () => {
    const { h, err } = open(name, READ_CONTROL | GENERIC_READ);
    if (h === INVALID) return `open error ${err}`;
    const s = sddlOf(h);
    note("P3.serverPidSameProcess", serverPid(h) === process.pid);
    close(h);
    return s;
  });
  const wanted = `D:P(D;;GA;;;NU)(A;;GA;;;${me})(A;;GA;;;SY)`;
  note("P2.wanted", wanted);
  await safe("P2.setDacl", () => {
    const { h, err } = open(name, READ_CONTROL | WRITE_DAC);
    if (h === INVALID) return `open error ${err}`;
    const e = setDacl(h, wanted);
    close(h);
    return e === 0 ? "ok" : `SetSecurityInfo error ${e}`;
  });
  // Hold many connections so libuv has to create instances after the DACL change.
  const held: net.Socket[] = [];
  await safe("P2.heldConnections", async () => {
    for (let n = 0; n < 12; n++) {
      held.push(await new Promise<net.Socket>((res, rej) => {
        const c = net.connect(name, () => res(c));
        c.once("error", rej);
      }));
    }
    return held.length;
  });
  await safe("P2.sddlOnLaterInstance", () => {
    const { h, err } = open(name, READ_CONTROL | GENERIC_READ | GENERIC_WRITE);
    if (h === INVALID) return `open error ${err}`;
    const s = sddlOf(h);
    close(h);
    return s;
  });
  await safe("P2.echoAfterDacl", () => echo(name, "still-works"));
  for (const [k, p] of [["P2.remoteSecure", base], ["P2.remoteDefault", `${base}-default`]] as const) {
    await safe(k, () => {
      const { h, err } = open(`\\\\localhost\\pipe\\${p}`, GENERIC_READ | GENERIC_WRITE);
      close(h);
      return h === INVALID ? `denied/failed ${err}` : "CONNECTED";
    });
  }

  await safe("P3.child", () => new Promise((res) => {
    const args = out.compiled ? ["--child", name] : [join(import.meta.dir, "pipe.ts"), "--child", name];
    const c = spawn(process.execPath, args, { windowsHide: true });
    let s = "";
    c.stdout.on("data", (d) => (s += d));
    c.stderr.on("data", (d) => (s += d));
    c.on("exit", (code) => {
      try {
        res({ code, ...JSON.parse(s) });
      } catch {
        res({ code, raw: s });
      }
    });
  }));

  if (process.argv.includes("--cross-user")) {
    await safe("P2.crossUser", () => new Promise((res) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "cross-user.ps1"), "-Secure", base, "-Default", `${base}-default`], { windowsHide: true });
      let s = "";
      ps.stdout.on("data", (d) => (s += d));
      ps.stderr.on("data", (d) => (s += d));
      ps.on("exit", () => res(s.split(/\r?\n/).filter(Boolean)));
    }));
  }

  await safe("power.SetThreadExecutionState", () => {
    const prev = k32.SetThreadExecutionState(0x8000_0001);
    const back = k32.SetThreadExecutionState(0x8000_0000);
    return { prev, back, ok: prev !== 0 && back !== 0 };
  });

  for (const c of held) c.destroy();
  server.close();
  other.close();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

await main();
