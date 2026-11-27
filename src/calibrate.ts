import { loadCache, saveEntry } from "./cache.ts";
import { branchContext, type Commit, weeksOf } from "./branches.ts";
import { gh, isBot, isRelease, isReleaseTitle, pages, type Pull, type PullContext, pullContext } from "./github.ts";
import { pool } from "./report.ts";
import { rate } from "./score.ts";
import { DAY } from "./settle.ts";

/**
 * Measures what a typical full-time engineer shipped before AI coding: Joules per weekday over a past
 * window, for everyone who merged something in most of its weeks, from a sample of their PRs scored
 * with the same rubric as today. The median of them is the BASELINE that efficiency is measured against.
 */
/** `prs`: the units counted, PRs or weeks of commits. */
export type Engineer = { repos: string[]; author: string; prs: number; sampled: number; perPr: number; perWeekday: number };

type Found = { number: number; title: string; html_url: string; user: { login: string; type: string }; pull_request: { merged_at: string } };

export function weekdaysBetween(from: Date, to: Date): number {
  let count = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

/** Merged PRs in the window, a week at a time: a search stops at 1,000 results, and busy repos merge more than that in a month. */
async function mergedBetween(repo: string, from: Date, to: Date): Promise<Found[]> {
  const out: Found[] = [];
  for (let start = from; start <= to; start = new Date(start.getTime() + 7 * DAY)) {
    const end = new Date(Math.min(to.getTime(), start.getTime() + 6 * DAY));
    const range = `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
    const found = await pages<Found, { items: Found[] }>(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:${range}`)}`, (r) => r.items, 10);
    if (found.length === 1000) console.error(`${repo} ${range}: hit GitHub's 1,000-result search cap, some merged PRs may be missing`);
    out.push(...found);
  }
  return out;
}

type Unit = { repo: string; author: string; at: string; url: string; title: string; context: () => Promise<PullContext> };

async function prUnits(repo: string, from: Date, to: Date): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const p of await mergedBetween(repo, from, to)) {
    if (isBot(p) || isReleaseTitle(p.title)) continue;
    const context = async () => {
      const pr = await gh<Pull>(`/repos/${repo}/pulls/${p.number}`);
      if (isRelease(pr)) throw new Error("a release PR");
      return pullContext(repo, pr);
    };
    out.push({ repo, author: p.user.login, at: p.pull_request.merged_at, url: p.html_url, title: p.title, context });
  }
  return out;
}

/** For teams that commit straight to their main branches: each person's week of commits is one unit, like branch work today. */
async function commitUnits(repo: string, from: Date, to: Date): Promise<Unit[]> {
  const base = (await gh<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
  const names = new Set((await pages<{ name: string }>(`/repos/${repo}/branches`)).map((b) => b.name));
  const commits = new Map<string, Commit>();
  for (const branch of [base, "master", "main"].filter((b, i, all) => names.has(b) && all.indexOf(b) === i)) {
    for (const c of await pages<Commit>(`/repos/${repo}/commits?sha=${branch}&since=${from.toISOString()}&until=${to.toISOString()}`)) {
      if (c.parents.length === 1 && c.author && !isBot({ user: c.author })) commits.set(c.sha, c);
    }
  }
  const out: Unit[] = [];
  for (const w of weeksOf(repo, [...commits.values()])) out.push({ repo, author: w.author, at: w.merged_at, url: w.url, title: w.title, context: () => branchContext(repo, w) });
  return out;
}

export async function calibrate(o: { repos: string[]; from: Date; to: Date; sample: number; minWeeks: number; commits: boolean; cache: string; model: string; concurrency: number }): Promise<Engineer[]> {
  const cache = loadCache(o.cache);
  const weeks = Math.round((o.to.getTime() - o.from.getTime()) / (7 * DAY));
  const weekdays = weekdaysBetween(o.from, o.to);
  // By login across all repos, as stats does, so someone split over two repos counts once and whole.
  const by = new Map<string, Unit[]>();
  for (const repo of o.repos) {
    for (const u of o.commits ? await commitUnits(repo, o.from, o.to) : await prUnits(repo, o.from, o.to)) {
      const list = by.get(u.author) ?? [];
      list.push(u);
      by.set(u.author, list);
    }
  }
  const picked: { author: string; units: Unit[]; sample: Unit[] }[] = [];
  for (const [author, units] of by) {
    const activeWeeks = new Set(units.map((u) => Math.floor((new Date(u.at).getTime() - o.from.getTime()) / (7 * DAY)))).size;
    if (activeWeeks < o.minWeeks) continue;
    // Evenly spaced, so the sample is the same every run and spans the whole window.
    const sorted = [...units].sort((a, b) => a.at.localeCompare(b.at));
    const step = Math.max(1, sorted.length / o.sample);
    picked.push({ author, units, sample: Array.from({ length: Math.min(o.sample, sorted.length) }, (_, i) => sorted[Math.floor(i * step)]!) });
  }
  const todo = picked.flatMap(({ sample }) => sample).filter((u) => !cache.has(u.url));
  console.error(`${picked.length} full-time engineers (active in ${o.minWeeks}+ of ${weeks} weeks), scoring ${todo.length} sampled ${o.commits ? "weeks of commits" : "PRs"}`);
  await pool(todo, o.concurrency, async (u) => {
    try {
      const e = { repo: u.repo, number: 0, title: u.title, author: u.author, url: u.url, merged_at: u.at, score: await rate(await u.context(), o.model) };
      cache.set(e.url, e);
      saveEntry(o.cache, e);
    } catch (err) {
      console.error(`${u.url}: ${(err as Error).message}`);
    }
  });
  const out: Engineer[] = [];
  for (const { author, units, sample } of picked) {
    const scored = sample.map((u) => cache.get(u.url)).filter((e) => e !== undefined);
    if (!scored.length) continue;
    const perPr = scored.reduce((a, e) => a + e.score.joules, 0) / scored.length;
    out.push({ repos: [...new Set(units.map((u) => u.repo))], author, prs: units.length, sampled: scored.length, perPr: Math.round(perPr * 10) / 10, perWeekday: Math.round(((perPr * units.length) / weekdays) * 10) / 10 });
  }
  return out.sort((a, b) => b.perWeekday - a.perWeekday);
}
