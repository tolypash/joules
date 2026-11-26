import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Score } from "./score.ts";

/** One scored PR, kept so a report or backfill never scores the same PR twice. `ai`: a commit credits Claude (stats.ts). */
export type Entry = { repo: string; number: number; title: string; author: string; url: string; merged_at: string; score: Score; ai?: boolean };

export const keyOf = (repo: string, number: number) => `${repo}#${number}`;

export function loadCache(path: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Entry;
    out.set(keyOf(e.repo, e.number), e);
  }
  return out;
}

export const saveEntry = (path: string, e: Entry) => appendFileSync(path, `${JSON.stringify(e)}\n`);
