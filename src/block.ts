import { joulesOf, KINDS, REACH, type Score } from "./score.ts";
import type { Settlement } from "./settle.ts";

/** What a PR carries in its description. `final` is set once the PR has settled (see settle.ts). */
export type Stamp = Score & { v: 1; stage: "open" | "merged"; final?: Settlement & { joules: number; at: string } };

const BLOCK = /<!-- joules:start -->[\s\S]*?<!-- joules:end -->/;

/** "feature · customers", or each part's kind ("feature + fix + deps") when a PR bundles several things. */
export const what = (s: Score) => (s.parts?.length ? s.parts.map((p) => p.kind).join(" + ") : `${s.kind} · ${s.reach}`);

export const headline = (s: Score, joules = s.joules) => `⚡ ${joules} J · ${what(s)} · ~${s.expert_hours} expert hours`;

/** "reverted", "1 follow-up fix", "2 follow-up fixes" or "no follow-up fixes". */
export function settledNote(s: Settlement): string {
  if (s.reverted) return "reverted";
  if (!s.fixes.length) return "no follow-up fixes";
  return `${s.fixes.length} follow-up fix${s.fixes.length > 1 ? "es" : ""}`;
}

function render(s: Stamp): string {
  const line = headline(s, s.final?.joules).replace(/^⚡ (\d+ J)/, "⚡ **$1**");
  return [
    "<!-- joules:start -->",
    s.final ? `${line} · settled, ${settledNote(s.final)}` : line,
    `<sub>${s.reason} · [Joules](https://github.com/tolypash/joules)</sub>`,
    `<!-- joules ${JSON.stringify(s)} -->`,
    "<!-- joules:end -->",
  ].join("\n");
}

/**
 * The score a PR carries. Agents write the block by hand, so its JSON may span lines, and the Joules are
 * worked out again from its parts rather than trusted; a block that isn't a rating reads as no score.
 */
export function readStamp(body: string | null | undefined): Stamp | undefined {
  const m = body?.match(/<!-- joules (\{[\s\S]*?\}) -->/);
  if (!m) return undefined;
  try {
    const s = JSON.parse(m[1]!) as Stamp;
    const parts = s.parts?.length ? s.parts : [s];
    if (!parts.every((p) => p.kind in KINDS && p.reach in REACH && Number.isFinite(p.expert_hours))) return undefined;
    return { ...s, joules: joulesOf(s) };
  } catch {
    return undefined;
  }
}

/** The body without the block, so a score never reads an earlier one. */
export const withoutStamp = (body: string | null | undefined) => (body ?? "").replace(BLOCK, "").trim();

/** The body with the block replaced, or added at the end. */
export function withStamp(body: string | null | undefined, s: Stamp): string {
  const text = body ?? "";
  return BLOCK.test(text) ? text.replace(BLOCK, () => render(s)) : `${text.trimEnd()}\n\n${render(s)}\n`;
}
