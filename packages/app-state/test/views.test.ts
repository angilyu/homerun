import { describe, expect, test } from "bun:test";
import { parseMarkdown, plainText, safeHref } from "../src/markdown";
import { ago, bytes, cronText, inTime, scheduleText, toolName, toolSummary, truncate, usd } from "../src/format";
import { coverageRange, coverageSentence, monitorHealthText, summarizeCoverage } from "../src/monitors";
import { checkSpec, getAt, issuesAt, newMonitorSpec, newSessionSpec, setAt } from "../src/tasks";
import { activeGrants, grantText } from "../src/grants";

describe("markdown is data, never HTML (§9.8, §13)", () => {
  test("blocks and inlines", () => {
    const b = parseMarkdown("# Title\n\nSome **bold** and `code`.\n\n- [x] done\n- todo\n\n```ts\nlet x = 1\n```");
    expect(b.map((x) => x.t)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(b[1]).toEqual({
      t: "paragraph",
      children: [{ t: "text", text: "Some " }, { t: "strong", children: [{ t: "text", text: "bold" }] }, { t: "text", text: " and " }, { t: "code", text: "code" }, { t: "text", text: "." }],
    });
    expect(b[2]).toMatchObject({ t: "list", items: [{ checked: true }, { checked: null }] });
    expect(b[3]).toEqual({ t: "code", lang: "ts", text: "let x = 1" });
    expect(plainText(b)).toContain("Some bold and code.");
  });

  test("raw HTML is text; unsafe links lose their target; images become links", () => {
    const b = parseMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://x.test/?a&amp;b) ![pic](https://x.test/p.png)');
    const json = JSON.stringify(b);
    expect(json).toContain("<img src=x onerror=alert(1)>");
    expect(json).not.toContain('"href":"javascript');
    expect(json).toContain('"href":"https://x.test/?a&b"');
    expect(json).toContain('"image":true');
  });

  test("safeHref", () => {
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("HTTPS://x")).toBe("HTTPS://x");
    for (const bad of ["javascript:x", "data:text/html,x", "file:///etc/passwd", "https://a\u0000b", "//x.test", "/relative"]) expect(safeHref(bad)).toBeNull();
  });
});

describe("format", () => {
  const now = 1_767_225_600_000;
  test("numbers and times", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(usd(0.004)).toBe("<$0.01");
    expect(ago(now - 90_000, now)).toMatch(/1 min/);
    expect(inTime(now + 3 * 3600_000, now)).toMatch(/3 h/);
  });

  test("schedules in words", () => {
    expect(scheduleText({ kind: "interval", every_minutes: 15 } as never)).toBe("Every 15 minutes");
    expect(scheduleText({ kind: "interval", every_minutes: 120 } as never)).toBe("Every 2 hours");
    expect(cronText("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(cronText("*/5 * * * *")).toBe("Every 5 minutes");
    expect(cronText("0 0 1 * *")).toBe("Cron 0 0 1 * *");
  });

  test("tools", () => {
    expect(toolName("mcp__github__create_issue")).toBe("github · create_issue");
    expect(toolSummary("Bash", { kind: "inline", value: { command: "git   status\n-s" } } as never)).toBe("git status -s");
  });
});

describe("monitor coverage (§8.4)", () => {
  test("seven days in the schedule's zone", () => {
    const r = coverageRange("Asia/Tokyo", Date.UTC(2026, 2, 8, 20)); // 05:00 on the 9th in Tokyo
    expect(r.days).toHaveLength(7);
    expect(r.to_day).toBe("2026-03-09");
    expect(r.from_day).toBe("2026-03-03");
    // Across a DST change: no day skipped or doubled.
    const ny = coverageRange("America/New_York", Date.UTC(2026, 2, 10, 12));
    expect(new Set(ny.days).size).toBe(7);
  });

  test("the sentence says why checks were missed", () => {
    expect(coverageSentence(212, 2016, 1700, 104, 0)).toBe("Ran 212 of 2,016 scheduled checks this week (11%). Your Mac was asleep for most of the rest.");
    expect(coverageSentence(10, 10, 0, 0, 0)).toBe("Ran 10 of 10 scheduled checks this week (100%).");
    expect(coverageSentence(5, 10, 1, 2, 0)).toContain("Homerun wasn't running for some of the rest");
    expect(coverageSentence(0, 0, 0, 0, 0)).toBe("No checks were scheduled this week.");
  });

  test("summary per day and the low-coverage flag", () => {
    const row = (day: string, expected: number, ran: number, missed_asleep: number) => ({ schedule_id: "s", day, expected, ran, missed_asleep, missed_not_running: 0, merged: 0 });
    const s = summarizeCoverage([row("2026-03-08", 24, 6, 18), row("2026-03-09", 10, 4, 0), row("2026-01-01", 99, 99, 0)] as never, ["2026-03-08", "2026-03-09"]);
    expect(s).toMatchObject({ expected: 34, ran: 10, asleep: 18, low: true });
    expect(s.days[1]).toMatchObject({ other: 6 });
  });

  test("health line", () => {
    const m = { task_id: "t", name: "n", enabled: false, paused_reason: "failures", succeeded: 11, failed: 1, changes: 1, missed_asleep: 2, missed_not_running: 0, skipped: 0, caught_up: 0, needs_attention: true };
    expect(monitorHealthText(m as never)).toBe("12 checks, 1 change, 1 failed, 2 missed while asleep, paused after failures");
  });
});

describe("task editor (§8.1)", () => {
  test("new specs need a name and prompt, then pass the core schema", () => {
    const bad = checkSpec(newSessionSpec());
    expect(bad.ok).toBe(false);
    expect(issuesAt(bad, "name").length).toBeGreaterThan(0);
    let s = setAt(newSessionSpec(), "name", "Triage");
    s = setAt(s, "prompt", "Look at new issues");
    expect(checkSpec(s).ok).toBe(true);
    let m = setAt(setAt(newMonitorSpec(), "name", "Status page"), "prompt", "Summarise the change");
    expect(checkSpec(m).ok).toBe(true);
    m = setAt(m, "schedule.every_minutes", 0);
    expect(issuesAt(checkSpec(m), "schedule").length).toBeGreaterThan(0);
  });

  test("setAt is immutable and getAt reads paths", () => {
    const a = newMonitorSpec();
    const b = setAt(a, "check.source.url", "https://status.test");
    expect(getAt(a, "check.source.url")).toBe("https://example.com");
    expect(getAt(b, "check.source.url")).toBe("https://status.test");
    expect(b.schedule).toBe(a.schedule);
    expect(getAt(setAt(a, "budget.monthly_cap_usd", undefined), "budget")).toEqual({ max_run_usd: 0.5 });
  });
});

describe("grants (§5.6)", () => {
  test("text and active list", () => {
    expect(grantText({ tool: "Bash", pattern: "git status *" })).toBe("Bash · git status *");
    expect(grantText({ tool: "mcp__github__create_issue", pattern: null })).toBe("github · create_issue · every call");
    const g = (id: string, granted_at: number, revoked_at: number | null) => ({ grant_id: id, granted_at, revoked_at }) as never;
    expect(activeGrants([g("a", 1, null), g("b", 3, 4), g("c", 2, null)]).map((x: any) => x.grant_id)).toEqual(["c", "a"]);
  });
});
