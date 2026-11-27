---
name: joules
description: Score the value a pull request ships, in Joules, put the score in the PR description and on its ticket, judge an engineer's or a team's output against measured levels (pre-AI, good, cracked), and make a card of someone's Joules to share. Use when opening a PR (gh pr create or a GitHub tool), when asked "how many joules is this?" or how someone is doing, when asked to share or post their Joules, or when the joules hook asks for a score.
---

# Joules

Joules measure the value a change ships, not its size: **expert hours × reach × kind**. You score the PR as you open it, and this is the score that counts, so judge it honestly.

## Score this branch

1. Find the base branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, or the PR's base) and read the change: `git diff --stat origin/<base>...HEAD`, then `git diff origin/<base>...HEAD` (skip lockfiles, generated and vendored files).
2. Read [rubric.md](rubric.md) and rate the change exactly as it says: its `parts` (usually one; several when the PR bundles an upgrade, a feature and a fix), `summary` and `reason`. Judge what the change does, never how long it took you or how many lines it has.
3. Work out Joules: for each part `expert_hours × reach × kind`, added up and rounded, at least 1 (a revert is 0). In the block, `kind` and `reach` are the biggest part's and `expert_hours` is the total.
   - reach: customers 3, team 2, internal 1.5, dev 1
   - kind: feature, fix, perf 1; refactor 0.7; test 0.6; docs, chore 0.4; deps 0.3; revert 0
4. Put this block at the very end of the PR body (replace an older one between the same markers), with `stage` set to `open`. With several parts, the first line names each part's kind instead: `⚡ **54 J** · deps + feature + fix · ~54 expert hours`.

```
<!-- joules:start -->
⚡ **<joules> J** · <kind> · <reach> · ~<expert_hours> expert hours
<sub><reason> · [Joules](https://github.com/tolypash/joules)</sub>
<!-- joules {"v":1,"stage":"open","kind":"…","reach":"…","expert_hours":0,"parts":[only when several],"summary":"…","reason":"…","joules":0,"model":"<your model>","scored_at":"<ISO time>"} -->
<!-- joules:end -->
```

5. Open the PR as you were going to.
6. If the PR names a ticket (a key like `ABC-123` in the branch, title or body) and you have a Linear or Jira tool, comment on that ticket: the block's first line, the PR title and link, and the reason.
7. Tell the user the score in one line.

## What's good: the measured numbers

Use these when asked how an engineer or a team is doing. Add up the Joules in the block at the end of each PR they merged in a window (28 days reads well; once a PR has settled, use the settled score, `final.joules` in the block's JSON), divide by the weekdays in it, and compare.

**Joules per weekday of full-time engineers** (full-time: merged something in at least 8 of the 13 weeks; sampled PRs scored with this rubric by `joules calibrate`):

| | 25th pct | Median | 75th pct | Top 10% | Median PR |
|---|---:|---:|---:|---:|---:|
| Before AI: 71 engineers, Q4 2024 | 5 | **8.2** | 13.2 | 18 | 15.3 J |
| With AI: 128 engineers, Aug to Oct 2026 | 12.5 | **21.7** | 40.7 | 75.5 | 27.1 J |

Both measured on the same eight public product repos (Twenty, Novu, Formbricks, Documenso, n8n, Langfuse, Infisical and Plane), 30 sampled PRs per engineer.

So with AI the median engineer ships about 2.6× the Joules of the median engineer before AI, and the median PR is worth about 1.8× as much. The raw numbers are in [data/](https://github.com/tolypash/joules/tree/main/data).

**Efficiency** = Joules per weekday ÷ the pre-AI median × 100. 100% is the same output as the median engineer before AI; 300% is three times as much. Part-timers: divide by their share of a full week first (0.5 for half time).

| Level | Joules per weekday | Efficiency |
|---|---|---|
| Below pre-AI | under 8.2 | under 100% |
| Below typical (today's median) | 8.2 to 21.7 | 100% to 265% |
| Good: today's median, with AI | 21.7 or more | 265% or more |
| Cracked: today's top 10% | 75.5 or more | 921% or more |

**A team's own baseline.** A team with its own history before AI can measure it with the Joules CLI (needs [Bun](https://bun.sh)): `bunx joules-cli calibrate --repos owner/repo --from 2024-07-01 --to 2024-12-31` (`--commits` when it didn't use PRs) and use that instead of 8.2. One product team measured 13.4 J (3 full-time engineers, July to December 2024, `--commits`); against it good is 162% and cracked 563%.

**Reading it fairly:**
- Count weeks, not single PRs: one PR's score is an estimate.
- After 14 days a score settles: a reverted PR counts 0, and each fix merged in those 14 days that names it (`#123`) takes a quarter off (never below a quarter of the score, nor below 1 J). A team whose PRs keep needing fixes reads lower than its raw total.
- Work on a long-lived branch with no PR yet counts too: score each person's week of commits there as one change with the rubric, so someone building a v2 doesn't read as idle.
- Bots and release PRs (staging into master) are left out: the PRs they carry are scored on their own.
- Someone who also works in repos you didn't include reads low; so does anyone whose PRs wait days for review, since a PR counts on the day it merges.

## Share your Joules

When someone asks to share their Joules (a card, a post, "my week in Joules"), make their card: one image with their output (their efficiency: Joules per weekday as a % of the pre-AI median), how many times the median engineer shipping with AI that is, and where it sits on the ladder from Pre-AI to God. It carries numbers only, no repo names or PR titles, so it is safe to post from private work.

1. **Pick the window**, ending today: a week (7 days, 5 weekdays), a month (28 days, 20 weekdays; use this when they don't say) or a year (364 days, 260 weekdays).
2. **Add up their Joules in it.** List their merged PRs with `gh search prs --author @me --merged --merged-at ">=<first day>" --limit 1000 --json url,closedAt,body` (add `--repo owner/repo` to keep to one repo). Each PR counts the `joules` in its block's JSON, or `final.joules` once it has settled. Score a PR with no block from its diff with the rubric; when there are too many, leave them out and tell the user how many.
3. **Fill in the card.** [card.html](card.html), next to this file, draws everything from one line of numbers. Don't read it (it carries a font); copy it with that line replaced:

   ```sh
   sed 's|^const DATA = .*|const DATA = {"who":"@login","period":"4 weeks to 26 Nov 2026","joules":1612,"weekdays":20,"prs":41,"bars":[64,0,0,38]};|' card.html > joules-card.html
   ```

   `period` is the window in words ("7 days to …", "4 weeks to …", "52 weeks to …"). `bars` is the Joules of each day in the window, oldest first; for a year, of each week.
4. **Hand it over.** Open `joules-card.html` for them (`open`, `xdg-open` or `start`): it shows the card with Copy image, Download PNG, and Post on X with the text already written. Where you can't open a browser but have a Chrome, draw the image and send it instead (as root, add `--no-sandbox`):

   ```sh
   google-chrome --headless --screenshot=joules-card.png --window-size=1200,675 --force-device-scale-factor=2 --virtual-time-budget=2000 "file://$PWD/joules-card.html#png"
   ```

5. Tell them their line, ready to post: `⚡ 983% output · 4 weeks to 26 Nov 2026 · 3.7× the median engineer shipping with AI (Cracked)`.

The ladder's rungs are measured output with names of our own, each in its colour and drawn to a log scale: Pre-AI (100%), Autocomplete (152%), Vibe coder (217%), Good (265%, today's median), Cracked (921%, the top 10%) and God (5,066%, the highest measured). Autocomplete and Vibe coder are the 25th and 40th percentile of engineers shipping with AI. For a team with its own pre-AI baseline, add `"baseline":13.4` to the line. With the Joules CLI (needs [Bun](https://bun.sh)) steps 2 to 4 are one command, which also scores PRs that have no block: `bunx joules-cli card --period month`.

## Shipping well with AI

- **One PR per scoped piece of work.** A feature with its backend, UI and tests goes in one PR with a clear high-level scope, not split into many small ones. The reviewer, and any AI pass over it, needs the whole diff to see duplication and simplify it. Split only what is truly independent. Run /simplify on the full PR diff before opening, not just the last commit.
- **Spend tokens on the work, not around it.** Point Claude at the files that matter instead of pasting whole folders, plan before a big change, and use a smaller model for mechanical work (renames, bulk edits, scoring).
- **Link follow-ups.** A fix for an earlier PR names it (`Fixes #123`), so the earlier PR's score settles honestly.
