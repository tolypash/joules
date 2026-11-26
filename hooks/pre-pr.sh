#!/usr/bin/env bash
# Claude Code PreToolUse hook: before `gh pr create`, make sure the PR body carries a Joules block.
# If it doesn't, the command is held (exit 2) and Claude is told to score the branch with the joules skill first.
# Without python3 it lets the PR through: the GitHub Action scores it anyway.
command -v python3 >/dev/null || exit 0
python3 -c '
import json, shlex, sys
cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
if "gh pr create" not in cmd or "joules:start" in cmd:
    sys.exit(0)
try:
    args = shlex.split(cmd)
except ValueError:
    args = cmd.split()
for i, a in enumerate(args):
    path = args[i + 1] if a in ("--body-file", "-F") and i + 1 < len(args) else a.split("=", 1)[1] if a.startswith("--body-file=") else None
    if path:
        try:
            if "joules:start" in open(path).read():
                sys.exit(0)
        except OSError:
            pass
sys.stderr.write("Joules: this PR has no score yet. Read .claude/skills/joules/SKILL.md (the joules skill), score the branch and add its block at the end of the PR body, then run gh pr create again.\n")
sys.exit(2)
'
