#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { headline, readStamp, type Stamp, withStamp } from "./block.ts";
import { gh, isRelease, type Pull, pullContext } from "./github.ts";
import { collect, html, leaderboard, markdown } from "./report.ts";
import { rate } from "./score.ts";
import { settleRepo } from "./settle.ts";
import { markAi, statsHtml, statsOf } from "./stats.ts";
import { commentOnTickets } from "./tickets.ts";

const HELP = `joules: score the value each pull request ships

  joules score <owner/repo#123> [--write]      score one PR (--write puts the block in its description and posts on its tickets)
  joules report --repos a/b,c/d [--days 30]    leaderboard per engineer (--html out.html, --compare, --compact)
  joules backfill --repos a/b,c/d --days 90    score past PRs into the cache, nothing written to GitHub
  joules stats --repos a/b,c/d [--days 90]     per engineer: weekly Joules, typical day, rework, AI share (--html out.html, --title, --names login=Name,…, --note)
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
  const scored = await collect({ ...options, compare: false });
  await markAi(scored, values.cache, options.concurrency);
  const names: Record<string, string> = {};
  for (const login of new Set(scored.map((s) => s.author))) names[login] = (await gh<{ name: string | null }>(`/users/${login}`)).name ?? login;
  for (const pair of values.names.split(",").filter(Boolean)) {
    const [login, name] = pair.split("=");
    if (login && name) names[login] = name;
  }
  const rows = statsOf(scored, options.days, names);
  console.log(JSON.stringify(rows, null, 1));
  if (values.html) writeFileSync(values.html, statsHtml(rows, { title: values.title, days: options.days, repos, note: values.note }));
} else {
  console.error(`Unknown command ${command}\n\n${HELP}`);
  process.exit(1);
}
