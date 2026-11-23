import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = () => process.env.MUNINN_HOME ?? join(homedir(), ".muninn");
export function ensureHome(): string {
  const h = home();
  mkdirSync(h, { recursive: true });
  chmodSync(h, 0o700);
  return h;
}
export const DEFAULTS = {
  minSessions: 3,
  similarityCutoff: 0.85,
  shownPerRun: 10,
  autoLearn: true,
  autoMinNewSessions: 5,
  autoMinHours: 24,
  /** During a long session (one that never ends), scan for lessons at most this often. */
  autoLongSessionHours: 6,
  /** How big a session's log must be to count as long, in bytes. */
  longSessionBytes: 1_000_000,
  maxPerDelivery: 3,
  tokensPerDelivery: 300,
  tokensPerSession: 1000,
  hookLimitMs: 500,
  notesPerRun: 30,
  /** How old a handoff can be and still be given to the next session. 0 means no limit. */
  handoffDays: 0,
  /** Past this many days, a handoff is given with a note that it may be out of date. */
  handoffStaleDays: 7,
  handoffsPerRun: 3,
  /** Model for summaries: handoffs, plain lines, answers. "" uses the client default. */
  backgroundModel: "haiku",
  /** Model for deciding what is worth a lesson. "" uses the client default. */
  judgeModel: "",
  /** Your own prices per million tokens, for models muninn doesn't know (Gemini, a discount): {"gemini-4-neon-high": {"input": 1.25, "output": 10, "cacheRead": 0.31}}. Matched by name prefix. */
  prices: {} as Record<string, { input: number; output: number; cacheRead?: number }>,
  /** Coding tools you unticked in setup: no hooks or rules files for them, and their logs aren't read. */
  leaveAlone: [] as ("claude-code" | "codex" | "cursor" | "antigravity")[],
};
export type Settings = typeof DEFAULTS;
export function settings(): Settings {
  const f = join(home(), "config.json");
  return existsSync(f) ? { ...DEFAULTS, ...JSON.parse(readFileSync(f, "utf8")) } : { ...DEFAULTS };
}
export const logRoots = () => {
  const r = process.env.MUNINN_LOG_ROOT;
  return {
    claude: r ? join(r, "claude", "projects") : join(homedir(), ".claude", "projects"),
    codex: r ? join(r, "codex", "sessions") : join(homedir(), ".codex", "sessions"),
    cursor: r ? join(r, "cursor", "projects") : join(homedir(), ".cursor", "projects"),
    // Antigravity keeps one app-data folder per edition: the app, the IDE and the command line.
    antigravity: r ? join(r, "antigravity") : join(homedir(), ".gemini"),
  };
};
/** Saves some settings to ~/.muninn/config.json, keeping the others as they are. */
export function saveSettings(change: Partial<Settings>) {
  const f = join(ensureHome(), "config.json");
  const now = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  writeFileSync(f, JSON.stringify({ ...now, ...change }, null, 2) + "\n");
}
/** Whether you asked setup to leave a coding tool alone. */
export const leftAlone = (tool: string) => (settings().leaveAlone ?? []).includes(tool as never);
export const isPaused = () => existsSync(join(home(), "paused"));
