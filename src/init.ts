import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOK = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/joules-pre-pr.sh';

const NOTE = `
## Pull requests: Joules

Every PR description ends with a Joules block. Before opening a PR, score the branch with the joules skill (\`.claude/skills/joules/SKILL.md\`) and add its block at the end of the body.
`;

type Settings = { hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]> };

/**
 * Puts Joules into a repo so every agent working there scores its PRs with no setup of its own: the skill,
 * the pre-PR hook in the project's Claude settings (merged with what's there), a note in AGENTS.md or
 * CLAUDE.md for agents that read those, and the GitHub workflow. Running it again changes nothing.
 */
export function init(dir: string): string[] {
  // Read the settings before writing anything, so a file it can't parse leaves the repo untouched.
  const settingsPath = join(dir, ".claude/settings.json");
  let settings: Settings = {};
  try {
    if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  } catch {
    throw new Error(`Can't parse .claude/settings.json: add a PreToolUse hook on Bash running ${HOOK} by hand.`);
  }
  const done: string[] = [];
  const write = (path: string, from: string) => {
    const content = readFileSync(join(ROOT, from), "utf8");
    if (existsSync(join(dir, path)) && readFileSync(join(dir, path), "utf8") === content) return;
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
    done.push(path);
  };
  write(".claude/skills/joules/SKILL.md", "skill/joules/SKILL.md");
  write(".claude/skills/joules/rubric.md", "skill/joules/rubric.md");
  write(".claude/hooks/joules-pre-pr.sh", "hooks/pre-pr.sh");
  chmodSync(join(dir, ".claude/hooks/joules-pre-pr.sh"), 0o755);
  if (!existsSync(join(dir, ".github/workflows/joules.yml"))) write(".github/workflows/joules.yml", "examples/joules.yml");

  const pre = (settings.hooks ??= {}).PreToolUse ?? [];
  if (!pre.some((h) => h.hooks?.some((c) => c.command === HOOK))) {
    settings.hooks.PreToolUse = [...pre, { matcher: "Bash", hooks: [{ type: "command", command: HOOK }] }];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    done.push(".claude/settings.json");
  }

  // AGENTS.md when the repo has one (Codex, Cursor and most agents read it), else CLAUDE.md.
  const notes = existsSync(join(dir, "AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md";
  const text = existsSync(join(dir, notes)) ? readFileSync(join(dir, notes), "utf8") : "";
  if (!text.includes("joules")) {
    writeFileSync(join(dir, notes), `${text.trimEnd()}${text ? "\n" : ""}${NOTE}`);
    done.push(notes);
  }
  // A repo that ignores .claude/ would keep these on this machine only: say so rather than fail quietly.
  const ignored = Bun.spawnSync(["git", "check-ignore", ...done], { cwd: dir }).stdout.toString().trim();
  if (ignored) console.error(`Git ignores ${ignored.split("\n").join(", ")}: add exceptions to .gitignore so the team gets them.`);
  return done;
}
