import { headline, readStamp, settledNote, type Stamp, withStamp } from "./block.ts";
import { gh, isBot, isRelease, mergedSince, type Pull, ticketsOf } from "./github.ts";
import { commentOnTickets } from "./tickets.ts";

export const DAY = 86_400_000;
export const SETTLE_DAYS = 14;

export type Settlement = { reverted: boolean; fixes: number[] };

/** The later PR's own kind when it was scored, else its title. */
const kindOf = (p: Pull) => readStamp(p.body)?.kind ?? (/^revert/i.test(p.title) ? "revert" : /fix|bug|patch/i.test(p.title) ? "fix" : undefined);

/** What happened after a PR merged: reverted, or fixed again by PRs that point back at it within SETTLE_DAYS. */
export function settlementOf(target: Pick<Pull, "number" | "merged_at">, later: Pull[]): Settlement {
  const from = new Date(target.merged_at!).getTime();
  const points = new RegExp(`(#|/pull/)${target.number}\\b`);
  const out: Settlement = { reverted: false, fixes: [] };
  for (const p of later) {
    const t = new Date(p.merged_at!).getTime();
    if (p.number === target.number || t <= from || t > from + SETTLE_DAYS * DAY) continue;
    if (!points.test(`${p.title} ${p.body ?? ""}`)) continue;
    const kind = kindOf(p);
    if (kind === "revert") out.reverted = true;
    else if (kind === "fix") out.fixes.push(p.number);
  }
  return out;
}

/** A quarter off per follow-up fix, never below a quarter; a revert is worth nothing. */
export function finalJoules(joules: number, s: Settlement): number {
  if (s.reverted || joules === 0) return 0;
  return Math.max(1, Math.round(joules * Math.max(0.25, 1 - 0.25 * s.fixes.length)));
}

export const isSettled = (mergedAt: string) => Date.now() - new Date(mergedAt).getTime() >= SETTLE_DAYS * DAY;

/** Settles every scored PR in the repo merged 14 to 28 days ago that hasn't been settled yet. */
export async function settleRepo(repo: string, write: boolean): Promise<void> {
  // The same PRs a report counts, so a release listing every PR it carries never reads as their fix.
  const pulls = (await mergedSince(repo, new Date(Date.now() - 2 * SETTLE_DAYS * DAY))).filter((p) => !isBot(p) && !isRelease(p));
  for (const p of pulls) {
    const stamp = readStamp(p.body);
    if (!stamp || stamp.final || !isSettled(p.merged_at!)) continue;
    const s = settlementOf(p, pulls);
    const final = { joules: finalJoules(stamp.joules, s), ...s, at: new Date().toISOString() };
    const note = `${headline(stamp, final.joules)} · settled, ${settledNote(s)}: ${p.title} (${p.html_url})`;
    console.log(`${repo}#${p.number} ${stamp.joules} J → ${note}`);
    if (!write) continue;
    const settled: Stamp = { ...stamp, final };
    await gh(`/repos/${repo}/pulls/${p.number}`, { method: "PATCH", body: { body: withStamp(p.body, settled) } });
    await commentOnTickets(ticketsOf(p), note);
  }
}
