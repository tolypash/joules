# ⚡ Joules

See the energy your team ships.

Joules gives every pull request a score for the value it delivers: what it does, who feels it and how hard it was. Not lines of code, not PR count. With AI writing thousands of lines in minutes, those numbers stopped meaning anything. A one-line fix to a payment bug can be worth more than a 5,000-line scaffold, and Joules says so.

```
⚡ 36 J · feature · customers · ~12 expert hours
Adds tips at checkout across the till, the web order page and the payment webhook.
```

## How a score is made

Claude reads the PR (title, description, linked ticket, the diff without lockfiles and generated code) and rates three things:

- **Expert hours:** how long a senior engineer who knows the codebase would have needed without AI. A typo is 0.25, a new setting end to end is 4, a new payment integration is 30.
- **Reach:** who feels it. Customers 3, the team 2, the system itself 1.5, only developers 1.
- **Kind:** feature, fix and perf 1; refactor 0.7; tests 0.6; docs and chores 0.4; dependency bumps 0.3; a revert 0.

**Joules = expert hours × reach × kind.** Every score comes with one line saying why, so anyone can see where the points came from. The rubric is [one file](skill/joules/rubric.md).

Fourteen days after merge the score settles: a reverted PR drops to 0 and each follow-up fix that points back at it takes a quarter off. Value that sticks counts most.

## What you get

- **On every PR:** the score in the description, written by the GitHub Action on open and again on merge.
- **On the ticket:** when the PR merges, its score goes on the linked Linear or Jira issue (`ABC-123` in the branch, title or description), and again when it settles.
- **Before the PR:** a Claude Code skill and hook that score the branch as you open the PR, so you see it first.
- **Team view:** `joules report` gives a table per person for the last 24 hours, 7 days and the window you pick (`--days`), and with `--html` each person's highest and lowest-value PRs. Good for a weekly shout-out, a sprint review, or spotting someone who's stuck and needs a hand.

## Set it up

**Quickest:** run `bunx joules-cli init` in a repo, commit what it adds, then add the secret below. Claude Code gets the skill and the pre-PR hook from the repo, other agents read the note in AGENTS.md or CLAUDE.md, and the workflow scores anything still unscored.

**Works on day one.** No history or setup needed: efficiency is measured against a typical full-time engineer before AI, 8 J a day, measured once on 39 engineers at Twenty, Novu, Formbricks and Documenso (Q4 2024). A team with its own pre-AI history can measure its own with `joules calibrate` (`--commits` if it didn't use PRs then) and pass `--baseline`.

**1. The Action.** Copy [examples/joules.yml](examples/joules.yml) to `.github/workflows/joules.yml` and add one secret:

- `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (runs on your Claude plan), or
- `ANTHROPIC_API_KEY`.

For tickets add `LINEAR_API_KEY`, or `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Scoring uses Haiku by default (`with: model: sonnet` to change it).

**2. The skill and hook (optional).** For anyone opening PRs with Claude Code:

```sh
git clone https://github.com/tolypash/joules ~/.joules
mkdir -p ~/.claude/skills && ln -s ~/.joules/skill/joules ~/.claude/skills/joules
```

and in `~/.claude/settings.json` (or the repo's `.claude/settings.json`):

```json
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.joules/hooks/pre-pr.sh" }] }] } }
```

**3. The CLI.** Needs [Bun](https://bun.sh), the [Claude Code CLI](https://docs.claude.com/claude-code) signed in, and `gh` signed in (or `GITHUB_TOKEN`).

```sh
bunx joules-cli score acme/shop#123            # one PR
bunx joules-cli backfill --repos acme/shop,acme/api --days 90
bunx joules-cli report --repos acme/shop,acme/api --days 30 --compare --html team.html
bunx joules-cli settle acme/shop --write          # what the Action does daily: reverts and follow-up fixes
bunx joules-cli stats --repos acme/shop --days 90 --html team.html   # per person: weekly Joules, typical day, rework
```

`stats` counts over the same scores as `report` (scoring PRs not yet in the cache); the counting itself is plain code, so the same scores give the same numbers every time. Scores are kept in `joules-cache.jsonl` so nothing is scored twice. A report reads scores the Action already wrote in PRs, and scores the rest.

## Good to know

- Scores are an estimate from a model reading the change. Treat a week or a month as the signal, not a single PR.
- The Action's score is the one that counts; the author's preview is overwritten on merge.
- Bots (Dependabot and friends) are scored but left out of the team table.
- Nothing leaves your GitHub except the PR text sent to Claude to score it.

## License

MIT
