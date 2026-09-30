import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, helpText, COMMANDS } from "../../src/args";
import { devSwitchesUsed, refuseDevSwitches, resolveTarget } from "../../src/connect";
import {
  auditTokenPid,
  parseWindowsRequirement,
  peerRefusal,
  verifyPeer,
  verifyWindowsPeer,
  type PeerInspector,
  type PeerVerdict,
  type WindowsPeerInspector,
} from "../../src/peer";
import {
  CredentialManagerTokenStore,
  credentialFailure,
  credentialTarget,
  FileTokenStore,
  KeychainTokenStore,
  keychainAccount,
  keychainFailure,
  type TokenStore,
} from "../../src/token-store";
import { Waiting, mmss } from "../../src/waiting";
import { CliError } from "../../src/exit";
import { contentText, headLines, inputSummary, partialStdout, table, truncate } from "../../src/format";
import { matchPrefix } from "../../src/ids";
import { main, roleFor } from "../../src/main";
import { Output, colorWanted, colors } from "../../src/output";
import { EventRenderer, resendCommand } from "../../src/render";
import type { Io } from "../../src/context";
import { alwaysGrant, inlineAnswer, questionResponse } from "../../src/commands/input";
import type { ApprovalPrompt, QuestionPrompt } from "@homerun/core";
import { EndpointError, newPipeName } from "@homerun/client";
import {
  closeHandle,
  credWrite,
  currentUserSid,
  openPipe,
  pipeSddl,
  privateDirSddl,
  privateFileSddl,
  processImagePath,
  READ_CONTROL,
  setPathProtectedDacl,
  setProtectedDacl,
  WRITE_DAC,
} from "@homerun/win32";
import { windowsInspector } from "../../src/windows";

const WIN = process.platform === "win32";

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof CliError ? e.code : -1;
  }
  return 0;
};

describe("arguments", () => {
  test("commands, groups, and options before or after the command words", () => {
    expect(parse(["status"]).command.name).toBe("status");
    expect(parse(["threads"]).command.name).toBe("threads list");
    expect(parse(["--json", "threads", "list", "-n", "5"])).toMatchObject({ command: { name: "threads list" }, values: { json: true, limit: "5" } });
    expect(parse(["send", "--new", "--title", "t", "hi there"])).toMatchObject({ values: { new: true, title: "t" }, positionals: ["hi there"] });
    expect(parse(["send", "abcd", "--", "--not-an-option"]).positionals).toEqual(["abcd", "--not-an-option"]);
    expect(parse(["send", "abcd", "-"]).positionals).toEqual(["abcd", "-"]);
    expect(parse([]).command.name).toBe("help");
    expect(parse(["threads", "show", "--help"])).toMatchObject({ command: { name: "help" }, positionals: ["threads", "show"] });
  });

  test("usage errors are 64", () => {
    expect(code(() => parse(["nope"]))).toBe(64);
    expect(code(() => parse(["threads", "nope"]))).toBe(64);
    expect(code(() => parse(["status", "extra"]))).toBe(64);
    expect(code(() => parse(["watch"]))).toBe(64);
    expect(code(() => parse(["status", "--bogus"]))).toBe(64);
    expect(code(() => parse(["chat", "--json"]))).toBe(64);
  });

  test("help lists every command", () => {
    const h = helpText();
    for (const c of COMMANDS) expect(h).toContain(c.name);
    expect(helpText("threads")).toContain("homerun threads show THREAD");
  });
});

describe("development switches", () => {
  test("are recognised from flags and the environment", () => {
    expect(devSwitchesUsed({ socket: "/s", "dev-token-file": "/t" }, { HOMERUN_SOCKET: "/x" })).toEqual(["--socket", "HOMERUN_SOCKET", "--dev-token-file"]);
    expect(devSwitchesUsed({}, { HOMERUN_DATA_DIR: "/d" })).toEqual([]);
  });

  test("a release build refuses them with 64; a development build takes them", () => {
    expect(code(() => refuseDevSwitches("release", { socket: "/s" }, {}))).toBe(64);
    expect(code(() => refuseDevSwitches("release", {}, { HOMERUN_SOCKET: "/s" }))).toBe(64);
    expect(code(() => refuseDevSwitches("release", {}, {}))).toBe(0);
    expect(code(() => refuseDevSwitches("development", { socket: "/s" }, {}))).toBe(0);
  });
});

describe("ids", () => {
  const ids = ["abcd1234-0000-4000-8000-000000000000", "abce5678-0000-4000-8000-000000000000"];
  test("a unique prefix of 4 or more, or a full id", () => {
    expect(matchPrefix("thread", "abcd", ids)).toBe(ids[0]!);
    expect(matchPrefix("thread", "ABCE56", ids)).toBe(ids[1]!);
    expect(matchPrefix("thread", "ffffffff-0000-4000-8000-000000000000", ids)).toBe("ffffffff-0000-4000-8000-000000000000");
    expect(code(() => matchPrefix("thread", "abc", ids))).toBe(64);
    expect(code(() => matchPrefix("thread", "abc0", ids))).toBe(1);
    expect(code(() => matchPrefix("thread", "abc", ["abc1", "abc2"]))).toBe(64);
    expect(code(() => matchPrefix("thread", "zzzz", ids))).toBe(64);
  });
});

describe("format", () => {
  test("truncation, line heads, tool inputs and tables", () => {
    expect(truncate("héllo wörld", 6)).toBe("héllo…");
    expect(headLines("a\nb\nc\nd\n", 2)).toEqual({ lines: ["a", "b"], more: 2 });
    expect(headLines("", 3)).toEqual({ lines: [], more: 0 });
    expect(inputSummary({ kind: "inline", value: { command: "ls  -la\n/tmp" } })).toBe("ls -la /tmp");
    expect(inputSummary({ kind: "inline", value: { a: 1 } })).toBe('{"a":1}');
    expect(inputSummary({ kind: "blob", sha256: "0".repeat(64), size: 5000, preview: "big", expired: false })).toBe("big [4.9 KB]");
    expect(table([["A", "BB"], ["ccc", "d"]])).toBe("A    BB\nccc  d\n");
    expect(contentText({ kind: "inline", value: { stdout: "out\n", stderr: "err", interrupted: false } })).toBe("out\nerr");
    expect(contentText({ kind: "inline", value: { stdout: "out", stderr: "" } })).toBe("out");
    const preview = JSON.stringify({ stdout: "a\nb \"q\" \u00e9\n" + "x".repeat(50) }).slice(0, 30);
    expect(contentText({ kind: "blob", sha256: "0".repeat(64), size: 9000, preview, expired: false })).toBe('a\nb "q" é\n' + "x".repeat(5));
    expect(partialStdout('{"stdout":"ab\\')).toBe("ab");
    expect(partialStdout('{"stdout":"ab\\u00')).toBe("ab");
    expect(partialStdout('{"other":1}')).toBeNull();
  });

  test("colour: only when wanted and on a terminal; never in JSON", () => {
    expect(colorWanted({}, false)).toBe(true);
    expect(colorWanted({ NO_COLOR: "1" }, false)).toBe(false);
    expect(colorWanted({}, true)).toBe(false);
    const tty = { write() {}, isTTY: true };
    expect(new Output(tty, tty, false, true).c.red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(new Output(tty, tty, true, true).c.red("x")).toBe("x");
    expect(new Output({ write() {} }, tty, false, true).c.red("x")).toBe("x");
  });
});

function capture() {
  let out = "";
  let err = "";
  const o = new Output({ write: (s) => void (out += s) }, { write: (s) => void (err += s) }, false, false);
  return { o, out: () => out, err: () => err };
}

const base = { thread_id: "11111111-0000-4000-8000-000000000000", run_id: "22222222-0000-4000-8000-000000000000", ts: 1 } as const;
const delta = (text: string, index: number) => ({ ...base, after_seq: 1, type: "message.delta", payload: { message_id: "m1", index, text } }) as never;
const final = (text: string, seq = 2) => ({ ...base, seq, type: "message.final", payload: { message_id: "m1", role: "assistant", text } }) as never;

describe("rendering", () => {
  test("streamed deltas, then only the rest of the final message", () => {
    const k = capture();
    const r = new EventRenderer(k.o, { role: "cli_dev", transcript: false });
    r.render(delta("Hel", 0));
    r.render(delta("lo", 1));
    r.render(final("Hello, world"));
    expect(k.out()).toBe("Hello, world\n");
  });

  test("a final message that differs from its deltas is printed whole on a new line", () => {
    const k = capture();
    const r = new EventRenderer(k.o, { role: "cli_dev", transcript: false });
    r.render(delta("Draft", 0));
    r.render(final("Rewritten"));
    expect(k.out()).toBe("Draft\nRewritten\n");
  });

  test("progress goes to stderr and ends an open line; transcripts label messages", () => {
    const k = capture();
    const r = new EventRenderer(k.o, { role: "cli", transcript: false });
    r.render(delta("part", 0));
    r.render({ ...base, seq: 3, type: "run.end", payload: { state: "succeeded", outcome: null, error: null, authority: "full", cost_usd: 0.5 } } as never);
    expect(k.out()).toBe("part\n");
    expect(k.err()).toBe("— done · $0.5000\n");

    const t = capture();
    const tr = new EventRenderer(t.o, { role: "cli", transcript: true });
    tr.render({ ...base, seq: 1, type: "user.message", payload: { client_msg_id: "c", text: "hi", origin: { device_id: "d", surface: "ios" }, disposition: "started_run" } } as never);
    tr.render(final("hello"));
    expect(t.out()).toBe("you · ios› hi\nclaude› hello\n");
  });

  test("a held message the run never delivered is shown as not delivered, with a resend command (§5.7)", () => {
    const msg = (seq: number, text: string, disposition: string, client_msg_id = `c${seq}`) =>
      ({ ...base, seq, type: "user.message", payload: { client_msg_id, text, origin: { device_id: "d", surface: "cli" }, disposition } }) as never;
    const end = (seq: number, state: string) => ({ ...base, seq, type: "run.end", payload: { state, outcome: null, error: null, authority: "full", cost_usd: null } }) as never;
    const t = capture();
    const r = new EventRenderer(t.o, { role: "cli", transcript: true, own: new Set(["c2"]) });
    r.render(msg(1, "go", "started_run"));
    r.render(msg(2, "it's done?", "held", "c2"));
    r.render({ ...base, seq: 3, type: "run.cancelled", payload: { by: null, reason: "user" } } as never);
    r.render(end(4, "cancelled"));
    expect(t.out()).toBe(
      [
        "you› go",
        "— stopping (requested)",
        "— cancelled",
        "  ✗ not delivered: it's done? (sent while the run waited; the run ended first)",
        "    resend it: homerun send 11111111 'it'\\''s done?'",
        "",
      ].join("\n"),
    );

    // Delivered with the answer: nothing to report.
    const d = capture();
    const rd = new EventRenderer(d.o, { role: "cli", transcript: true });
    for (const e of [msg(1, "go", "started_run"), msg(2, "status?", "held"), { ...base, seq: 3, type: "run.resumed", payload: { reason: "ambiguity_resolved" } } as never, end(4, "succeeded")]) rd.render(e);
    expect(d.out()).not.toContain("not delivered");

    expect(resendCommand(base.thread_id, "-v please")).toBe("homerun send 11111111 -- '-v please'");
    expect(resendCommand(base.thread_id, "two\nlines")).toBe("homerun send 11111111 TEXT");
  });

  test("own messages are not echoed", () => {
    const k = capture();
    const r = new EventRenderer(k.o, { role: "cli", transcript: false, own: new Set(["c"]) });
    r.render({ ...base, seq: 1, type: "user.message", payload: { client_msg_id: "c", text: "hi", origin: { device_id: "d", surface: "cli" }, disposition: "started_run" } } as never);
    expect(k.out() + k.err()).toBe("");
  });
});

describe("answers (§5.6)", () => {
  const q = (question: string, labels: string[], o: { multi?: boolean; free?: boolean } = {}) => ({
    question,
    options: labels.map((label) => ({ label })),
    multi_select: !!o.multi,
    allow_freeform: !!o.free,
  });
  const one: QuestionPrompt = { type: "question", questions: [q("Which?", ["Blue", "Green"])] };
  const two: QuestionPrompt = { type: "question", questions: [q("Which?", ["Blue", "Green"]), q("Also?", ["A", "B", "C"], { multi: true, free: true })] };
  const approval: ApprovalPrompt = {
    type: "approval",
    tool: "Bash",
    tool_call_id: "t1" as ApprovalPrompt["tool_call_id"],
    class: "destructive",
    input: { kind: "inline", value: { command: "make clean" } },
    reason: "not_allowlisted",
    offer_always: true,
    suggested_grant: { tool: "Bash", pattern: "make clean", class: "write" },
  };

  test("--choice by label (any case) or number; N= picks the question when there are several", () => {
    expect(questionResponse(one, ["green"], [])).toEqual({ type: "question", answers: [{ selected: ["Green"] }] });
    expect(questionResponse(one, ["1"], [])).toEqual({ type: "question", answers: [{ selected: ["Blue"] }] });
    expect(questionResponse(two, ["1=Blue", "2=A", "2=3"], ["2=and more"])).toEqual({
      type: "question",
      answers: [{ selected: ["Blue"] }, { selected: ["A", "C"], text: "and more" }],
    });
    expect(code(() => questionResponse(two, ["Blue"], []))).toBe(64);
    expect(code(() => questionResponse(two, ["1=Blue"], []))).toBe(64);
    expect(code(() => questionResponse(one, ["Blue", "Green"], []))).toBe(64);
    expect(code(() => questionResponse(one, ["Red"], []))).toBe(64);
    expect(code(() => questionResponse(one, [], ["my own"]))).toBe(64);
  });

  test("--always confirms the suggested grant, with the user's edits", () => {
    expect(alwaysGrant(approval, {})).toEqual({ tool: "Bash", pattern: "make clean", class: "write" });
    expect(alwaysGrant(approval, { pattern: "make *", class: "read" })).toEqual({ tool: "Bash", pattern: "make *", class: "read" });
    expect(code(() => alwaysGrant(approval, { class: "destructive" }))).toBe(64);
    expect(code(() => alwaysGrant({ ...approval, offer_always: false, suggested_grant: undefined }, {}))).toBe(1);
  });

  test("chat reads a line as an answer only when it is one", () => {
    expect(inlineAnswer(approval, "y")).toEqual({ type: "approval", decision: "allow" });
    expect(inlineAnswer(approval, " No ")).toEqual({ type: "approval", decision: "deny" });
    expect(inlineAnswer(approval, "always")).toEqual({ type: "approval", decision: "allow_always", grant: approval.suggested_grant });
    expect(inlineAnswer({ ...approval, offer_always: false }, "always")).toBeNull();
    expect(inlineAnswer(approval, "what does it delete?")).toBeNull();
    expect(inlineAnswer(one, "2")).toEqual({ type: "question", answers: [{ selected: ["Green"] }] });
    expect(inlineAnswer(one, "blue")).toEqual({ type: "question", answers: [{ selected: ["Blue"] }] });
    expect(inlineAnswer(one, "neither")).toBeNull();
    expect(inlineAnswer({ type: "question", questions: [q("Which?", ["A", "B"], { multi: true, free: true })] }, "A, 2")).toEqual({ type: "question", answers: [{ selected: ["A", "B"] }] });
    expect(inlineAnswer({ type: "question", questions: [q("Which?", ["A", "B"], { free: true })] }, "neither")).toEqual({ type: "question", answers: [{ selected: [], text: "neither" }] });
    expect(inlineAnswer(two, "1")).toBeNull();
    expect(inlineAnswer({ type: "ambiguous_tool_call", tool: "Bash", tool_call_id: "t" as ApprovalPrompt["tool_call_id"], class: "destructive", input: { kind: "inline", value: {} } }, "not run")).toEqual({
      type: "ambiguous_tool_call",
      outcome: "not_run",
    });
  });
});

describe("a release build (in process)", () => {
  function io(argv: string[], env: Record<string, string>): Io & { out: () => string; err: () => string } {
    let out = "";
    let err = "";
    return {
      argv,
      env,
      channel: "release",
      stdout: { write: (s) => void (out += s) },
      stderr: { write: (s) => void (err += s) },
      stdin: process.stdin,
      onInterrupt: () => () => {},
      out: () => out,
      err: () => err,
    };
  }

  /**
   * A socket that counts connections and bytes, and a token store that counts reads. On Windows,
   * a pipe published in `run\endpoint` as homerund publishes it, in a directory only we can use.
   */
  function listener(dir: string) {
    const run = join(dir, "run");
    mkdirSync(run, { mode: 0o700 });
    if (WIN) setPathProtectedDacl(run, privateDirSddl(currentUserSid()));
    const seen = { connections: 0, bytes: 0 };
    const path = WIN ? newPipeName() : join(run, "homerund.sock");
    const l = Bun.listen({
      unix: path,
      socket: { open: () => void seen.connections++, data: (_s, d) => void (seen.bytes += d.length) },
    });
    if (WIN) writeFileSync(join(run, "endpoint"), path);
    return { seen, stop: () => l.stop(true) };
  }

  test("without a compiled-in code requirement it refuses with 77 before reading or sending the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-rel-"));
    const l = listener(dir);
    const store = new MemoryStore("A".repeat(43));
    try {
      for (const argv of [["status"], ["threads", "list"], ["send", "--new", "hi"], ["answer", "abcd1234", "--choice", "Blue"], ["login"], ["logout"]]) {
        const x = io(argv, { HOMERUN_DATA_DIR: dir });
        expect(await main(x, { store, inspector: () => fakeInspector(), windowsInspector: () => fakeWindows(), platform: WIN ? "win32" : "darwin" })).toBe(77);
        expect(x.err()).toContain("homerund's identity could not be verified, so the token was not used: this build has no code requirement");
      }
      await Bun.sleep(20);
      expect(l.seen.connections).toBeGreaterThan(0);
      expect(l.seen.bytes).toBe(0);
      expect(store.reads).toBe(0);
      const v = io(["version"], { HOMERUN_DATA_DIR: dir });
      expect(await main(v)).toBe(0);
      expect(v.out()).toContain("(release)");
      expect(await main(io(["help"], {}))).toBe(0);
    } finally {
      l.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("answers questions only: approvals, grants and \"Did this happen?\" are refused with 77 before connecting (§5.2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-rel-"));
    const l = listener(dir);
    try {
      for (const argv of [["approve", "abcd1234"], ["deny", "abcd1234"], ["answer", "abcd1234", "--completed"], ["answer", "abcd1234", "--not-run"], ["grants", "add", "abcd", "--tool", "Bash", "--class", "read"]]) {
        const x = io(argv, { HOMERUN_DATA_DIR: dir });
        expect(await main(x)).toBe(77);
        expect(x.err()).toContain("the release CLI answers questions only");
      }
      await Bun.sleep(20);
      expect(l.seen.connections).toBe(0);
    } finally {
      l.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses development switches with 64, whatever the command", async () => {
    for (const [argv, env] of [
      [["status", "--socket", "/tmp/x.sock"], {}],
      [["version", "--dev-token-file", "/tmp/t"], {}],
      [["status"], { HOMERUN_SOCKET: "/tmp/x.sock" }],
      [["status", "--dev-role", "cli"], {}],
      [["status", "--dev-token-store", "/tmp/t"], {}],
      [["status", "--dev-skip-peer-check"], {}],
      [["status", "--dev-peer-requirement", "anchor apple"], {}],
      [["login", "--dev-keychain", "/tmp/k"], {}],
      [["status"], { HOMERUN_DEV_TOKEN_STORE: "/tmp/t" }],
      [["logout"], { HOMERUN_DEV_SKIP_PEER_CHECK: "1" }],
    ] as const) {
      const x = io([...argv], { ...env });
      expect(await main(x)).toBe(64);
      expect(x.err()).toContain("is only available in development builds; this is a release build");
    }
  });
});

describe("the release role from a development build", () => {
  test("--dev-role picks the role; the release-flow switches need it; login and logout need it", async () => {
    expect(roleFor("release", {})).toBe("cli");
    expect(roleFor("development", {})).toBe("cli_dev");
    expect(roleFor("development", { "dev-role": "cli" })).toBe("cli");
    expect(code(() => roleFor("development", { "dev-role": "shell" }))).toBe(64);
    expect(code(() => roleFor("development", { "dev-token-store": "/tmp/t" }))).toBe(64);
    let err = "";
    const x: Io = { argv: ["login"], env: {}, channel: "development", stdout: { write() {} }, stderr: { write: (s) => void (err += s) }, stdin: process.stdin, onInterrupt: () => () => {} };
    expect(await main(x)).toBe(64);
    expect(err).toContain("login is for the release CLI");
  });
});

class MemoryStore implements TokenStore {
  readonly where = "memory";
  reads = 0;
  constructor(public token: string | null = null) {}
  read() {
    this.reads++;
    return this.token;
  }
  write(t: string) {
    this.token = t;
  }
  delete() {
    const had = this.token !== null;
    this.token = null;
    return had;
  }
}

/** Audit token with pid 4242 in val[5]. */
const audit = (pid: number) => Uint32Array.from([0, 501, 501, 501, 501, pid, 0, 1]);

function fakeInspector(o: Partial<PeerInspector> = {}): PeerInspector {
  return {
    ownUid: () => 501,
    peerUid: () => 501,
    peerPid: () => 4242,
    peerAuditToken: () => audit(4242),
    checkRequirement: () => 0,
    ...o,
  };
}

describe("the peer check (§5.2)", () => {
  const REQ = 'identifier "com.angilyu.homerun.homerund"';
  const check = (o: Partial<PeerInspector>, req: string | undefined = REQ, platform = "darwin", fd: number | null = 7) => verifyPeer(fd, req, platform, () => fakeInspector(o));

  test("passes when the uid, pid, audit token and code requirement all agree", async () => {
    let asked: [Uint32Array, string] | null = null;
    expect(await check({ checkRequirement: (t, r) => ((asked = [t, r]), 0) })).toEqual({ ok: true, pid: 4242 });
    expect(asked![1]).toBe(REQ);
    expect(auditTokenPid(asked![0])).toBe(4242);
  });

  test("fails closed", async () => {
    const cases: [string, Promise<PeerVerdict>][] = [
      ["no code requirement", verifyPeer(7, undefined, "darwin", () => fakeInspector())],
      ["no code requirement", check({}, "")],
      ["only be checked on macOS", check({}, REQ, "linux")],
      ["no file descriptor", check({}, REQ, "darwin", null)],
      ["another user (uid 0)", check({ peerUid: () => 0 })],
      ["pid and audit token disagree", check({ peerPid: () => 4243 })],
      ["pid and audit token disagree", check({ peerPid: () => 0, peerAuditToken: () => audit(0) })],
      ["audit token is malformed", check({ peerAuditToken: () => new Uint32Array(4) })],
      ["not Homerun's homerund", check({ checkRequirement: () => -67050 })],
      ["is not signed", check({ checkRequirement: () => -67062 })],
      ["OSStatus -67030", check({ checkRequirement: () => -67030 })],
      ["the check failed: getsockopt LOCAL_PEERTOKEN failed", check({ peerAuditToken: () => { throw new Error("getsockopt LOCAL_PEERTOKEN failed"); } })],
    ];
    for (const [why, p] of cases) {
      const v = await p;
      expect(v.ok).toBe(false);
      expect(v.ok ? "" : v.why).toContain(why);
    }
    const loading = await verifyPeer(7, REQ, "darwin", () => Promise.reject(new Error("dlopen failed")));
    expect(loading).toEqual({ ok: false, why: "the check failed: dlopen failed" });
    expect(peerRefusal("x").code).toBe(77);
  });
});

const ME = "S-1-5-21-1-2-3-1001";
const OTHER = "S-1-5-21-1-2-3-1002";
const HASH = "ab".repeat(32);

/** A pipe that is homerund's: private to ME, served by ME's process 4242 running homerund.exe. */
function fakeWindows(o: Partial<WindowsPeerInspector> = {}, log: string[] = []): WindowsPeerInspector {
  return {
    ownSid: () => ME,
    open: async (p) => (log.push(`open ${p}`), 99n),
    close: (h) => void log.push(`close ${h}`),
    pipeSecurity: () => ({
      owner: ME,
      dacl: {
        protected: true,
        aces: [
          { type: 1, flags: 0, mask: 0x10000000, sid: "S-1-5-2" },
          { type: 0, flags: 0, mask: 0x10000000, sid: ME },
          { type: 0, flags: 0, mask: 0x10000000, sid: "S-1-5-18" },
        ],
      },
    }),
    serverPid: () => 4242,
    processSid: () => ME,
    imagePath: () => "C:\\Program Files\\Homerun\\homerund.exe",
    sha256: () => HASH,
    authenticode: () => ({ status: 0, subject: "Wenjing Yu" }),
    ...o,
  };
}

describe("the peer check on Windows (§5.2)", () => {
  const PIPE = "\\\\.\\pipe\\homerun-" + "0".repeat(32);
  const check = (o: Partial<WindowsPeerInspector>, req: string | undefined = `sha256:${HASH}`) => verifyWindowsPeer(PIPE, req, () => fakeWindows(o));

  test("requirements: sha256 of the image, or an Authenticode signer", () => {
    expect(parseWindowsRequirement(`sha256:${HASH.toUpperCase()}`)).toEqual({ kind: "sha256", hex: HASH });
    expect(parseWindowsRequirement("authenticode:Wenjing Yu")).toEqual({ kind: "authenticode", subject: "Wenjing Yu" });
    for (const bad of ["", "sha256:abc", `sha256:${HASH}0`, "authenticode:", "authenticode: x", 'identifier "com.angilyu.homerun.homerund"'])
      expect(parseWindowsRequirement(bad)).toBeNull();
  });

  test("passes, on its own handle, when the pipe, the server's user and its image all agree", async () => {
    const log: string[] = [];
    expect(await verifyWindowsPeer(PIPE, `sha256:${HASH}`, () => fakeWindows({}, log))).toEqual({ ok: true, pid: 4242 });
    expect(log).toEqual([`open ${PIPE}`, "close 99"]);
    expect(await check({}, "authenticode:Wenjing Yu")).toEqual({ ok: true, pid: 4242 });
  });

  test("fails closed", async () => {
    const sd = fakeWindows().pipeSecurity(0n);
    const aces = sd.dacl!.aces;
    const cases: [string, Promise<PeerVerdict>][] = [
      ["no code requirement", verifyWindowsPeer(PIPE, undefined, () => fakeWindows())],
      ["no code requirement", check({}, "")],
      ["not a Windows one", check({}, 'identifier "com.angilyu.homerun.homerund"')],
      ["not a Windows one", check({}, "sha256:abc")],
      ["not private to this user", check({ pipeSecurity: () => ({ ...sd, dacl: { protected: false, aces } }) })],
      ["not private to this user", check({ pipeSecurity: () => ({ ...sd, dacl: { protected: true, aces: aces.slice(1) } }) })],
      ["not private to this user", check({ pipeSecurity: () => ({ ...sd, dacl: { protected: true, aces: [...aces, { type: 0, flags: 0, mask: 0x80000000, sid: "S-1-1-0" }] } }) })],
      ["not private to this user", check({ pipeSecurity: () => ({ ...sd, dacl: null }) })],
      ["not private to this user", check({ pipeSecurity: () => ({ ...sd, owner: OTHER }) })],
      ["no server process", check({ serverPid: () => 0 })],
      [`another user (${OTHER})`, check({ processSid: () => OTHER })],
      ["is not Homerun's homerund", check({ sha256: () => "cd".repeat(32) })],
      ["is not signed", check({ authenticode: () => ({ status: 0x800b0100, subject: null }) }, "authenticode:Wenjing Yu")],
      ["failed the Authenticode check (0x80096010)", check({ authenticode: () => ({ status: 0x80096010 | 0, subject: null }) }, "authenticode:Wenjing Yu")],
      ["signed by Someone Else, not Homerun", check({ authenticode: () => ({ status: 0, subject: "Someone Else" }) }, "authenticode:Wenjing Yu")],
      // The signer's name must equal the requirement's exactly: no prefix, suffix, case or space
      // lookalikes, either way round.
      ...(
        [
          ["Wenjing", "Wenjing Yu"],
          ["Yu", "Wenjing Yu"],
          ["Wenjing Yu", "Wenjing Yu Ltd"],
          ["Wenjing Yu", "Evil Wenjing Yu"],
          ["Wenjing Yu", "Wenjing"],
          ["Wenjing Yu", "wenjing yu"],
          ["Wenjing Yu", "Wenjing Yu "],
          ["Wenjing Yu", "Wenjing  Yu"],
          ["Wenjing Yu", "Wenjing Yu\0"],
          ["Wenjing Yu", ""],
        ] as const
      ).map(([want, got]): [string, Promise<PeerVerdict>] => [
        `signed by ${got || "an unnamed signer"}, not Homerun`,
        check({ authenticode: () => ({ status: 0, subject: got || null }) }, `authenticode:${want}`),
      ]),
      ["the check failed: CreateFileW failed (Win32 error 2)", check({ open: () => Promise.reject(new Error("CreateFileW failed (Win32 error 2)")) })],
      ["the check failed: OpenProcess failed (Win32 error 5)", check({ imagePath: () => { throw new Error("OpenProcess failed (Win32 error 5)"); } })],
    ];
    for (const [why, p] of cases) {
      const v = await p;
      expect([why, v.ok]).toEqual([why, false]);
      expect(v.ok ? "" : v.why).toContain(why);
    }
    expect(await verifyWindowsPeer(PIPE, `sha256:${HASH}`, () => Promise.reject(new Error("LoadLibrary failed")))).toEqual({
      ok: false,
      why: "the check failed: LoadLibrary failed",
    });
    const log: string[] = [];
    await verifyWindowsPeer(PIPE, `sha256:${HASH}`, () => fakeWindows({ processSid: () => OTHER }, log));
    expect(log).toContain("close 99");
    expect(peerRefusal("x", "win32").hint).toContain("Start menu");
  });

  test("the pipe name comes from the endpoint the runtime published, when first needed", () => {
    let reads = 0;
    const at = (e: () => string) => resolveTarget({}, { HOMERUN_DATA_DIR: "C:\\hr" }, "win32", (data) => (reads++, expect(data).toBe("C:\\hr"), e()));
    const t = at(() => PIPE);
    expect(t.tokenPath).toBe("C:\\hr\\run\\dev-token");
    expect(reads).toBe(0);
    expect([t.socketPath, t.socketPath, reads]).toEqual([PIPE, PIPE, 1]);
    const fails = (reason: "missing" | "insecure" | "malformed") => code(() => at(() => { throw new EndpointError("x", reason); }).socketPath);
    expect([fails("missing"), fails("insecure"), fails("malformed")]).toEqual([69, 77, 77]);
    const explicit = resolveTarget({ socket: "\\\\.\\pipe\\x", "dev-token-file": "C:\\t" }, {}, "win32", () => { throw new Error("not read"); });
    expect([explicit.socketPath, explicit.tokenPath]).toEqual(["\\\\.\\pipe\\x", "C:\\t"]);
  });
});

(WIN ? describe : describe.skip)("the peer check against a real pipe (Windows)", () => {
  async function pipe(lock: boolean) {
    const name = newPipeName();
    const l = Bun.listen({ unix: name, socket: { data() {} } });
    if (lock) {
      const h = await openPipe(name, READ_CONTROL | WRITE_DAC);
      try {
        setProtectedDacl(h, pipeSddl(currentUserSid()));
      } finally {
        closeHandle(h);
      }
    }
    return { name, stop: () => l.stop(true) };
  }
  const self = () => `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`;

  test("a private pipe served by this process passes a requirement on its image; anything else is refused", async () => {
    const p = await pipe(true);
    try {
      expect(await verifyWindowsPeer(p.name, self(), windowsInspector)).toEqual({ ok: true, pid: process.pid });
      const wrong = await verifyWindowsPeer(p.name, `sha256:${"0".repeat(64)}`, windowsInspector);
      expect(wrong.ok ? "" : wrong.why).toContain("is not Homerun's homerund");
      // Bun is not signed as Homerun, whether or not it is signed at all.
      const signed = await verifyWindowsPeer(p.name, "authenticode:Homerun Test Signer", windowsInspector);
      expect(signed.ok).toBe(false);
    } finally {
      p.stop();
    }
  });

  /**
   * A real Authenticode signature: PowerShell 7 (signed by Microsoft Corporation) serves a private
   * pipe. The check passes only for exactly its signer's name, and refuses any other signer and
   * every lookalike of that name.
   */
  test("a pipe served by a Microsoft-signed program passes only a requirement naming exactly its signer", async () => {
    const pwsh = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    if (!existsSync(pwsh)) {
      if (process.env.CI) throw new Error(`CI runners have PowerShell 7, but ${pwsh} is missing`);
      return void console.log(`no ${pwsh}; skipped`);
    }
    const name = newPipeName();
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-pwsh-"));
    const script = join(dir, "serve.ps1");
    // Enough listening instances for every connection below: each check connects once.
    writeFileSync(
      script,
      [
        "$n = $args[0]",
        "$s = 1..16 | ForEach-Object { [System.IO.Pipes.NamedPipeServerStream]::new($n, 'InOut', -1, 'Byte', 'Asynchronous') }",
        "$w = $s | ForEach-Object { $_.WaitForConnectionAsync() }",
        "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
        "[void][Console]::In.ReadLine()",
      ].join("\r\n"),
    );
    const proc = Bun.spawn([pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, name.replace(/^\\\\\.\\pipe\\/, "")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      const deadline = Date.now() + 30_000;
      while (!out.includes("ready")) {
        const r = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
        if (!r || r.done) throw new Error(`PowerShell never served the pipe: ${JSON.stringify(out)}`);
        out += new TextDecoder().decode(r.value);
      }
      const h = await openPipe(name, READ_CONTROL | WRITE_DAC);
      try {
        setProtectedDacl(h, pipeSddl(currentUserSid()));
      } finally {
        closeHandle(h);
      }
      const image = processImagePath(proc.pid);
      const verdict = (subject: string) => verifyWindowsPeer(name, `authenticode:${subject}`, windowsInspector);
      expect(await verdict("Microsoft Corporation")).toEqual({ ok: true, pid: proc.pid });
      for (const other of ["Homerun", "Microsoft", "Corporation", "Microsoft Corp", "Microsoft Corporation Ltd", "Not Microsoft Corporation", "microsoft corporation", "MICROSOFT CORPORATION"]) {
        const v = await verdict(other);
        expect([other, v.ok ? "" : v.why]).toEqual([other, `process ${proc.pid} (${image}) is signed by Microsoft Corporation, not Homerun`]);
      }
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a pipe with the default DACL is refused, and so is a name nobody serves", async () => {
    const p = await pipe(false);
    try {
      const v = await verifyWindowsPeer(p.name, self(), windowsInspector);
      expect(v.ok ? "" : v.why).toContain("not private to this user");
    } finally {
      p.stop();
    }
    const none = await verifyWindowsPeer(newPipeName(), self(), windowsInspector);
    expect(none.ok ? "" : none.why).toContain("the check failed");
  });
});

describe("the token store", () => {
  test("a private file: round trip, replace, delete; readable by others or malformed is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-store-"));
    const f = join(dir, "token");
    const open = () => (WIN ? setPathProtectedDacl(f, `D:P(A;;FA;;;${currentUserSid()})(A;;FR;;;WD)`) : chmodSync(f, 0o644));
    const close = () => (WIN ? setPathProtectedDacl(f, privateFileSddl(currentUserSid())) : chmodSync(f, 0o600));
    try {
      const s = new FileTokenStore(f);
      expect(s.read()).toBeNull();
      s.write("A".repeat(43));
      if (!WIN) expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(s.read()).toBe("A".repeat(43));
      s.write("B".repeat(43));
      expect(s.read()).toBe("B".repeat(43));
      open();
      expect(code(() => s.read())).toBe(77);
      close();
      writeFileSync(f, "not a token");
      expect(s.read()).toBeNull();
      expect(s.delete()).toBe(true);
      expect(s.delete()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file's privacy check is the shared one, per platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-store-"));
    try {
      const f = join(dir, "token");
      writeFileSync(f, "A".repeat(43));
      const seen: string[] = [];
      expect(new FileTokenStore(f, "win32", (_p, _st, platform) => (seen.push(platform), null)).read()).toBe("A".repeat(43));
      const refused = new FileTokenStore(f, "win32", () => "is not private to this user (allows S-1-1-0 (0x120089))");
      expect(code(() => refused.read())).toBe(77);
      expect(seen).toEqual(["win32"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  (WIN ? test : test.skip)("Credential Manager (Windows): round trip, replace, delete; malformed is none", () => {
    const s = new CredentialManagerTokenStore(`test:${process.pid}:${Date.now()}`);
    try {
      expect(s.read()).toBeNull();
      s.write("A".repeat(43));
      expect(s.read()).toBe("A".repeat(43));
      s.write("B".repeat(43));
      expect(s.read()).toBe("B".repeat(43));
      credWrite(credentialTarget(s.account), "x", new TextEncoder().encode("not a token"));
      expect(s.read()).toBeNull();
      expect(s.delete()).toBe(true);
      expect(s.delete()).toBe(false);
    } finally {
      s.delete();
    }
  });

  test("Credential Manager errors: no logon session is 77 with a hint, anything else is 1; only on Windows", () => {
    const none = credentialFailure("read", 1312);
    expect([none.code, none.hint]).toEqual([77, "run homerun from your own desktop session, not over a network logon"]);
    expect([credentialFailure("save", 5).code, credentialFailure("save", 5).message]).toEqual([1, "Credential Manager failed to save the token (Win32 error 5)"]);
    if (!WIN) expect(code(() => new CredentialManagerTokenStore("default").read())).toBe(77);
    expect(credentialTarget("default")).toBe("com.angilyu.homerun.cli/default");
  });

  test("one keychain item per data directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-acct-"));
    try {
      expect(keychainAccount({})).toBe("default");
      const a = keychainAccount({ HOMERUN_DATA_DIR: dir });
      expect(a).toMatch(/^data:[0-9a-f]{64}$/);
      expect(keychainAccount({ HOMERUN_DATA_DIR: join(dir, ".") })).toBe(a);
      expect(keychainAccount({ HOMERUN_DATA_DIR: join(dir, "other") })).not.toBe(a);
      expect(keychainAccount({ HOMERUN_DATA_DIR: "C:\\Users\\X\\HR" }, "win32")).toBe(keychainAccount({ HOMERUN_DATA_DIR: "c:\\users\\x\\hr" }, "win32"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keychain errors: locked is 77 with an unlock hint, refused is 77, anything else is 1", () => {
    const locked = keychainFailure("read", -25308);
    expect([locked.code, locked.hint]).toEqual([77, "unlock it first (over ssh: `security unlock-keychain`), then try again"]);
    expect(keychainFailure("read", -128).code).toBe(77);
    expect(keychainFailure("save", -25293).code).toBe(77);
    const other = keychainFailure("save", -34018);
    expect([other.code, other.message]).toEqual([1, "the keychain failed to save the token (OSStatus -34018)"]);
  });

  test("off macOS the keychain refuses rather than failing oddly", () => {
    if (process.platform === "darwin") return;
    expect(code(() => new KeychainTokenStore("default").read())).toBe(77);
  });
});

describe("waiting for approval", () => {
  test("m:ss", () => {
    expect(mmss(120_000)).toBe("2:00");
    expect(mmss(112_001)).toBe("1:53");
    expect(mmss(-5)).toBe("0:00");
  });

  test("a terminal gets a spinner redrawn in place; anything else one line in, one out", () => {
    let t = 1_000;
    let tty = "";
    const w = new Waiting({ write: (s) => void (tty += s) }, true, colors(false), () => t);
    w.start(t + 120_000);
    t += 8_000;
    expect(w.line()).toMatch(/^. Waiting for approval… 1:52$/);
    w.finish("✓ Approved.");
    expect(tty).toContain("Ctrl-C cancels.");
    expect(tty).toContain("\r\x1b[K✓ Approved.\n");

    let plain = "";
    const p = new Waiting({ write: (s) => void (plain += s) }, false, colors(false), () => 0);
    p.start(120_000);
    p.finish("✗ Denied in the Homerun app.");
    expect(plain).toBe('Homerun needs to approve this command-line tool.\n  Click "Allow" in the Homerun app. It waits up to 2:00.\n✗ Denied in the Homerun app.\n');
  });
});
