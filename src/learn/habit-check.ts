import type { Client } from "@libsql/client";
import type { Session } from "../logs/types.js";
import { WAIT } from "./cost-signals.js";
import { HEAVY_CONTEXT, spendOf } from "./spend.js";

/**
 * Whether a lesson about how agents are run (a fresh agent per phase, no polling, no small jobs for big sessions)
 * changed anything. These habits apply in every repo, so they're measured across all of them: the two weeks before
 * the lesson was kept against the time since, by what they were meant to cut and by dollars per merged pull request.
 */
export const HABIT_SIGNALS = new Set(["heavy_context", "wait_loop", "big_session_ask"]);
/** Days before keeping a lesson that count as "before". */
export const BEFORE_DAYS = 14;
/** Steps since keeping it before muninn says whether it worked. */
export const ENOUGH_STEPS = 200;

export type HabitNumbers = {
  sessions: number; steps: number;
  /** Share of steps that re-read HEAVY_CONTEXT or more. */
  heavyShare: number;
  contextAvg: number;
  /** Waiting checks per 100 steps. */
  waitsPer100: number;
  costUsd: number;
  /** Pull requests merged by agents (`gh pr merge` that worked). */
  merged: number;
};
const MERGE = /\bgh\s+pr\s+merge\b/;

/** What agents did between two times, across every session and subagent given. */
export function habitNumbers(sessions: Session[], from: string, to: string): HabitNumbers {
  const logs = sessions.flatMap((s) => [s, ...(s.subagents ?? [])]);
  let steps = 0, heavy = 0, read = 0, waits = 0, cost = 0, merged = 0; const used = new Set<string>();
  for (const s of logs) {
    const turns = (s.turns ?? []).filter((t) => t.ts >= from && t.ts < to);
    if (turns.length) used.add(s.id);
    const sp = spendOf(turns, s.model);
    steps += sp.steps; heavy += sp.heavySteps; read += sp.read; cost += sp.costUsd;
    for (const e of s.events) {
      if (e.k !== "cmd" || e.ts < from || e.ts >= to) continue;
      if (WAIT.test(e.cmd)) waits++;
      if (MERGE.test(e.cmd) && !e.failed) merged++;
    }
  }
  return { sessions: used.size, steps, heavyShare: steps ? heavy / steps : 0, contextAvg: steps ? read / steps : 0, waitsPer100: steps ? (waits * 100) / steps : 0, costUsd: cost, merged };
}

export type HabitCheck = { id: string; text: string; signal: string; keptAt: string; before: HabitNumbers; after: HabitNumbers; verdict: string };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => `${Math.round(n / 1000)}k`;
const usd = (x: number) => `$${x >= 10 ? Math.round(x) : x.toFixed(2)}`;
/** The number the lesson was meant to move, in words. */
function measure(signal: string, n: HabitNumbers): { value: number; words: string } {
  if (signal === "wait_loop") return { value: n.waitsPer100, words: `${n.waitsPer100.toFixed(1)} waiting checks per 100 steps` };
  return { value: n.heavyShare, words: `${pct(n.heavyShare)} of steps re-read over ${k(HEAVY_CONTEXT)} (about ${k(n.contextAvg)} per step on average)` };
}
export function habitVerdict(signal: string, before: HabitNumbers, after: HabitNumbers): string {
  if (after.steps < ENOUGH_STEPS) return `Too early to tell: ${after.steps} agent steps since you kept it, across every repo.`;
  const b = measure(signal, before), a = measure(signal, after);
  const perMerge = before.merged >= 2 && after.merged >= 2 ? `; ${usd(before.costUsd / before.merged)} per merged pull request before, ${usd(after.costUsd / after.merged)} since` : "";
  const moved = b.value === 0 ? (a.value === 0 ? "the same" : "worse") : a.value <= b.value * 0.7 ? "better" : a.value >= b.value * 1.1 ? "worse" : "about the same";
  const how = moved === "better" ? "It's working." : moved === "worse" ? "It's worse since: agents aren't following it, or the work changed. Check the sessions at the top of Where the spend went." : "No clear change yet.";
  return `${BEFORE_DAYS} days before: ${b.words}. Since: ${a.words}${perMerge}. ${how}`;
}

/** Every kept lesson about how agents are run, measured across all repos. */
export async function habitChecks(db: Client, sessions: Session[], now = new Date().toISOString()): Promise<HabitCheck[]> {
  const rows = (await db.execute({ sql: `SELECT id,text,signal,coalesce(reviewed_at,created_at) kept FROM lessons WHERE status='live' AND off=0 AND signal IN (${[...HABIT_SIGNALS].map(() => "?").join(",")}) ORDER BY kept`, args: [...HABIT_SIGNALS] })).rows;
  return rows.map((r) => {
    const kept = String(r.kept), signal = String(r.signal);
    const before = habitNumbers(sessions, new Date(Date.parse(kept) - BEFORE_DAYS * 86_400_000).toISOString(), kept);
    const after = habitNumbers(sessions, kept, now);
    return { id: String(r.id), text: String(r.text), signal, keptAt: kept, before, after, verdict: habitVerdict(signal, before, after) };
  });
}
