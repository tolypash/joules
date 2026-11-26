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
  /** Share of a full-time week they work here (1 unless told), so a part-timer is measured against their own hours. */
  share: number;
  /** Joules per weekday against a typical engineer before AI (BASELINE), in %: 100 is that engineer. */
  efficiency: number;
  /** Joules from weeks of work on branches with no PR, already in `joules`. */
  unmerged: number;
};

/**
 * Joules per weekday of the median full-time engineer before AI (Q4 2024, before Claude 3.7 and agentic
 * coding), measured by `joules calibrate` over our repos and public product repos. 100% is that engineer.
 */
export const BASELINE = 8;

/** Red up to 100% (no gain on pre-AI), yellow at 300%, green from 500%: heat, not a verdict. */
const heat = (pct: number) => `hsl(${Math.round(Math.min(120, Math.max(0, ((pct - 100) / 400) * 120)))}, 85%, 78%)`;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/** `days` is a whole number of weeks (cli.ts rounds it), so the bars add up to the totals. */
export function statsOf(scored: Scored[], days: number, names: Record<string, string>, now = Date.now(), baseline = BASELINE, shares: Record<string, number> = {}): Stats[] {
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
    const prs = mine.filter((s) => s.number);
    const share = shares[author] ?? 1;
    out.push({
      author,
      name: names[author] ?? author,
      joules,
      prs: prs.length,
      activeDays: perDay.size,
      typicalDay: median([...perDay.values()]),
      typicalPr: median(prs.map((s) => s.joules)),
      rework: { fixed, settled },
      weekly,
      efficiency: Math.round((joules / (workdays(days, new Date(now)) * share) / baseline) * 100),
      share,
      unmerged: joules - prs.reduce((a, s) => a + s.joules, 0),
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

export function statsHtml(rows: Stats[], o: { title: string; days: number; repos: string[]; note?: string; baseline: number }): string {
  const max = Math.max(1, ...rows.map((r) => r.joules));
  const maxWeek = Math.max(1, ...rows.flatMap((r) => r.weekly));
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let body = "";
  for (const r of rows) {
    body += `<tr><td class="who">${esc(r.name)}${r.share < 1 ? `<small>part-time, ${Math.round(r.share * 100)}% of a week</small>` : ""}</td>
<td class="total"><b>${r.joules.toLocaleString("en-GB")}</b>${r.unmerged ? `<small>incl. ${r.unmerged.toLocaleString("en-GB")} unmerged</small>` : ""}<span class="bar"><i style="width:${Math.round((r.joules / max) * 100)}%"></i></span></td>
<td>${r.prs}</td><td>${r.activeDays}</td><td>${r.typicalDay}</td><td>${r.typicalPr}</td>
<td>${pct(r.rework.fixed, r.rework.settled)}<small>${r.rework.fixed} of ${r.rework.settled}</small></td>
<td class="pace" style="background:${heat(r.efficiency)}"><b>${r.efficiency}%</b></td>
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
.plain { font-size: 15px; line-height: 1.5; color: #222; background: #f7f7f5; border-radius: 8px; padding: 12px 16px; margin: -6px 0 22px }
td.who small { display: block; color: #888; font-size: 11px; font-weight: 400 }
td.pace { text-align: center; border-radius: 6px; border-bottom: 2px solid #fff } td.pace b { font-size: 17px }
.note { background: #fff7ed; border-left: 3px solid #d97706; padding: 8px 12px; font-size: 13px; color: #333; margin: -8px 0 18px }
</style></head><body>
<h1><span>⚡</span> ${esc(o.title)}</h1>
<div class="sub">Last ${o.days} days to ${date} · ${esc(o.repos.map((r) => r.split("/")[1]).join(", "))} · release PRs and bots left out</div>
<div class="plain">Every piece of work an engineer finishes gets a score, called <b>Joules</b>: roughly how many hours a good engineer would have needed for it without AI. Work customers use weighs more than behind-the-scenes clean-up. <b>Efficiency</b> compares each person's Joules per working day with what ${o.baseline === BASELINE ? "a typical engineer delivered" : "this team delivered"} before AI tools: 100% is the same output as before, 300% is three times as much.</div>
${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
<table><tr><th>Engineer</th><th>Joules<br>(value shipped)</th><th>PRs</th><th>Days<br>shipping</th><th>Typical<br>day (J)</th><th>Typical<br>PR (J)</th><th>Needed a<br>fix after</th><th>Efficiency</th><th style="text-align:left">Joules per week, oldest to newest</th></tr>${body}</table>
<div class="how">
<div><b>Joules</b> is the value of the work (merged PRs, plus commits on branches with no PR): how long a senior engineer would need without AI × who it reaches (customers 3, the team 2, internal systems 1.5, only developers 1) × what it is (feature, fix or speed-up 1, refactor 0.7, tests 0.6, docs or chores 0.4, dependency bumps 0.3). Claude scores each PR; everything on this page is counted by plain code. A small fix is about 3 J, a solid feature 30 to 100 J.</div>
<div><b>Typical day</b> is the middle value over the days someone shipped anything, so one huge day doesn't skew it. <b>Typical PR</b> is the same for single PRs.</div>
<div><b>Efficiency</b> is Joules per weekday against a typical full-time engineer before AI: ${o.baseline} J a day, measured with <code>joules calibrate</code> on work from before Claude 3.7 and agentic coding${o.baseline === BASELINE ? " (the median of 39 full-time engineers on Twenty, Novu, Formbricks, Documenso and our own repos, Q4 2024)" : " (this team's own median)"}. 100% is that engineer; 500% ships five times as much. Red is no gain on that, yellow 300%, green 500% and up. Part-timers are measured against their own hours when marked part-time; people who also work in other repos read low.</div>
<div><b>Needed a fix after</b>: PRs merged ${SETTLE_DAYS}+ days ago that were reverted or fixed again by a later PR pointing back at them. Lower is better; it only sees fixes that link the PR.</div>
</div></body></html>`;
}
