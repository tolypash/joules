import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readStamp, type Stamp, withStamp, withoutStamp } from "../src/block.ts";
import { cardHtml, cardOf } from "../src/card.ts";
import { isRelease, type Pull } from "../src/github.ts";
import { init } from "../src/init.ts";
import { leaderboard, type Scored } from "../src/report.ts";
import { joulesOf, parseRating } from "../src/score.ts";
import { finalJoules, settlementOf } from "../src/settle.ts";
import { BASELINE, GOOD, GREAT, statsOf } from "../src/stats.ts";
import { ticketsIn } from "../src/tickets.ts";

const stamp: Stamp = { v: 1, stage: "open", kind: "feature", reach: "customers", expert_hours: 12, summary: "Tips at checkout", reason: "Touches payments.", joules: 36, model: "haiku", scored_at: "2026-11-26T00:00:00Z" };

test("joules is expert hours × reach × kind, at least 1, a revert 0", () => {
  expect(joulesOf({ kind: "feature", reach: "customers", expert_hours: 12 })).toBe(36);
  expect(joulesOf({ kind: "refactor", reach: "dev", expert_hours: 10 })).toBe(7);
  expect(joulesOf({ kind: "deps", reach: "dev", expert_hours: 0.25 })).toBe(1);
  expect(joulesOf({ kind: "revert", reach: "customers", expert_hours: 3 })).toBe(0);
});

test("a rating is read from the model's text and its hours are clamped", () => {
  const r = parseRating('Here: {"kind":"fix","reach":"team","expert_hours":500,"summary":"s","reason":"r"}');
  expect(r.expert_hours).toBe(120);
  expect(() => parseRating('{"kind":"magic","reach":"team","expert_hours":1}')).toThrow();
});

test("the block goes at the end, is replaced in place, and reads back", () => {
  const once = withStamp("Adds tips.", stamp);
  expect(once.startsWith("Adds tips.\n\n<!-- joules:start -->")).toBe(true);
  const twice = withStamp(once, { ...stamp, expert_hours: 14, joules: 42 });
  expect(twice.match(/joules:start/g)).toHaveLength(1);
  expect(readStamp(twice)?.joules).toBe(42);
  expect(withoutStamp(twice)).toBe("Adds tips.");
  expect(readStamp("no block")).toBeUndefined();
});

test("a block an agent wrote by hand is read loosely and its Joules worked out again", () => {
  const block = (json: string) => `Adds tips.\n<!-- joules:start -->\n<!-- joules ${json} -->\n<!-- joules:end -->`;
  // Spread over lines, and the sum is wrong: 12 × 3 × 1 is 36.
  expect(readStamp(block('{\n "kind": "feature",\n "reach": "customers",\n "expert_hours": 12,\n "joules": 99\n}'))?.joules).toBe(36);
  expect(readStamp(block('{"kind":"magic","reach":"customers","expert_hours":12,"joules":36}'))).toBeUndefined();
  expect(readStamp(block('{"kind":"fix","reach":"customers","expert_hours":"a lot","joules":36}'))).toBeUndefined();
  expect(readStamp(block('{"kind":"fix"'))).toBeUndefined();
});

test("ticket keys are found once each", () => {
  expect(ticketsIn("toly/SAL-2649-fix, see sal-12 and SAL-2649")).toEqual(["SAL-2649", "SAL-12"]);
});

const pull = (number: number, title: string, body: string, merged: string): Pull => ({
  number, title, body, html_url: "", user: { login: "a", type: "User" }, merged_at: merged, updated_at: merged, head: { ref: "x" },
});

test("a revert zeroes the score, follow-up fixes take a quarter each", () => {
  const target = pull(10, "Tips at checkout", "", "2026-11-01T00:00:00Z");
  const later = [
    pull(11, "Fix tips rounding", "Follow-up to #10", "2026-11-03T00:00:00Z"),
    pull(12, "Fix tips on refunds", "From /pull/10", "2026-11-05T00:00:00Z"),
    pull(13, "Fix unrelated", "#100", "2026-11-05T00:00:00Z"),
    pull(14, "Fix tips again", "#10", "2026-12-01T00:00:00Z"),
    pull(16, "Tips copy", `#10 ${withStamp("", { ...stamp, kind: "fix" })}`, "2026-11-04T00:00:00Z"),
  ];
  const s = settlementOf(target, later);
  expect(s).toEqual({ reverted: false, fixes: [11, 12, 16] });
  expect(finalJoules(36, s)).toBe(9);
  expect(settlementOf(target, [pull(15, 'Revert "Tips at checkout"', "Reverts o/r#10", "2026-11-02T00:00:00Z")]).reverted).toBe(true);
  expect(finalJoules(36, { reverted: true, fixes: [] })).toBe(0);
});

test("the leaderboard sums per author over the window and compares with the window before", () => {
  const now = new Date("2026-11-26T12:00:00Z").getTime();
  const s = (author: string, joules: number, daysAgo: number): Scored => ({
    repo: "o/r", number: joules, title: "", author, url: "", merged_at: new Date(now - daysAgo * 86_400_000).toISOString(), score: { ...stamp, joules }, joules,
  });
  const rows = leaderboard([s("ann", 30, 0.5), s("ann", 10, 20), s("ann", 20, 40), s("bob", 5, 3)], 30, true, now);
  expect(rows.map((r) => [r.author, r.day, r.week, r.total, r.prs, r.previous])).toEqual([
    ["ann", 30, 30, 40, 2, 20],
    ["bob", 0, 5, 5, 1, 0],
  ]);
});

test("release and promotion PRs are told apart from real work", () => {
  const p = (title: string, ref: string) => ({ ...pull(1, title, "", "2026-11-01T00:00:00Z"), head: { ref } });
  expect(isRelease(p("release: 2.6.4", "release/2.6.4"))).toBe(true);
  expect(isRelease(p("feat: release BOH 2.5.3", "staging"))).toBe(true);
  expect(isRelease(p("Sync", "claude/staging-master-merge-64ea6d"))).toBe(true);
  expect(isRelease(p("fix(menu): releases the lock", "claude/millwicks-menu-d533ab"))).toBe(false);
  expect(isRelease(p("Release notes page", "feat/release-notes"))).toBe(false);
  expect(isRelease(p("Release 2.7", "feat/x"))).toBe(true);
});

test("stats count weeks, typical day and PR, and rework", () => {
  const now = new Date("2026-11-26T12:00:00Z").getTime();
  const s = (joules: number, daysAgo: number, extra: Partial<Scored> = {}): Scored => ({
    repo: "o/r", number: joules, title: "", author: "ann", url: "", merged_at: new Date(now - daysAgo * 86_400_000).toISOString(), score: { ...stamp, joules }, joules, ...extra,
  });
  const [row] = statsOf(
    [
      s(10, 1),
      s(20, 1),
      s(5, 20, { settlement: { reverted: false, fixes: [7] } }),
      s(30, 20, { settlement: { reverted: false, fixes: [] } }),
      s(99, 40),
    ],
    28,
    { ann: "Ann" },
    now,
    8,
    { ann: 0.5 },
  );
  expect(row).toMatchObject({ name: "Ann", joules: 65, prs: 4, activeDays: 2, typicalDay: 33, typicalPr: 15, rework: { fixed: 1, settled: 2 }, efficiency: 81, share: 0.5 });
  expect(row!.weekly).toEqual([0, 35, 0, 30]);
});

test("a PR that bundles an upgrade, a feature and a fix is scored part by part", () => {
  const r = parseRating(
    '{"parts":[{"what":"React 19 upgrade","kind":"deps","reach":"dev","expert_hours":40},{"what":"AI chat cards","kind":"feature","reach":"customers","expert_hours":12},{"what":"Totals fix","kind":"fix","reach":"customers","expert_hours":2}],"summary":"s","reason":"r"}',
  );
  expect(r).toMatchObject({ kind: "feature", reach: "customers", expert_hours: 54 });
  expect(joulesOf(r)).toBe(54); // 40 × 1 × 0.3 + 12 × 3 + 2 × 3, where one kind for all would read 162
});

/** A percentile with linear interpolation between ranks. */
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, s.length - 1);
  return Math.round((s[lo]! + (s[hi]! - s[lo]!) * (k - lo)) * 10) / 10;
};
const perWeekday = (file: string) =>
  readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8").trim().split("\n").slice(1).map((line) => Number(line.split("\t")[0]));

test("the levels are the measured percentiles", () => {
  expect(percentile(perWeekday("pre-ai-2024-q4.tsv"), 0.5)).toBe(BASELINE);
  expect(percentile(perWeekday("ai-era-2026.tsv"), 0.5)).toBe(GOOD);
  expect(percentile(perWeekday("ai-era-2026.tsv"), 0.9)).toBe(GREAT);
  // The share card carries its own copy of the with-AI levels.
  const card = readFileSync(new URL("../skill/joules/card.html", import.meta.url), "utf8");
  expect(card).toContain(`const WITH_AI = { median: ${GOOD}, p75: ${percentile(perWeekday("ai-era-2026.tsv"), 0.75)}, top10: ${GREAT} };`);
});

test("the share card counts one person's window: total, weekdays, PRs and a bar per day or week", () => {
  const now = new Date("2026-11-26T12:00:00Z").getTime(); // a Thursday
  const s = (joules: number, daysAgo: number, number = 1): Scored => ({
    repo: "o/r", number, title: "", author: "ann", url: "", merged_at: new Date(now - daysAgo * 86_400_000).toISOString(), score: { ...stamp, joules }, joules,
  });
  const scored = [s(10, 0.5), s(20, 0.6), s(5, 6.5), s(40, 20, 0), s(99, 30)];
  expect(cardOf(scored, "week", "@ann", now)).toEqual({ who: "@ann", period: "7 days to 26 Nov 2026", joules: 35, weekdays: 5, prs: 3, bars: [5, 0, 0, 0, 0, 0, 30] });
  const month = cardOf(scored, "month", "@ann", now);
  expect(month).toMatchObject({ period: "4 weeks to 26 Nov 2026", joules: 75, weekdays: 20, prs: 3 }); // the week of branch work counts, but isn't a PR
  expect(month.bars).toHaveLength(28);
  const year = cardOf(scored, "year", "@ann", now);
  expect(year).toMatchObject({ joules: 174, weekdays: 260, prs: 4 });
  expect(year.bars.slice(-5)).toEqual([99, 0, 40, 0, 35]);
});

test("the card page is the template with the numbers in its one DATA line", () => {
  const page = cardHtml({ who: "</script><b>@ann", period: "7 days to 26 Nov 2026", joules: 35, weekdays: 5, prs: 3, bars: [5, 30] });
  expect(page.match(/^const DATA = (.*);$/m)?.[1]).toBe('{"who":"\\u003c/script>\\u003cb>@ann","period":"7 days to 26 Nov 2026","joules":35,"weekdays":5,"prs":3,"bars":[5,30]}');
  expect(page.match(/<\/script>/g)).toHaveLength(1);
});

test("init puts the skill, its card and the hook in a repo, once, and widens an older hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "joules-"));
  const hook = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/joules-pre-pr.sh';
  expect(init(dir)).toEqual([".claude/skills/joules/SKILL.md", ".claude/skills/joules/rubric.md", ".claude/skills/joules/card.html", ".claude/hooks/joules-pre-pr.sh", ".claude/settings.json", "CLAUDE.md"]);
  expect(init(dir)).toEqual([]);
  const settings = join(dir, ".claude/settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook }] }] } }));
  expect(init(dir)).toEqual([".claude/settings.json"]);
  expect(JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse).toEqual([{ matcher: "Bash|mcp__.*__create_pull_request", hooks: [{ type: "command", command: hook }] }]);
});
