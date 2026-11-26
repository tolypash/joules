#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { headline, readStamp, type Stamp, withStamp } from "./block.ts";
import { gh, isRelease, type Pull, pullContext } from "./github.ts";
import { collect, html, leaderboard, markdown, pool } from "./report.ts";
import { rate } from "./score.ts";
import { settleRepo } from "./settle.ts";
import { calibrate } from "./calibrate.ts";
import { init } from "./init.ts";
import { BASELINE, statsHtml, statsOf } from "./stats.ts";
import { commentOnTickets } from "./tickets.ts";

const HELP = `joules: score the value each pull request ships

  joules init [dir]                            put Joules in a repo: every agent there scores its PRs (skill, hook, notes, workflow)
  joules score <owner/repo#123> [--write]      score one PR (--write puts the block in its description and posts on its tickets)
  joules report --repos a/b,c/d [--days 30]    leaderboard per engineer (--html out.html, --compare, --compact)
  joules backfill --repos a/b,c/d --days 90    score past PRs into the cache, nothing written to GitHub
  joules stats --repos a/b,c/d [--days 30]     per engineer: weekly Joules, typical day, rework (--html out.html, --title, --names login=Name,…, --note, --people a,b, --baseline J from calibrate)
  joules calibrate --repos a/b,c/d             the pre-AI baseline: Joules per weekday of full-time engineers (--from 2024-10-01 --to 2024-12-31 --sample 12 --min-weeks 8; --commits for teams that commit without PRs)
  joules settle <owner/repo> [--write]         settle PRs merged 14+ days ago (reverts, follow-up fixes)
  joules action                                in GitHub Actions: scores on open and merge, settles on a schedule

  --model haiku        Claude model (alias or full id)
  --cache file.jsonl   where scores are kept (default joules-cache.jsonl)
  --concurrency 6      PRs scored at once`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: "boolean", default: false },
    repos: { type: "string", default: process.env.JOULES_REPOS ?? "" },
    days: { type: "string", default: "30" },
    model: { type: "string", default: process.env.JOULES_MODEL || "haiku" },
    cache: { type: "string", default: "joules-cache.jsonl" },
    concurrency: { type: "string", default: "6" },
    html: { type: "string" },
    compare: { type: "boolean", default: false },
    compact: { type: "boolean", default: false },
    title: { type: "string", default: "Joules" },
    names: { type: "string", default: "" },
    note: { type: "string" },
    people: { type: "string", default: "" },
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

/** Scores a PR. With write it puts the block in the description and, once merged, posts on its tickets; without, it only says what it would post. */
async function scorePull(repo: string, pr: Pull, write: boolean) {
  const ctx = await pullContext(repo, pr);
  const score = await rate(ctx, values.model);
  const stamp: Stamp = { v: 1, stage: pr.merged_at ? "merged" : "open", ...score };
  console.log(`${repo}#${pr.number} ${pr.title}\n${headline(score)}\n${score.reason}`);
  if (write) await gh(`/repos/${repo}/pulls/${pr.number}`, { method: "PATCH", body: { body: withStamp(pr.body, stamp) } });
  if (!pr.merged_at || !ctx.tickets.length) return;
  const note = `${headline(score)}: ${pr.title} (${pr.html_url})\n${score.reason}`;
  const reached = await commentOnTickets(ctx.tickets, note, !write);
  console.log(reached.length ? `${write ? "Posted" : "Would post"} on ${reached.join(", ")}:\n${note}` : `No tracker knew ${ctx.tickets.join(", ")}`);
}

/** In GitHub Actions: score on open, score again and tell the tickets on merge, settle on a schedule. */
async function action() {
  const repo = process.env.GITHUB_REPOSITORY!;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as { action?: string; pull_request?: Pull };
  const pr = event.pull_request;
  if (!pr) return settleRepo(repo, true);
  if (event.action === "closed" && !pr.merged_at) return console.log("Closed without merging: nothing to score.");
  if (isRelease(pr)) return console.log("A release PR: the PRs it carries are scored on their own.");
  if (event.action !== "closed" && pr.draft) return console.log("A draft: scored when it's ready for review.");
  if (event.action !== "closed" && readStamp(pr.body)?.stage === "open") return console.log("Already scored on open; it's scored again on merge.");
  // Until the secret is added, say so instead of failing every PR's check.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) return console.log("No Claude secret yet: add CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY to the repo.");
  return scorePull(repo, pr, true);
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
} else if (command === "action") await action();
else if (command === "settle") await settleRepo(target ?? process.env.GITHUB_REPOSITORY!, values.write);
else if (command === "backfill") {
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
  const names: Record<string, string> = {};
  for (const pair of values.names.split(",").filter(Boolean)) {
    const [login, name] = pair.split("=");
    if (login && name) names[login] = name;
  }
  const unnamed = [...new Set(scored.map((s) => s.author))].filter((login) => !names[login]);
  await pool(unnamed, options.concurrency, async (login) => {
    names[login] = (await gh<{ name: string | null }>(`/users/${login}`)).name ?? login;
  });
  const people = new Set(values.people.split(",").filter(Boolean));
  const baseline = values.baseline ? Number(values.baseline) : BASELINE;
  const rows = statsOf(people.size ? scored.filter((s) => people.has(s.author)) : scored, days, names, Date.now(), baseline);
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
