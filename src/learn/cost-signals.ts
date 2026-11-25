import type { Session } from "../logs/types.js";
import { redact } from "../privacy/redact.js";
import { HEAVY_CONTEXT, sessionLabel, spendBreakdown, type SpendBreakdown } from "./spend.js";
import type { Moment } from "./signals.js";

/**
 * Ways agents spend tokens on context rather than work, found in the 24–25 Nov workbench run where they used up the
 * usage limit twice: one context kept alive through every phase, so each small step re-reads hundreds of thousands
 * of tokens; waiting in a loop of checks, each re-reading it all; and a short job handed to a big session that had
 * finished, instead of to a fresh agent with a short brief.
 */

/** Heavy steps in one session before it counts as kept alive too long. */
export const HEAVY_STEPS_MIN = 50;
/** Waits (a sleep-and-check loop, or watching a check) in one session before it counts as polling. */
export const WAITS_MIN = 5;
/** Idle this long, then picked up again: a session reused for a new job. */
export const IDLE_MIN = 30;
/** Context at pickup at or above this, for a job this short, is a small ask sent to a big session. */
export const BIG_SESSION = 400_000;
export const SHORT_JOB_STEPS = 60;
/** About what a fresh agent with a short brief carries. Context above it is what a fresh start would have saved. */
export const FRESH_CONTEXT = 60_000;

/** A shell command that waits: loops on a sleep, a long sleep, or watches checks until they finish. */
export const WAIT = /\b(until|while)\b[\s\S]*\bsleep\b|\bsleep\s+\d{2,}|SECONDS\s*\+\s*\d{2,}|\bgh\s+(pr\s+checks|run\s+view)\b[\s\S]*--watch|\bgh\s+run\s+watch\b/;

type Turn = NonNullable<Session["turns"]>[number];
const ctx = (t: Turn) => t.input + (t.cacheRead ?? 0);
const k = (n: number) => `${Math.round(n / 1000)}k`;
/** The context the next model call took in, at or after a time. */
function contextAt(turns: Turn[], ts: string): number {
  const t = turns.find((x) => x.ts >= ts) ?? turns.at(-1);
  return t ? ctx(t) : 0;
}
/** Every agent's log in a session: the session itself and its subagents, each with its own context. */
const allLogs = (sessions: Session[]) => sessions.flatMap((s) => [s, ...(s.subagents ?? []).map((x) => ({ ...x, title: `${x.agentType ?? "subagent"} agent in ${sessionLabel(s)}` }))]);
/** Worktrees of one repo share a folder: <repo>/.claude/worktrees/<name>. */
const repoFolder = (cwd: string) => cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, "").replace(/\/\.worktrees\/[^/]+.*$/, "");

type Hit = { session: string; tool: string; ts: string; quote: string; tokens: number };
function moment(signal: Moment["signal"], text: string, context: string, hits: Hit[]): Moment {
  return {
    signal, text: redact(text), context: redact(context),
    quotes: hits.slice(-3).map(({ tokens: _, ...h }) => ({ ...h, quote: redact(h.quote).slice(0, 300) })),
    sessions: new Set(hits.map((h) => h.session)).size, days: new Set(hits.map((h) => h.ts.slice(0, 10))).size, wordings: 1,
    tools: [...new Set(hits.map((h) => h.tool))], last: hits.map((h) => h.ts).sort().at(-1) ?? "",
    wasted: hits.reduce((a, h) => a + h.tokens, 0),
  };
}

export function costMoments(sessions: Session[]): Moment[] {
  const logs = allLogs(sessions);
  const out: Moment[] = [];

  // One context kept alive past HEAVY_CONTEXT for many steps.
  const heavy: Hit[] = [];
  for (const s of logs) {
    const turns = s.turns ?? [];
    const h = turns.filter((t) => ctx(t) >= HEAVY_CONTEXT);
    if (h.length < HEAVY_STEPS_MIN) continue;
    const avg = h.reduce((a, t) => a + ctx(t), 0) / h.length, max = Math.max(...h.map(ctx));
    heavy.push({ session: s.id, tool: s.tool, ts: h.at(-1)!.ts, quote: `${sessionLabel(s)}: ${h.length} steps at about ${k(avg)} context each, up to ${k(max)}`, tokens: h.reduce((a, t) => a + ctx(t) - FRESH_CONTEXT, 0) });
  }
  if (heavy.length) out.push(moment("heavy_context",
    `${heavy.length} session(s) kept one context alive past ${k(HEAVY_CONTEXT)} tokens for ${HEAVY_STEPS_MIN} or more steps, so every small step re-read all of it`,
    `About ${heavy.reduce((a, h) => a + h.tokens, 0)} tokens were re-read above what a fresh agent with a short brief carries (about ${k(FRESH_CONTEXT)}). Agents worked through several phases (building, review fixes, QA fixes, rebasing) in one context instead of a fresh agent per phase.`,
    heavy));

  // Waiting in a loop of checks.
  const waits: Hit[] = [];
  const byRepo = new Map<string, { session: string; ts: number }[]>();
  for (const s of logs) {
    const turns = s.turns ?? [];
    const w = s.events.filter((e) => e.k === "cmd" && WAIT.test(e.cmd));
    if (w.length < WAITS_MIN) continue;
    const tokens = w.reduce((a, e) => a + contextAt(turns, e.ts), 0);
    const first = w[0]!.k === "cmd" ? w[0]!.cmd.replace(/\s+/g, " ").slice(0, 120) : "";
    waits.push({ session: s.id, tool: s.tool, ts: w.at(-1)!.ts, quote: `${sessionLabel(s)}: waited ${w.length} times, each re-reading about ${k(tokens / w.length)}, e.g. $ ${first}`, tokens });
    const r = repoFolder(s.cwd);
    byRepo.set(r, [...(byRepo.get(r) ?? []), ...w.map((e) => ({ session: s.id, ts: Date.parse(e.ts) }))]);
  }
  if (waits.length) {
    // The most sessions waiting at once in one repo, within ten minutes of each other: queued behind one thing.
    let together = 0;
    for (const xs of byRepo.values()) for (const x of xs) together = Math.max(together, new Set(xs.filter((y) => Math.abs(y.ts - x.ts) <= 600_000).map((y) => y.session)).size);
    const n = waits.reduce((a, h) => a + Number(h.quote.match(/waited (\d+) times/)?.[1] ?? 0), 0);
    out.push(moment("wait_loop",
      `Agents waited in a loop of checks ${n} times in ${waits.length} session(s), and each check re-read the whole context${together >= 3 ? `; up to ${together} sessions were waiting at the same time` : ""}`,
      `About ${waits.reduce((a, h) => a + h.tokens, 0)} tokens re-read just to check whether something had finished. Running the slow step in the background and waiting for its completion notice costs nothing while waiting.${together >= 3 ? ` ${together} sessions queued at once means more agents ran in parallel than the shared resource (a test lock, a database) could serve.` : ""}`,
      waits));
  }

  // A short job given to a big session that had gone idle. Not a subagent (it only waits on its parent), and not a
  // pause for the usage limit: that session was resuming its own work, not handed a new job.
  const limits = sessions.flatMap((s) => [...(s.limitHits ?? []), ...(s.subagents ?? []).flatMap((x) => x.limitHits ?? [])]).map(Date.parse);
  const asks: Hit[] = [];
  for (const s of sessions) {
    const turns = s.turns ?? [];
    for (let i = 1; i < turns.length; i++) {
      const before = Date.parse(turns[i - 1]!.ts), after = Date.parse(turns[i]!.ts);
      const gap = (after - before) / 60_000;
      if (!(gap >= IDLE_MIN) || ctx(turns[i]!) < BIG_SESSION) continue;
      if (limits.some((t) => t >= before - 600_000 && t <= after)) continue;
      let j = i + 1;
      while (j < turns.length && (Date.parse(turns[j]!.ts) - Date.parse(turns[j - 1]!.ts)) / 60_000 < IDLE_MIN) j++;
      const job = turns.slice(i, j);
      if (job.length > SHORT_JOB_STEPS) continue;
      asks.push({ session: s.id, tool: s.tool, ts: turns[i]!.ts, quote: `${sessionLabel(s)}: picked up after ${Math.round(gap)} minutes idle with ${k(ctx(turns[i]!))} of context, for a ${job.length}-step job`, tokens: job.reduce((a, t) => a + Math.max(0, ctx(t) - FRESH_CONTEXT), 0) });
    }
  }
  if (asks.length) out.push(moment("big_session_ask",
    `A short job went to a big session that had finished, ${asks.length} time(s): each step re-read its whole history instead of a short brief`,
    `About ${asks.reduce((a, h) => a + h.tokens, 0)} tokens re-read above what a fresh agent would carry. Small follow-ups (a note, a docs change, a rebase) cost less from a fresh agent given the hand-over note.`,
    asks));
  return out;
}

/** The length of the usage window the limit counts. */
export const LIMIT_WINDOW_HOURS = 5;

export type LimitReport = { at: string; window: SpendBreakdown };
/**
 * Each time the usage limit was hit since `since`, what the window before it went on, across every session and repo.
 * Hits within an hour of each other are one hit, reported by many sessions.
 */
export function limitReports(sessions: Session[], since = ""): LimitReport[] {
  const hits = [...new Set(sessions.flatMap((s) => s.limitHits ?? []))].filter((t) => t >= since).sort();
  const firsts: string[] = [];
  for (const t of hits) if (!firsts.length || Date.parse(t) - Date.parse(firsts.at(-1)!) > 3_600_000) firsts.push(t);
  return firsts.map((at) => {
    const from = new Date(Date.parse(at) - LIMIT_WINDOW_HOURS * 3_600_000).toISOString();
    const cut = sessions.map((s) => ({ ...s, turns: (s.turns ?? []).filter((t) => t.ts <= at), subagents: s.subagents?.map((x) => ({ ...x, turns: (x.turns ?? []).filter((t) => t.ts <= at) })) }));
    return { at, window: spendBreakdown(cut, from) };
  });
}
