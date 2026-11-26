---
name: joules
description: Score the value a pull request ships, in Joules, and put the score block in the PR description before it's opened. Use when opening a PR (gh pr create), when asked "how many joules is this?", or when the joules hook asks for a score.
---

# Joules

Joules measure the value a change ships, not its size: **expert hours × reach × kind**. This is the author's preview; the Joules GitHub Action scores the PR again on open and on merge, and its score is the one that counts.

## Score this branch

1. Find the base branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, or the PR's base) and read the change: `git diff --stat origin/<base>...HEAD`, then `git diff origin/<base>...HEAD` (skip lockfiles, generated and vendored files).
2. Read [rubric.md](rubric.md) and rate the change exactly as it says: `kind`, `reach`, `expert_hours`, `summary`, `reason`. Judge what the change does, never how long it took you or how many lines it has.
3. Work out Joules: `expert_hours × reach × kind`, rounded, at least 1 (a revert is 0).
   - reach: customers 3, team 2, internal 1.5, dev 1
   - kind: feature, fix, perf 1; refactor 0.7; test 0.6; docs, chore 0.4; deps 0.3; revert 0
4. Put this block at the very end of the PR body (replace an older one between the same markers), with `stage` set to `preview`:

```
<!-- joules:start -->
⚡ **<joules> J** · <kind> · <reach> · ~<expert_hours> expert hours
<sub><reason> · [Joules](https://github.com/tolypash/joules)</sub>
<!-- joules {"v":1,"stage":"preview","kind":"…","reach":"…","expert_hours":0,"summary":"…","reason":"…","joules":0,"model":"<your model>","scored_at":"<ISO time>"} -->
<!-- joules:end -->
```

5. Open the PR as you were going to. Tell the user the score in one line.

With the CLI installed you can instead run `bunx joules-cli score <owner/repo#N> --write` once the PR exists.

## Shipping well with AI

- **One PR per scoped piece of work.** A feature with its backend, UI and tests goes in one PR with a clear high-level scope, not split into many small ones. The reviewer, and any AI pass over it, needs the whole diff to see duplication and simplify it. Split only what is truly independent. Run /simplify on the full PR diff before opening, not just the last commit.
- **Spend tokens on the work, not around it.** Point Claude at the files that matter instead of pasting whole folders, plan before a big change, and use a smaller model for mechanical work (renames, bulk edits, scoring).
- **Link follow-ups.** A fix for an earlier PR names it (`Fixes #123`), so the earlier PR's score settles honestly.
