import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, helpText, COMMANDS } from "../../src/args";
import { devSwitchesUsed, refuseDevSwitches } from "../../src/connect";
import { CliError } from "../../src/exit";
import { contentText, headLines, inputSummary, partialStdout, table, truncate } from "../../src/format";
import { matchPrefix } from "../../src/ids";
import { main } from "../../src/main";
import { Output, colorWanted } from "../../src/output";
import { EventRenderer } from "../../src/render";
import type { Io } from "../../src/context";

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

  test("own messages are not echoed", () => {
    const k = capture();
    const r = new EventRenderer(k.o, { role: "cli", transcript: false, own: new Set(["c"]) });
    r.render({ ...base, seq: 1, type: "user.message", payload: { client_msg_id: "c", text: "hi", origin: { device_id: "d", surface: "cli" }, disposition: "started_run" } } as never);
    expect(k.out() + k.err()).toBe("");
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

  test("refuses runtime commands with 77 without touching the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-rel-"));
    mkdirSync(join(dir, "run"), { mode: 0o700 });
    let connections = 0;
    const listener = Bun.listen({ unix: join(dir, "run", "homerund.sock"), socket: { open: () => void connections++, data() {} } });
    try {
      for (const argv of [["status"], ["threads", "list"], ["send", "--new", "hi"], ["chat"]]) {
        const x = io(argv, { HOMERUN_DATA_DIR: dir });
        expect(await main(x)).toBe(77);
        expect(x.err()).toContain("needs access approved in the Homerun app");
      }
      const v = io(["version"], { HOMERUN_DATA_DIR: dir });
      expect(await main(v)).toBe(0);
      expect(v.out()).toContain("(release)");
      expect(await main(io(["help"], {}))).toBe(0);
      await Bun.sleep(20);
      expect(connections).toBe(0);
    } finally {
      listener.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses development switches with 64, whatever the command", async () => {
    for (const [argv, env] of [
      [["status", "--socket", "/tmp/x.sock"], {}],
      [["version", "--dev-token-file", "/tmp/t"], {}],
      [["status"], { HOMERUN_SOCKET: "/tmp/x.sock" }],
    ] as const) {
      const x = io([...argv], { ...env });
      expect(await main(x)).toBe(64);
      expect(x.err()).toContain("is only available in development builds; this is a release build");
    }
  });
});
