import { filesAndDiff, gh, isIntegrationBranch, type PullContext, type PullFile } from "./github.ts";
import { DAY } from "./settle.ts";

/**
 * Work that never goes through a PR: someone's commits on a branch with no PR (a long-lived v2 branch,
 * an upstream branch), one unit per person per week. A commit already on the default branch, in a merged
 * PR, or a merge commit is left out, so nothing counts twice.
 */
export type BranchWork = { url: string; title: string; author: string; at: string; shas: string[]; branches: string[] };

type Commit = { sha: string; parents: unknown[]; author: { login: string; type: string } | null; commit: { message: string; author: { date: string } } };

export async function branchWork(repo: string, since: Date): Promise<BranchWork[]> {
  const base = (await gh<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
  const withPr = new Set<string>();
  for (let page = 1; ; page++) {
    const batch = await gh<{ head: { ref: string } }[]>(`/repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
    for (const p of batch) withPr.add(p.head.ref);
    if (batch.length < 100) break;
  }
  const branches: string[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh<{ name: string }[]>(`/repos/${repo}/branches?per_page=100&page=${page}`);
    for (const b of batch) if (b.name !== base && !withPr.has(b.name) && !isIntegrationBranch(b.name)) branches.push(b.name);
    if (batch.length < 100) break;
  }
  const found = new Map<string, Commit & { on: Set<string> }>();
  for (const branch of branches) {
    for (let page = 1; ; page++) {
      const ahead = await gh<{ commits: Commit[] }>(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?per_page=100&page=${page}`);
      for (const c of ahead.commits) {
        if (c.parents.length !== 1 || new Date(c.commit.author.date) < since || !c.author || c.author.type === "Bot") continue;
        const seen = found.get(c.sha) ?? { ...c, on: new Set<string>() };
        seen.on.add(branch);
        found.set(c.sha, seen);
      }
      if (ahead.commits.length < 100) break;
    }
  }
  const byWeek = new Map<string, (Commit & { on: Set<string> })[]>();
  for (const c of found.values()) {
    // In a merged PR it was scored there; an open or closed PR (a branch built on this one) counts it nowhere.
    if ((await gh<{ merged_at: string | null }[]>(`/repos/${repo}/commits/${c.sha}/pulls`)).some((p) => p.merged_at)) continue;
    const who = c.author!.login;
    const day = new Date(c.commit.author.date);
    const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    const key = `${who} ${monday}`;
    const list = byWeek.get(key) ?? [];
    list.push(c);
    byWeek.set(key, list);
  }
  const out: BranchWork[] = [];
  for (const [key, commits] of byWeek) {
    const [author, monday] = key.split(" ") as [string, string];
    commits.sort((a, b) => a.commit.author.date.localeCompare(b.commit.author.date));
    const last = commits.at(-1)!;
    const on = [...new Set(commits.flatMap((c) => [...c.on]))];
    out.push({
      url: `https://github.com/${repo}/commit/${last.sha}#${author}`,
      title: `Unmerged work on ${on.join(", ")}: ${commits.length} commit${commits.length > 1 ? "s" : ""}, week of ${monday}`,
      author,
      at: last.commit.author.date,
      shas: commits.map((c) => c.sha),
      branches: on,
    });
  }
  return out;
}

/** What the model reads for a week of branch work: the commit messages and their combined diff. */
export async function branchContext(repo: string, w: BranchWork): Promise<PullContext> {
  const files = new Map<string, PullFile>();
  const messages: string[] = [];
  for (const sha of w.shas) {
    const c = await gh<{ commit: { message: string }; files?: PullFile[] }>(`/repos/${repo}/commits/${sha}`);
    messages.push(`- ${c.commit.message.split("\n")[0]}`);
    for (const f of c.files ?? []) {
      const was = files.get(f.filename);
      files.set(f.filename, was ? { ...was, additions: was.additions + f.additions, deletions: was.deletions + f.deletions, patch: `${was.patch ?? ""}\n${f.patch ?? ""}` } : f);
    }
  }
  const body = `A week of commits on a branch with no PR yet. Score the work in it the same way as a PR.\n\nCommits:\n${messages.join("\n")}`;
  return { repo, number: 0, title: w.title, body, author: w.author, tickets: [], ...filesAndDiff([...files.values()]) };
}
