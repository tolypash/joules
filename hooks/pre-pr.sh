#!/usr/bin/env bash
# Claude Code PreToolUse hook: before a PR is opened (`gh pr create`, or a GitHub tool's create_pull_request),
# make sure its body carries a Joules block. If it doesn't, the call is held (exit 2) and Claude is told to
# score the branch with the joules skill first.
# Without python3 it lets the PR through rather than block work.
command -v python3 >/dev/null || exit 0
python3 -c '
import json, shlex, sys
call = json.load(sys.stdin)
given = call.get("tool_input") or {}
cmd = given.get("command") or ""
by_tool = str(call.get("tool_name", "")).endswith("create_pull_request")
if by_tool and "joules:start" in (given.get("body") or ""):
    sys.exit(0)
if not by_tool and ("gh pr create" not in cmd or "joules:start" in cmd):
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
sys.stderr.write("Joules: this PR has no score yet. Use the joules skill (.claude/skills/joules/ in the repo, or ~/.claude/skills/joules/) to score the branch and add its block at the end of the PR body, then open the PR again.\n")
sys.exit(2)
'
