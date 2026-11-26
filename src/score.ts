import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PullContext } from "./github.ts";

export const KINDS = { feature: 1, fix: 1, perf: 1, refactor: 0.7, test: 0.6, docs: 0.4, chore: 0.4, deps: 0.3, revert: 0 } as const;
export const REACH = { customers: 3, team: 2, internal: 1.5, dev: 1 } as const;
type Kind = keyof typeof KINDS;
type Reach = keyof typeof REACH;

export type Rating = { kind: Kind; reach: Reach; expert_hours: number; summary: string; reason: string };
export type Score = Rating & { joules: number; model: string; scored_at: string };

/** Joules = expert hours × reach × kind, at least 1 for anything that isn't a revert. */
export function joulesOf(r: Pick<Rating, "kind" | "reach" | "expert_hours">): number {
  const j = r.expert_hours * REACH[r.reach] * KINDS[r.kind];
  return r.kind === "revert" ? 0 : Math.max(1, Math.round(j));
}

const RUBRIC = readFileSync(join(import.meta.dir, "../skill/joules/rubric.md"), "utf8");

export function parseRating(text: string): Rating {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const r = JSON.parse(json) as Rating;
  if (!(r.kind in KINDS)) throw new Error(`unknown kind ${r.kind}`);
  if (!(r.reach in REACH)) throw new Error(`unknown reach ${r.reach}`);
  r.expert_hours = Math.min(120, Math.max(0.25, Number(r.expert_hours) || 0.25));
  return r;
}

/** Asks Claude through the Claude Code CLI: works with a Claude plan login, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. */
export async function rate(pr: PullContext, model: string): Promise<Score> {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", model, "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", RUBRIC],
    // A workflow passes every secret it might have; an empty one must not shadow the one that's set.
    { stdin: new Blob([promptOf(pr)]), stdout: "pipe", stderr: "pipe", cwd: process.env.TMPDIR ?? "/tmp", env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`);
  const rating = parseRating(out);
  return { ...rating, joules: joulesOf(rating), model, scored_at: new Date().toISOString() };
}

function promptOf(pr: PullContext): string {
  const files = pr.files.map((f) => `${f.filename} (+${f.additions} -${f.deletions})${f.skipped ? " [generated/lock, ignore]" : ""}`);
  return [
    `Repository: ${pr.repo}`,
    `PR #${pr.number}: ${pr.title}`,
    `Author: ${pr.author}`,
    pr.tickets.length ? `Linked tickets: ${pr.tickets.join(", ")}` : "",
    "",
    "Description:",
    pr.body.slice(0, 4000) || "(none)",
    "",
    `Files (${pr.files.length}):`,
    files.slice(0, 150).join("\n") + (files.length > 150 ? `\n… and ${files.length - 150} more` : ""),
    "",
    "Diff (trimmed):",
    pr.diff,
  ].join("\n");
}
