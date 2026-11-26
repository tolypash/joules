import { esc, type Scored, workdays } from "./report.ts";
import { DAY, SETTLE_DAYS } from "./settle.ts";

/**
 * Plain counting over scored PRs, no model involved: weekly Joules, the typical day, how often work
 * needed a follow-up fix. Every number here can be checked by hand.
 */
export type Stats = {
  author: string;
  name: string;
  joules: number;
  prs: number;
  activeDays: number;
  /** Median Joules over the days they merged anything. */
  typicalDay: number;
  /** Median Joules per PR. */
  typicalPr: number;
  /** Settled PRs (merged 14+ days ago) that were reverted or fixed again, out of all settled ones. */
  rework: { fixed: number; settled: number };
  weekly: number[];
  /** Joules per weekday in the window, as a multiple of what a pre-AI senior ships (PRE_AI_DAY). */
  pace: number;
};

/**
 * A senior engineer before AI shipped about 6 solid hours of customer-facing work a day: 6 × reach 3 = 18 J.
 * Pace 1 is that; the tiers say how much AI is multiplying someone.
 */
export const PRE_AI_DAY = 18;
export const tierOf = (pace: number) => (pace >= 4 ? "cracked" : pace >= 2 ? "ideal" : pace >= 1 ? "good" : "behind");

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** `days` is a whole number of weeks (cli.ts rounds it), so the bars add up to the totals. */
export function statsOf(scored: Scored[], days: number, names: Record<string, string>, now = Date.now()): Stats[] {
  const weeks = Math.round(days / 7);
  const by = new Map<string, Scored[]>();
  for (const s of scored) {
    if (now - new Date(s.merged_at).getTime() >= days * DAY) continue;
    const list = by.get(s.author) ?? [];
    list.push(s);
    by.set(s.author, list);
  }
  const out: Stats[] = [];
  for (const [author, mine] of by) {
    const perDay = new Map<string, number>();
    const weekly = new Array<number>(weeks).fill(0);
    let fixed = 0;
    let settled = 0;
    for (const s of mine) {
      const day = s.merged_at.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + s.joules);
      const week = weeks - 1 - Math.floor((now - new Date(s.merged_at).getTime()) / (7 * DAY));
      weekly[week]! += s.joules;
      if (s.settlement) {
        settled++;
        if (s.settlement.reverted || s.settlement.fixes.length) fixed++;
      }
    }
    const joules = mine.reduce((a, s) => a + s.joules, 0);
    out.push({
      author,
      name: names[author] ?? author,
      joules,
      prs: mine.length,
      activeDays: perDay.size,
      typicalDay: median([...perDay.values()]),
      typicalPr: median(mine.map((s) => s.joules)),
      rework: { fixed, settled },
      weekly,
      pace: Math.round((joules / workdays(days, new Date(now)) / PRE_AI_DAY) * 10) / 10,
    });
  }
  return out.sort((a, b) => b.joules - a.joules);
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

function weeklyBars(weekly: number[], max: number): string {
  const w = 10;
  const h = 34;
  let bars = "";
  weekly.forEach((j, i) => {
    const bh = j ? Math.max(2, Math.round((j / max) * h)) : 0;
    bars += `<rect x="${i * (w + 2)}" y="${h - bh}" width="${w}" height="${bh}" rx="2"/>`;
  });
  return `<svg width="${weekly.length * (w + 2)}" height="${h + 1}"><line x1="0" x2="${weekly.length * (w + 2)}" y1="${h + 0.5}" y2="${h + 0.5}" class="base"/>${bars}</svg>`;
}

export function statsHtml(rows: Stats[], o: { title: string; days: number; repos: string[]; note?: string }): string {
  const max = Math.max(1, ...rows.map((r) => r.joules));
  const maxWeek = Math.max(1, ...rows.flatMap((r) => r.weekly));
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let body = "";
  for (const r of rows) {
    body += `<tr><td class="who">${esc(r.name)}</td>
<td class="total"><b>${r.joules.toLocaleString("en-GB")}</b><span class="bar"><i style="width:${Math.round((r.joules / max) * 100)}%"></i></span></td>
<td>${r.prs}</td><td>${r.activeDays}</td><td>${r.typicalDay}</td><td>${r.typicalPr}</td>
<td>${pct(r.rework.fixed, r.rework.settled)}<small>${r.rework.fixed} of ${r.rework.settled}</small></td>
<td class="pace ${tierOf(r.pace)}"><b>${r.pace}×</b><small>${tierOf(r.pace)}</small></td>
<td class="weeks">${weeklyBars(r.weekly, maxWeek)}</td></tr>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>
body { font-family: -apple-system, "Helvetica Neue", sans-serif; color: #111; margin: 0; padding: 32px 36px; background: #fff; width: 1128px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.4px } h1 span { color: #d97706 }
.sub { color: #555; font-size: 14px; margin-bottom: 22px }
table { width: 100%; border-collapse: collapse; font-size: 14px }
th { text-align: right; font-weight: 500; color: #555; font-size: 12px; padding: 0 10px 8px; border-bottom: 1px solid #ddd; vertical-align: bottom }
th:first-child, td.who { text-align: left }
td { text-align: right; padding: 12px 10px; border-bottom: 1px solid #eee; font-variant-numeric: tabular-nums; vertical-align: middle }
td.who { font-weight: 600 } td small { display: block; color: #888; font-size: 11px }
td.total b { font-size: 17px } .bar { display: block; height: 6px; margin-top: 5px; background: #f3f3f3; border-radius: 3px }
.bar i { display: block; height: 6px; border-radius: 3px; background: #d97706 }
td.weeks { text-align: left } svg rect { fill: #d97706 } svg .base { stroke: #ccc; stroke-width: 1 }
.how { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 28px; margin-top: 24px; font-size: 12.5px; color: #444; line-height: 1.45 }
.how b { color: #111 }
td.pace { text-align: center; border-radius: 6px; border-bottom: 2px solid #fff } td.pace b { font-size: 16px } td.pace small { color: #333 }
.behind { background: #fecaca } .good { background: #fef08a } .ideal { background: #bbf7d0 } .cracked { background: #4ade80 }
.note { background: #fff7ed; border-left: 3px solid #d97706; padding: 8px 12px; font-size: 13px; color: #333; margin: -8px 0 18px }
</style></head><body>
<h1><span>⚡</span> ${esc(o.title)}</h1>
<div class="sub">Last ${o.days} days to ${date} · ${esc(o.repos.map((r) => r.split("/")[1]).join(", "))} · release PRs and bots left out</div>
${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
<table><tr><th>Engineer</th><th>Joules<br>(value shipped)</th><th>PRs</th><th>Days<br>shipping</th><th>Typical<br>day (J)</th><th>Typical<br>PR (J)</th><th>Needed a<br>fix after</th><th>Pace vs a<br>pre-AI senior</th><th style="text-align:left">Joules per week, oldest to newest</th></tr>${body}</table>
<div class="how">
<div><b>Joules</b> is the value of merged work: how long a senior engineer would need without AI × who it reaches (customers 3, the team 2, internal systems 1.5, only developers 1) × what it is (feature, fix or speed-up 1, refactor 0.7, tests 0.6, docs or chores 0.4, dependency bumps 0.3). Claude scores each PR; everything on this page is counted by plain code. A small fix is about 3 J, a solid feature 30 to 100 J.</div>
<div><b>Typical day</b> is the middle value over the days someone merged anything, so one huge day doesn't skew it. <b>Typical PR</b> is the same for single PRs.</div>
<div><b>Pace</b> is Joules per weekday ÷ ${PRE_AI_DAY}, what a senior engineer shipped before AI (about 6 solid hours of customer work a day). <span class="behind">&nbsp;behind&nbsp;</span> under 1×, <span class="good">&nbsp;good&nbsp;</span> 1 to 2×, <span class="ideal">&nbsp;ideal&nbsp;</span> 2 to 4×, <span class="cracked">&nbsp;cracked&nbsp;</span> 4× and up. Part-timers and people working in other repos read low.</div>
<div><b>Needed a fix after</b>: PRs merged ${SETTLE_DAYS}+ days ago that were reverted or fixed again by a later PR pointing back at them. Lower is better; it only sees fixes that link the PR.</div>
</div></body></html>`;
}
