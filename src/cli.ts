#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { headline, type Stamp, withStamp } from "./block.ts";
import { gh, type Pull, pullContext } from "./github.ts";
import { collect, html, leaderboard, markdown, pool } from "./report.ts";
import { rate } from "./score.ts";
import { settleRepo } from "./settle.ts";
import { calibrate } from "./calibrate.ts";
import { init } from "./init.ts";
import { BASELINE, statsHtml, statsOf } from "./stats.ts";
import { commentOnTickets } from "./tickets.ts";

const HELP = `joules: score the value each pull request ships

  joules init [dir]                            put Joules in a repo: every agent there scores its PRs (skill, hook, notes)
  joules score <owner/repo#123> [--write]      score one PR (--write puts the block in its description and posts on its tickets)
  joules report --repos a/b,c/d [--days 30]    leaderboard per engineer (--html out.html, --compare, --compact)
  joules backfill --repos a/b,c/d --days 90    score past PRs into the cache, nothing written to GitHub
  joules stats --repos a/b,c/d [--days 30]     per engineer: weekly Joules, typical day, rework (--html out.html, --title, --names login=Name,…, --note, --people a,b, --baseline J from calibrate, --part-time login=0.5)
  joules calibrate --repos a/b,c/d             the pre-AI baseline: Joules per weekday of full-time engineers (--from 2024-10-01 --to 2024-12-31 --sample 12 --min-weeks 8; --commits for teams that commit without PRs)
  joules settle <owner/repo> [--write]         settle PRs merged 14+ days ago (reverts, follow-up fixes); run it daily

  --model haiku        Claude model (alias or full id)
  --cache file.jsonl   where scores are kept (default joules-cache.jsonl)
  --concurrency 6      PRs scored at once`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: "boolean", default: false },
    repos: { type: "string", default: process.env.JOULES_REPOS ?? "" },
    days: { type: "string", default: "30" },
    model: { type: "string", default: "haiku" },
    cache: { type: "string", default: "joules-cache.jsonl" },
    concurrency: { type: "string", default: "6" },
    html: { type: "string" },
    compare: { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
    title: { type: "string", default: "Joules" },
    names: { type: "string", default: "" },
    note: { type: "string" },
    people: { type: "string", default: "" },
    "part-time": { type: "string", default: "" },
    baseline: { type: "string" },
    from: { type: "string", default: "2024-10-01" },
    to: { type: "string", default: "2024-12-31" },
    sample: { type: "string", default: "12" },
    "min-weeks": { type: "string", default: "8" },
    commits: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, target] = positionals;

/** "a=1,b=2" as { a: "1", b: "2" }. */
const pairs = (s: string): Record<string, string> => Object.fromEntries(s.split(",").map((p) => p.split("=")).filter(([k, v]) => k && v));

/** Scores a PR. With write it puts the block in the description and posts on its tickets; without, it only says what it would post. */
async function scorePull(repo: string, pr: Pull, write: boolean) {
  const ctx = await pullContext(repo, pr);
  const score = await rate(ctx, values.model);
  const stamp: Stamp = { v: 1, stage: pr.merged_at ? "merged" : "open", ...score };
  console.log(`${repo}#${pr.number} ${pr.title}\n${headline(score)}\n${score.reason}`);
  if (write) await gh(`/repos/${repo}/pulls/${pr.number}`, { method: "PATCH", body: { body: withStamp(pr.body, stamp) } });
  if (!ctx.tickets.length) return;
  const note = `${headline(score)}: ${pr.title} (${pr.html_url})\n${score.reason}`;
  const reached = await commentOnTickets(ctx.tickets, note, !write);
  console.log(reached.length ? `${write ? "Posted" : "Would post"} on ${reached.join(", ")}:\n${note}` : `No tracker knew ${ctx.tickets.join(", ")}`);
}

const repos = values.repos.split(",").map((r) => r.trim()).filter(Boolean);
const options = { repos, days: Number(values.days), cache: values.cache, model: values.model, concurrency: Number(values.concurrency) };

if (values.help || !command) console.log(HELP);
else if (command === "score") {
  const m = target?.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) ?? target?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`expected owner/repo#123, got ${target}`);
  await scorePull(m[1]!, await gh<Pull>(`/repos/${m[1]}/pulls/${m[2]}`), values.write);
} else if (command === "init") {
  const done = init(target ?? ".");
  console.log(done.length ? `Joules is in ${target ?? "this repo"}: ${done.join(", ")}` : "Already set up.");
} else if (command === "settle") {
  if (!target) throw new Error("expected owner/repo");
  await settleRepo(target, values.write);
} else if (command === "backfill") {
  const scored = await collect({ ...options, compare: false });
  console.log(`${scored.length} PRs scored in ${values.cache}`);
} else if (command === "report") {
  const scored = await collect({ ...options, compare: values.compare });
  const rows = leaderboard(scored, options.days, values.compare);
  console.log(markdown(rows, options.days));
  if (values.html) writeFileSync(values.html, html(rows, { days: options.days, repos, compact: values.compact, compare: values.compare }));
} else if (command === "stats") {
  // Whole weeks, so the oldest bar is never a part-week that reads as a slump.
  const days = Math.max(1, Math.round(options.days / 7)) * 7;
  const scored = await collect({ ...options, days, compare: false });
  const names = pairs(values.names);
  const unnamed = [...new Set(scored.map((s) => s.author))].filter((login) => !names[login]);
  await pool(unnamed, options.concurrency, async (login) => {
    names[login] = (await gh<{ name: string | null }>(`/users/${login}`)).name ?? login;
  });
  const people = new Set(values.people.split(",").filter(Boolean));
  const baseline = values.baseline ? Number(values.baseline) : BASELINE;
  const shares = Object.fromEntries(Object.entries(pairs(values["part-time"])).flatMap(([login, share]) => (Number(share) > 0 ? [[login, Number(share)]] : [])));
  const rows = statsOf(people.size ? scored.filter((s) => people.has(s.author)) : scored, days, names, Date.now(), baseline, shares);
  console.log(JSON.stringify(rows, null, 1));
  if (values.html) writeFileSync(values.html, statsHtml(rows, { title: values.title, days, repos, note: values.note, baseline }));
} else if (command === "calibrate") {
  const rows = await calibrate({ ...options, from: new Date(`${values.from}T00:00:00Z`), to: new Date(`${values.to}T23:59:59Z`), sample: Number(values.sample), minWeeks: Number(values["min-weeks"]), commits: values.commits });
  for (const r of rows) console.log(`${r.perWeekday} J/weekday  ${r.author} (${r.repos.join(", ")}): ${r.prs} ${values.commits ? "weeks" : "PRs"}, ${r.perPr} J each from ${r.sampled} sampled`);
  const sorted = rows.map((r) => r.perWeekday).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  console.log(`\nMedian of ${rows.length} engineers: ${median} J per weekday`);
} else {
  console.error(`Unknown command ${command}\n\n${HELP}`);
  process.exit(1);
}
