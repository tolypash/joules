import { withoutStamp } from "./block.ts";
import { ticketsIn } from "./tickets.ts";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

async function auth(): Promise<string> {
  if (!token) token = (await Bun.$`gh auth token`.quiet().text()).trim();
  return token;
}

export async function gh<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${await auth()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    // Out of the hourly allowance: wait for GitHub's reset rather than fail a long run.
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      console.error(`GitHub rate limit: waiting until ${new Date(reset).toISOString()}`);
      await Bun.sleep(Math.max(5000, reset - Date.now() + 1000));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await Bun.sleep(2 ** attempt * 5000);
      continue;
    }
    throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

export type Pull = {
  number: number;
  merge_commit_sha?: string | null;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string; type: string };
  draft?: boolean;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string };
};

/** Every page of a list endpoint (100 a page), up to `max` pages; `pick` finds the list in an object response. */
export async function pages<T, R = T[]>(path: string, pick: (r: R) => T[] = (r) => r as T[], max = Infinity): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= max; page++) {
    const batch = pick(await gh<R>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export type PullFile = { filename: string; additions: number; deletions: number; patch?: string; skipped?: boolean };

/** What the model reads about a PR. */
export type PullContext = { repo: string; number: number; title: string; body: string; author: string; tickets: string[]; files: PullFile[]; diff: string };

/** Lockfiles, build output, vendored and generated code: listed for the model, but their diff is left out. */
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Podfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|poetry\.lock)$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated|\.next|coverage)\/|\.(gen|generated)\.[a-z]+$|\.(min\.js|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|mp4|ttf|woff2?)$/i;

const DIFF_BUDGET = 16_000;
const PER_FILE = 2_500;

export const ticketsOf = (pr: Pull) => ticketsIn(`${pr.head.ref} ${pr.title} ${withoutStamp(pr.body)}`);

export async function pullContext(repo: string, pr: Pull): Promise<PullContext> {
  // The model sees at most 150 files and a 16k diff, so 300 files is plenty.
  const files = await pages<PullFile>(`/repos/${repo}/pulls/${pr.number}/files`, (r: PullFile[]) => r, 3);
  return { repo, number: pr.number, title: pr.title, body: withoutStamp(pr.body), author: pr.user.login, tickets: ticketsOf(pr), ...filesAndDiff(files) };
}

/** The file list (lockfiles and generated code marked) and a diff trimmed to what the model reads. */
export function filesAndDiff(raw: PullFile[]): Pick<PullContext, "files" | "diff"> {
  const files = raw.map((f) => ({ ...f, skipped: SKIP.test(f.filename) }));
  let diff = "";
  for (const f of files) {
    if (f.skipped || !f.patch || diff.length >= DIFF_BUDGET) continue;
    const patch = f.patch.length > PER_FILE ? `${f.patch.slice(0, PER_FILE)}\n… (file diff cut)` : f.patch;
    diff += `--- ${f.filename}\n${patch}\n`;
  }
  if (diff.length > DIFF_BUDGET) diff = `${diff.slice(0, DIFF_BUDGET)}\n… (rest of the diff cut)`;
  return { files: files.map(({ patch: _, ...f }) => f), diff };
}

/** Merged PRs in a repo since a date, newest first. */
export async function mergedSince(repo: string, since: Date): Promise<Pull[]> {
  const out: Pull[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh<Pull[]>(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    for (const p of batch) if (p.merged_at && new Date(p.merged_at) >= since) out.push(p);
    if (batch.length < 100 || new Date(batch.at(-1)!.updated_at) < since) break;
  }
  return out.sort((a, b) => b.merged_at!.localeCompare(a.merged_at!));
}

export const isBot = (p: { user: { login: string; type: string } }) => p.user.type === "Bot" || p.user.login.endsWith("[bot]");

/** A release or branch-promotion PR (staging into master) carries other PRs that were scored on their own. */
export const isReleaseTitle = (title: string) => /^release(:|\s+v?\d)/i.test(title);
export const isRelease = (p: Pull) => isReleaseTitle(p.title) || isIntegrationBranch(p.head.ref);

/** staging, master, release/2.6 and the like: branches that carry other people's work along. */
export const isIntegrationBranch = (ref: string) => /(^|\/)(release|staging|develop|dev|main|master)(\/|$)|merge-staging|staging-master/i.test(ref);
