import type { Session } from "../logs/types.js";
import { costOf, priceOf } from "../workflow/prices.js";

/**
 * Where a session's tokens went, measured the way they're paid for. Every model call re-reads the whole context
 * (mostly from cache, at a tenth of the input price or less), so a long-lived session that takes many small steps
 * costs far more than what it writes. Output-only counts miss this; this counts every call's context.
 */

/** Context per call at or above this is heavy: each small step re-reads it all. */
export const HEAVY_CONTEXT = 300_000;
/** Priced as this when a session's model has no known price, so shares still compare. Its dollars aren't shown. */
const FALLBACK_MODEL = "claude-opus-5-5";

type Turn = NonNullable<Session["turns"]>[number];
export type Spend = {
  /** Model calls. */
  steps: number;
  /** Context taken in, cached or not, and what was written. */
  read: number; written: number;
  /** The part of `read` that came from cache: the same context re-read. */
  reRead: number;
  /** Context per call: on average, and at its largest. */
  contextAvg: number; contextMax: number;
  /** Calls whose context was heavy (HEAVY_CONTEXT or more). */
  heavySteps: number;
  /** Estimated dollars at list price; `priced` false when the model's price isn't known (then it's a stand-in for shares). */
  costUsd: number; priced: boolean;
};
const ctx = (t: Turn) => t.input + (t.cacheRead ?? 0);

/** A session's spend from its model calls, from `since` on. */
export function spendOf(turns: Turn[] = [], model: string | null | undefined, since = ""): Spend {
  const ts = turns.filter((t) => !since || !t.ts || t.ts >= since);
  const input = ts.reduce((a, t) => a + t.input, 0), output = ts.reduce((a, t) => a + t.output, 0), cacheRead = ts.reduce((a, t) => a + (t.cacheRead ?? 0), 0);
  const priced = priceOf(model) != null;
  return {
    steps: ts.length, read: input + cacheRead, written: output, reRead: cacheRead,
    contextAvg: ts.length ? Math.round((input + cacheRead) / ts.length) : 0, contextMax: ts.reduce((a, t) => Math.max(a, ctx(t)), 0),
    heavySteps: ts.filter((t) => ctx(t) >= HEAVY_CONTEXT).length,
    costUsd: (priced ? costOf(model, { input, output, cacheRead }) : costOf(FALLBACK_MODEL, { input, output, cacheRead })) ?? 0, priced,
  };
}
export const addSpend = (a: Spend, b: Spend): Spend => ({
  steps: a.steps + b.steps, read: a.read + b.read, written: a.written + b.written, reRead: a.reRead + b.reRead,
  contextAvg: a.steps + b.steps ? Math.round((a.read + b.read) / (a.steps + b.steps)) : 0, contextMax: Math.max(a.contextMax, b.contextMax),
  heavySteps: a.heavySteps + b.heavySteps, costUsd: a.costUsd + b.costUsd, priced: a.priced && b.priced,
});
const NONE: Spend = { steps: 0, read: 0, written: 0, reRead: 0, contextAvg: 0, contextMax: 0, heavySteps: 0, costUsd: 0, priced: true };

/** A session's name in plain words: the name it was given, else its branch. */
export function sessionLabel(s: Session): string {
  const name = s.title || s.launchedAs || (s.branch && !["main", "master", "HEAD"].includes(s.branch) ? `the session on ${s.branch}` : `a session on ${(s.cwd.split("/").filter(Boolean).at(-1) ?? "this repo").replace(/-[0-9a-f]{6}$/, "")}`);
  return name.length > 70 ? name.slice(0, 69) + "…" : name;
}

export type SpendRow = {
  id: string; label: string;
  /** Who ran it: you, or another session or agent (nobody typed in it). */
  by: "you" | "agent";
  /** It started other sessions: it coordinates. */
  coordinator: boolean;
  /** The session itself, and its subagents together. */
  own: Spend; subagents: Spend; total: Spend;
  share: number;
};
export type SpendBreakdown = {
  rows: SpendRow[]; total: Spend;
  /** Subagents by type across all sessions ("Explore", "reviewer"), biggest first. */
  subagentTypes: { type: string; spend: Spend; share: number }[];
  /** Share of all context taken in that was the same context re-read from cache. */
  reReadShare: number;
};

/** Every session's spend in the window, its subagents included, biggest first. */
export function spendBreakdown(sessions: Session[], since = ""): SpendBreakdown {
  const types = new Map<string, Spend>();
  const rows: SpendRow[] = [];
  for (const s of sessions) {
    const own = spendOf(s.turns, s.model, since);
    let subs = NONE;
    for (const x of s.subagents ?? []) {
      const sp = spendOf(x.turns, x.model ?? s.model, since);
      if (!sp.steps) continue;
      subs = addSpend(subs, sp);
      const type = x.agentType || "subagent";
      types.set(type, addSpend(types.get(type) ?? NONE, sp));
    }
    const total = addSpend(own, subs);
    if (!total.steps) continue;
    rows.push({ id: s.id, label: sessionLabel(s), by: s.unattended ? "agent" : "you", coordinator: !!(s.launches?.length || s.coordinator), own, subagents: subs, total, share: 0 });
  }
  const total = rows.reduce((a, r) => addSpend(a, r.total), NONE);
  for (const r of rows) r.share = total.costUsd ? r.total.costUsd / total.costUsd : 0;
  rows.sort((a, b) => b.total.costUsd - a.total.costUsd);
  return {
    rows, total, reReadShare: total.read ? total.reRead / total.read : 0,
    subagentTypes: [...types.entries()].map(([type, spend]) => ({ type, spend, share: total.costUsd ? spend.costUsd / total.costUsd : 0 })).sort((a, b) => b.spend.costUsd - a.spend.costUsd),
  };
}
