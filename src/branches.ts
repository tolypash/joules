import { filesAndDiff, gh, isBot, isIntegrationBranch, pages, type Pull, type PullContext, type PullFile } from "./github.ts";
import { DAY } from "./settle.ts";

/**
 * Work that never goes through a PR: someone's commits on a branch with no PR (a long-lived v2 branch,
 * an upstream branch), one unit per person per week. A commit already on the default branch, in a merged
 * PR, or a merge commit is left out, so nothing counts twice.
 */
export type BranchWork = { url: string; title: string; author: string; merged_at: string; shas: string[] };

export type Commit = { sha: string; parents: unknown[]; author: { login: string; type: string } | null; commit: { author: { date: string } } };

/** `pulls`: the merged PRs already counted, so nothing in them is counted again as branch work. */
export async function branchWork(repo: string, since: Date, pulls: Pull[]): Promise<BranchWork[]> {
  const base = (await gh<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
  const merged = new Set(pulls.map((p) => p.merge_commit_sha ?? ""));
  const withPr = new Set((await pages<{ head: { ref: string } }>(`/repos/${repo}/pulls?state=all`)).map((p) => p.head.ref));
  const branches = (await pages<{ name: string }>(`/repos/${repo}/branches`)).map((b) => b.name).filter((b) => b !== base && !withPr.has(b) && !isIntegrationBranch(b));
  const found = new Map<string, Commit & { on: Set<string> }>();
  for (const branch of branches) {
    const ahead = await pages<Commit, { commits: Commit[] }>(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`, (r) => r.commits);
    for (const c of ahead) {
      if (c.parents.length !== 1 || merged.has(c.sha) || new Date(c.commit.author.date) < since || !c.author || isBot({ user: c.author })) continue;
      const seen = found.get(c.sha) ?? { ...c, on: new Set<string>() };
      seen.on.add(branch);
      found.set(c.sha, seen);
    }
  }
  const inMergedPr = await mergedPrCommits(repo, [...found.keys()]);
  return weeksOf(repo, [...found.values()].filter((c) => !inMergedPr.has(c.sha)));
}

/**
 * Which of these commits belong to a merged PR (scored there already; one in an open or closed PR counts
 * nowhere else, so it stays). Asked 50 at a time through GraphQL, so a long-lived branch costs a few calls.
 */
async function mergedPrCommits(repo: string, shas: string[]): Promise<Set<string>> {
  const [owner, name] = repo.split("/");
  const out = new Set<string>();
  for (let i = 0; i < shas.length; i += 50) {
    const batch = shas.slice(i, i + 50);
    const fields = batch.map((sha, j) => `c${j}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 5) { nodes { mergedAt } } } }`).join("\n");
    type Found = { associatedPullRequests: { nodes: { mergedAt: string | null }[] } } | null;
    const res = await gh<{ data: { repository: Record<string, Found> | null } | null; errors?: { message: string }[] }>("/graphql", { method: "POST", body: { query: `{ repository(owner: "${owner}", name: "${name}") { ${fields} } }` } });
    // GraphQL answers a failure with 200 and an errors list: say what it was.
    const found = res.data?.repository;
    if (!found) throw new Error(`GitHub GraphQL ${repo}: ${res.errors?.map((e) => e.message).join("; ")}`);
    batch.forEach((sha, j) => {
      if (found[`c${j}`]?.associatedPullRequests.nodes.some((p) => p.mergedAt)) out.add(sha);
    });
  }
  return out;
}

/** One unit per person per week of commits. With `on` (the branches they sit on) it reads as unmerged work. */
export function weeksOf(repo: string, commits: (Commit & { on?: Set<string> })[]): BranchWork[] {
  const byWeek = new Map<string, (Commit & { on?: Set<string> })[]>();
  for (const c of commits) {
    const day = new Date(c.commit.author.date);
    const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    const key = `${c.author!.login} ${monday}`;
    const list = byWeek.get(key) ?? [];
    list.push(c);
    byWeek.set(key, list);
  }
  const out: BranchWork[] = [];
  for (const [key, week] of byWeek) {
    const [author, monday] = key.split(" ") as [string, string];
    week.sort((a, b) => a.commit.author.date.localeCompare(b.commit.author.date));
    const on = [...new Set(week.flatMap((c) => [...(c.on ?? [])]))];
    const n = `${week.length} commit${week.length > 1 ? "s" : ""}`;
    out.push({
      // Person, week and size: a rebase keeps the key, a new commit or one merged away rescores the week.
      url: `https://github.com/${repo}/commits?author=${author}&week=${monday}&n=${week.length}`,
      title: on.length ? `Unmerged work on ${on.join(", ")}: ${n}, week of ${monday}` : `Work in the week of ${monday}: ${n}`,
      author,
      merged_at: week.at(-1)!.commit.author.date,
      shas: week.map((c) => c.sha),
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
  const body = `A week of one person's commits, not a PR. Score the work in it the same way as a PR.\n\nCommits:\n${messages.join("\n")}`;
  return { repo, number: 0, title: w.title, body, author: w.author, tickets: [], ...filesAndDiff([...files.values()]) };
}
