import { loadCache, saveEntry } from "./cache.ts";
import { gh, isRelease, type Pull, pullContext } from "./github.ts";
import { pool } from "./report.ts";
import { rate } from "./score.ts";
import { DAY } from "./settle.ts";

/**
 * Measures what a typical full-time engineer shipped before AI coding: Joules per weekday over a past
 * window, for everyone who merged something in most of its weeks, from a sample of their PRs scored
 * with the same rubric as today. The median of them is the BASELINE that efficiency is measured against.
 */
export type Engineer = { repo: string; author: string; prs: number; sampled: number; perPr: number; perWeekday: number };

type Found = { number: number; title: string; user: { login: string; type: string }; pull_request: { merged_at: string } };

export function weekdaysBetween(from: Date, to: Date): number {
  let count = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

/** Merged PRs in the window, a month at a time so no search passes GitHub's 1,000-result cap. */
async function mergedBetween(repo: string, from: Date, to: Date): Promise<Found[]> {
  const out: Found[] = [];
  for (let start = from; start <= to; start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))) {
    const end = new Date(Math.min(to.getTime(), Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)));
    const range = `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
    for (let page = 1; page <= 10; page++) {
      const res = await gh<{ items: Found[] }>(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:${range}`)}&per_page=100&page=${page}`);
      out.push(...res.items);
      if (res.items.length < 100) break;
    }
  }
  return out;
}

export async function calibrate(o: { repos: string[]; from: Date; to: Date; sample: number; minWeeks: number; cache: string; model: string; concurrency: number }): Promise<Engineer[]> {
  const cache = loadCache(o.cache);
  const weeks = Math.round((o.to.getTime() - o.from.getTime()) / (7 * DAY));
  const weekdays = weekdaysBetween(o.from, o.to);
  const picked: { repo: string; author: string; prs: Found[]; sample: Found[] }[] = [];
  for (const repo of o.repos) {
    const by = new Map<string, Found[]>();
    for (const p of await mergedBetween(repo, o.from, o.to)) {
      if (p.user.type === "Bot" || p.user.login.endsWith("[bot]") || /^release(:|\s+v?\d)/i.test(p.title)) continue;
      const list = by.get(p.user.login) ?? [];
      list.push(p);
      by.set(p.user.login, list);
    }
    for (const [author, prs] of by) {
      const activeWeeks = new Set(prs.map((p) => Math.floor((new Date(p.pull_request.merged_at).getTime() - o.from.getTime()) / (7 * DAY)))).size;
      if (activeWeeks < o.minWeeks) continue;
      // Evenly spaced, so the sample is the same every run and spans the whole window.
      const sorted = [...prs].sort((a, b) => a.pull_request.merged_at.localeCompare(b.pull_request.merged_at));
      const step = Math.max(1, sorted.length / o.sample);
      const sample = Array.from({ length: Math.min(o.sample, sorted.length) }, (_, i) => sorted[Math.floor(i * step)]!);
      picked.push({ repo, author, prs, sample });
    }
  }
  const todo = picked.flatMap(({ repo, sample }) => sample.map((p) => ({ repo, p }))).filter(({ repo, p }) => !cache.has(`https://github.com/${repo}/pull/${p.number}`));
  console.error(`${picked.length} full-time engineers (merged in ${o.minWeeks}+ of ${weeks} weeks), scoring ${todo.length} sampled PRs`);
  await pool(todo, o.concurrency, async ({ repo, p }) => {
    try {
      const pr = await gh<Pull>(`/repos/${repo}/pulls/${p.number}`);
      if (isRelease(pr)) return;
      const e = { repo, number: p.number, title: p.title, author: p.user.login, url: pr.html_url, merged_at: p.pull_request.merged_at, score: await rate(await pullContext(repo, pr), o.model) };
      cache.set(e.url, e);
      saveEntry(o.cache, e);
    } catch (err) {
      console.error(`${repo}#${p.number}: ${(err as Error).message}`);
    }
  });
  const out: Engineer[] = [];
  for (const { repo, author, prs, sample } of picked) {
    const scored = sample.map((p) => cache.get(`https://github.com/${repo}/pull/${p.number}`)).filter((e) => e !== undefined);
    if (!scored.length) continue;
    const perPr = scored.reduce((a, e) => a + e.score.joules, 0) / scored.length;
    out.push({ repo, author, prs: prs.length, sampled: scored.length, perPr: Math.round(perPr * 10) / 10, perWeekday: Math.round(((perPr * prs.length) / weekdays) * 10) / 10 });
  }
  return out.sort((a, b) => b.perWeekday - a.perWeekday);
}
