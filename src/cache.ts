import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Score } from "./score.ts";

/** One scored PR (or a week of branch work, number 0), kept by its URL so nothing is scored twice. */
export type Entry = { repo: string; number: number; title: string; author: string; url: string; merged_at: string; score: Score };

export function loadCache(path: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Entry;
    out.set(e.url, e);
  }
  return out;
}

export const saveEntry = (path: string, e: Entry) => appendFileSync(path, `${JSON.stringify(e)}\n`);
