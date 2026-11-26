import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Scored, workdays } from "./report.ts";
import { DAY } from "./settle.ts";

/**
 * The share card: one person's Joules over a window, as numbers only (no repo names, no PR titles), so it
 * is safe to post from private work. skill/joules/card.html draws it and works out the rest: Joules per
 * weekday, how many times the median engineer with AI that is, and the rank.
 */
export type Card = { who: string; period: string; joules: number; weekdays: number; prs: number; bars: number[] };

/** Windows ending now: the days counted, the days in one bar, and how the card names it. */
export const PERIODS = {
  week: { days: 7, bar: 1, label: "7 days" },
  month: { days: 28, bar: 1, label: "4 weeks" },
  year: { days: 364, bar: 7, label: "52 weeks" },
} as const;
export type Period = keyof typeof PERIODS;

export function cardOf(scored: Scored[], period: Period, who: string, now = Date.now()): Card {
  const { days, bar, label } = PERIODS[period];
  const bars = new Array<number>(days / bar).fill(0);
  let prs = 0;
  for (const s of scored) {
    const age = Math.max(0, now - new Date(s.merged_at).getTime());
    if (age >= days * DAY) continue;
    bars[bars.length - 1 - Math.floor(age / (bar * DAY))]! += s.joules;
    if (s.number) prs++;
  }
  const to = new Date(now).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return { who, period: `${label} to ${to}`, joules: bars.reduce((a, b) => a + b, 0), weekdays: workdays(days, new Date(now)), prs, bars };
}

/** The card page with these numbers in it: the template's one DATA line replaced. */
export function cardHtml(card: Card): string {
  const data = JSON.stringify(card).replace(/</g, "\\u003c");
  return readFileSync(join(import.meta.dir, "../skill/joules/card.html"), "utf8").replace(/^const DATA = .*$/m, () => `const DATA = ${data};`);
}

/** A Chrome, Chromium or Edge on this machine (CHROME_PATH first), to draw the PNG. */
function chrome(): string | undefined {
  const mac = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"].map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  const windows = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
  const found = [process.env.CHROME_PATH, ...mac, ...windows].find((path) => path && existsSync(path));
  return found ?? ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].map((name) => Bun.which(name)).find((path) => path) ?? undefined;
}

/** Draws the card page as a 2400 × 1350 PNG with a headless Chrome. False when this machine has none: the page's own Download button does the same. */
export function cardPng(html: string, png: string): boolean {
  const browser = chrome();
  if (!browser) return false;
  // Chrome refuses to sandbox as root (containers, CI).
  const root = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const args = ["--headless=new", ...root, "--hide-scrollbars", "--window-size=1200,675", "--force-device-scale-factor=2", "--virtual-time-budget=2000", `--screenshot=${resolve(png)}`, `${pathToFileURL(resolve(html)).href}#png`];
  return Bun.spawnSync([browser, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 && existsSync(png);
}
