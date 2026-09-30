import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, helpText, COMMANDS } from "../../src/args";
import { devSwitchesUsed, refuseDevSwitches } from "../../src/connect";
import { auditTokenPid, peerRefusal, verifyPeer, type PeerInspector, type PeerVerdict } from "../../src/peer";
import { FileTokenStore, KeychainTokenStore, keychainAccount, keychainFailure, type TokenStore } from "../../src/token-store";
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

  /** A socket that counts connections and bytes, and a token store that counts reads. */
  function listener(dir: string) {
    mkdirSync(join(dir, "run"), { mode: 0o700 });
    const seen = { connections: 0, bytes: 0 };
    const l = Bun.listen({
      unix: join(dir, "run", "homerund.sock"),
      socket: { open: () => void seen.connections++, data: (_s, d) => void (seen.bytes += d.length) },
    });
    return { seen, stop: () => l.stop(true) };
  }

  test("without a compiled-in code requirement it refuses with 77 before reading or sending the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-rel-"));
    const l = listener(dir);
    const store = new MemoryStore("A".repeat(43));
    try {
      for (const argv of [["status"], ["threads", "list"], ["send", "--new", "hi"], ["answer", "abcd1234", "--choice", "Blue"], ["login"], ["logout"]]) {
        const x = io(argv, { HOMERUN_DATA_DIR: dir });
        expect(await main(x, { store, inspector: () => fakeInspector(), platform: "darwin" })).toBe(77);
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

describe("the token store", () => {
  test("a 0600 file: round trip, replace, delete; readable by others or malformed is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-store-"));
    try {
      const s = new FileTokenStore(join(dir, "token"));
      expect(s.read()).toBeNull();
      s.write("A".repeat(43));
      expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
      expect(s.read()).toBe("A".repeat(43));
      s.write("B".repeat(43));
      expect(s.read()).toBe("B".repeat(43));
      chmodSync(join(dir, "token"), 0o644);
      expect(code(() => s.read())).toBe(77);
      chmodSync(join(dir, "token"), 0o600);
      writeFileSync(join(dir, "token"), "not a token", { mode: 0o600 });
      expect(s.read()).toBeNull();
      expect(s.delete()).toBe(true);
      expect(s.delete()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one keychain item per data directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-acct-"));
    try {
      expect(keychainAccount({})).toBe("default");
      const a = keychainAccount({ HOMERUN_DATA_DIR: dir });
      expect(a).toMatch(/^data:[0-9a-f]{64}$/);
      expect(keychainAccount({ HOMERUN_DATA_DIR: join(dir, ".") })).toBe(a);
      expect(keychainAccount({ HOMERUN_DATA_DIR: join(dir, "other") })).not.toBe(a);
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
