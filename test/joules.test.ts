import { expect, test } from "bun:test";
import { readStamp, type Stamp, withStamp, withoutStamp } from "../src/block.ts";
import { isRelease, type Pull } from "../src/github.ts";
import { leaderboard, type Scored } from "../src/report.ts";
import { joulesOf, parseRating } from "../src/score.ts";
import { finalJoules, settlementOf } from "../src/settle.ts";
import { statsOf } from "../src/stats.ts";
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
  const twice = withStamp(once, { ...stamp, joules: 40 });
  expect(twice.match(/joules:start/g)).toHaveLength(1);
  expect(readStamp(twice)?.joules).toBe(40);
  expect(withoutStamp(twice)).toBe("Adds tips.");
  expect(readStamp("no block")).toBeUndefined();
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
    pull(16, "Tips copy", "#10 <!-- joules {\"kind\":\"fix\"} -->", "2026-11-04T00:00:00Z"),
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
  );
  expect(row).toMatchObject({ name: "Ann", joules: 65, prs: 4, activeDays: 2, typicalDay: 33, typicalPr: 15, rework: { fixed: 1, settled: 2 } });
  expect(row!.weekly).toEqual([0, 35, 0, 30]);
});
