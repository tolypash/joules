import { readStamp, settledNote } from "./block.ts";
import { type Entry, keyOf, loadCache, saveEntry } from "./cache.ts";
import { isBot, isRelease, mergedSince, type Pull, pullContext } from "./github.ts";
import { KINDS, REACH, rate, type Score } from "./score.ts";
import { DAY, finalJoules, isSettled, SETTLE_DAYS, type Settlement, settlementOf } from "./settle.ts";

export type Options = { repos: string[]; days: number; cache: string; model: string; concurrency: number; compare: boolean };
export type Scored = Entry & { joules: number; settlement?: Settlement };
export type Row = { author: string; day: number; week: number; total: number; prs: number; perWorkday: number; previous?: number; top: Scored[]; bottom: Scored[] };

export async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

const entryOf = (repo: string, p: Pull, score: Score): Entry => ({ repo, number: p.number, title: p.title, author: p.user.login, url: p.html_url, merged_at: p.merged_at!, score });

/** Every human PR (releases left out) merged in the window (twice the window with `compare`), with its Joules: from the cache, the PR's own block, or scored now. */
export async function collect(o: Options): Promise<Scored[]> {
  const cache = loadCache(o.cache);
  const since = new Date(Date.now() - o.days * DAY * (o.compare ? 2 : 1));
  const byRepo = new Map<string, Pull[]>();
  const missing: [string, Pull][] = [];
  for (const repo of o.repos) {
    const pulls = (await mergedSince(repo, since)).filter((p) => !isBot(p) && !isRelease(p));
    byRepo.set(repo, pulls);
    for (const p of pulls) {
      const key = keyOf(repo, p.number);
      const stamp = readStamp(p.body);
      if (!cache.has(key) && stamp) cache.set(key, entryOf(repo, p, stamp));
      if (!cache.has(key)) missing.push([repo, p]);
    }
  }
  if (missing.length) console.error(`Scoring ${missing.length} PRs`);
  let done = 0;
  await pool(missing, o.concurrency, async ([repo, p]) => {
    try {
      const e = entryOf(repo, p, await rate(await pullContext(repo, p), o.model));
      cache.set(keyOf(repo, p.number), e);
      saveEntry(o.cache, e);
    } catch (err) {
      console.error(`${repo}#${p.number}: ${(err as Error).message}`);
    }
    if (++done % 25 === 0) console.error(`${done}/${missing.length}`);
  });
  const out: Scored[] = [];
  for (const [repo, pulls] of byRepo) {
    for (const p of pulls) {
      const e = cache.get(keyOf(repo, p.number));
      if (!e) continue;
      const settled = readStamp(p.body)?.final;
      const settlement = settled ?? (isSettled(p.merged_at!) ? settlementOf(p, pulls) : undefined);
      out.push({ ...e, joules: settled?.joules ?? (settlement ? finalJoules(e.score.joules, settlement) : e.score.joules), settlement });
    }
  }
  return out;
}

/** Weekdays in the last n days, so a weekend doesn't count against anyone. */
function workdays(n: number, now = new Date()): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * DAY).getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return Math.max(1, count);
}

export function leaderboard(scored: Scored[], days: number, compare: boolean, now = Date.now()): Row[] {
  const rows = new Map<string, Row>();
  for (const s of scored) {
    const row = rows.get(s.author) ?? { author: s.author, day: 0, week: 0, total: 0, prs: 0, perWorkday: 0, previous: compare ? 0 : undefined, top: [], bottom: [] };
    rows.set(s.author, row);
    const age = now - new Date(s.merged_at).getTime();
    if (age < DAY) row.day += s.joules;
    if (age < 7 * DAY) row.week += s.joules;
    if (age < days * DAY) {
      row.total += s.joules;
      row.prs++;
      row.top.push(s);
    } else if (row.previous !== undefined && age < 2 * days * DAY) row.previous += s.joules;
  }
  const out: Row[] = [];
  for (const row of rows.values()) {
    if (!row.prs && !row.week) continue;
    const mine = row.top.sort((a, b) => b.joules - a.joules);
    row.top = mine.slice(0, 3);
    row.bottom = mine.length > 3 ? mine.slice(-3).reverse() : [];
    row.perWorkday = Math.round((row.total / workdays(days, new Date(now))) * 10) / 10;
    out.push(row);
  }
  return out.sort((a, b) => b.total - a.total);
}

export function markdown(rows: Row[], days: number): string {
  const lines = [`| Engineer | 24h | 7d | ${days}d | PRs | J/workday |`, "|---|---:|---:|---:|---:|---:|"];
  for (const r of rows) lines.push(`| ${r.author} | ${r.day} | ${r.week} | ${r.total} | ${r.prs} | ${r.perWorkday} |`);
  return lines.join("\n");
}

const weights = (w: Record<string, number>) => Object.entries(w).map(([k, v]) => `${k} ${v}`).join(", ");
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function trend(r: Row): string {
  if (!r.previous) return r.total ? "new" : "–";
  const pct = Math.round(((r.total - r.previous) / r.previous) * 100);
  const cls = pct < -20 ? "down" : pct > 20 ? "up" : "";
  return `<span class="${cls}">${pct > 0 ? "+" : ""}${pct}%</span>`;
}

function prLine(s: Scored): string {
  const after = s.settlement ? ` · ${settledNote(s.settlement)}` : "";
  const why = `${s.score.kind} · ${s.score.reach} · ~${s.score.expert_hours}h${after}. ${s.score.reason}`;
  return `<li><b>${s.joules} J</b> <a href="${esc(s.url)}">${esc(s.repo.split("/")[1]!)}#${s.number}</a> ${esc(s.score.summary || s.title)}<span class="why">${esc(why)}</span></li>`;
}

export function html(rows: Row[], o: { days: number; repos: string[]; compact: boolean; compare: boolean }): string {
  const max = Math.max(1, ...rows.map((r) => r.total));
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let table = `<tr><th>Engineer</th><th>24h</th><th>7 days</th><th>${o.days} days</th>${o.compare ? `<th>vs prior ${o.days}</th>` : ""}<th>PRs</th><th>J / workday</th><th class="bar"></th></tr>`;
  let people = "";
  for (const r of rows) {
    table += `<tr><td class="who">${esc(r.author)}</td><td>${r.day}</td><td>${r.week}</td><td class="big">${r.total}</td>`;
    if (o.compare) table += `<td>${trend(r)}</td>`;
    table += `<td>${r.prs}</td><td>${r.perWorkday}</td><td class="bar"><i style="width:${Math.round((r.total / max) * 100)}%"></i></td></tr>`;
    if (o.compact) continue;
    people += `<section><h2>${esc(r.author)} <small>${r.total} J · ${r.prs} PRs</small></h2><h3>Most value</h3><ol>${r.top.map(prLine).join("")}</ol>`;
    if (r.bottom.length) people += `<h3>Least value</h3><ol>${r.bottom.map(prLine).join("")}</ol>`;
    people += "</section>";
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Joules</title><style>
@page { size: A4; margin: 18mm }
body { font-family: -apple-system, "Helvetica Neue", sans-serif; color: #111; margin: 0; padding: 28px 32px; background: #fff; }
h1 { font-size: 26px; margin: 0 0 2px; letter-spacing: -0.5px } h1 span { color: #f59e0b }
.sub { color: #666; font-size: 13px; margin-bottom: 22px }
table { width: 100%; border-collapse: collapse; font-size: 14px }
th { text-align: right; font-weight: 500; color: #666; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid #ddd }
th:first-child, td.who { text-align: left }
td { text-align: right; padding: 9px 8px; border-bottom: 1px solid #f0f0f0; font-variant-numeric: tabular-nums }
td.big { font-weight: 700; font-size: 16px } td.who { font-weight: 600 }
.bar { width: 22%; } .bar i { display: block; height: 8px; border-radius: 4px; background: #f59e0b }
.up { color: #15803d } .down { color: #b91c1c; font-weight: 600 }
section { break-inside: avoid; margin-top: 26px } h2 { font-size: 17px; margin: 0 0 6px } h2 small { color: #666; font-weight: 400; font-size: 13px }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #888; margin: 10px 0 4px }
ol { margin: 0; padding-left: 18px; font-size: 13px } li { margin: 4px 0 }
a { color: #111 } .why { display: block; color: #777; font-size: 12px }
.note { color: #888; font-size: 11px; margin-top: 22px }
</style></head><body>
<h1><span>⚡</span> Joules</h1>
<div class="sub">${date} · ${o.repos.length} repos: ${esc(o.repos.map((r) => r.split("/")[1]).join(", "))}</div>
<table>${table}</table>${people}
<div class="note">Joules = expert hours (how long a senior engineer would need without AI) × reach (${weights(REACH)}) × kind (${weights(KINDS)}). After ${SETTLE_DAYS} days a reverted PR drops to 0 and each follow-up fix takes a quarter off. Bots and release PRs left out.</div>
</body></html>`;
}
