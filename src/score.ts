import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PullContext } from "./github.ts";

export const KINDS = { feature: 1, fix: 1, perf: 1, refactor: 0.7, test: 0.6, docs: 0.4, chore: 0.4, deps: 0.3, revert: 0 } as const;
export const REACH = { customers: 3, team: 2, internal: 1.5, dev: 1 } as const;
type Kind = keyof typeof KINDS;
type Reach = keyof typeof REACH;

type Part = { what?: string; kind: Kind; reach: Reach; expert_hours: number };
/** kind, reach and expert_hours describe the whole PR (its biggest part's kind and reach, all the hours); `parts` when it bundles several things. */
export type Rating = Part & { parts?: Part[]; summary: string; reason: string };
export type Score = Rating & { joules: number; model: string; scored_at: string };

const partJoules = (p: Part) => p.expert_hours * REACH[p.reach] * KINDS[p.kind];

/** Joules = expert hours × reach × kind, summed over the parts, at least 1 for anything that isn't a revert. */
export function joulesOf(r: Pick<Rating, "kind" | "reach" | "expert_hours" | "parts">): number {
  const parts = r.parts?.length ? r.parts : [r];
  if (parts.every((p) => p.kind === "revert")) return 0;
  return Math.max(1, Math.round(parts.reduce((a, p) => a + partJoules(p), 0)));
}

const RUBRIC = readFileSync(join(import.meta.dir, "../skill/joules/rubric.md"), "utf8");

export function parseRating(text: string): Rating {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const r = JSON.parse(json) as Rating;
  const parts = (r.parts?.length ? r.parts : [r]).slice(0, 5);
  for (const p of parts) {
    if (!(p.kind in KINDS)) throw new Error(`unknown kind ${p.kind}`);
    if (!(p.reach in REACH)) throw new Error(`unknown reach ${p.reach}`);
    p.expert_hours = Math.min(120, Math.max(0.25, Number(p.expert_hours) || 0.25));
  }
  const top = parts.reduce((a, b) => (partJoules(b) > partJoules(a) ? b : a));
  const hours = parts.reduce((a, p) => a + p.expert_hours, 0);
  return { kind: top.kind, reach: top.reach, expert_hours: hours, ...(parts.length > 1 && { parts }), summary: r.summary, reason: r.reason };
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
