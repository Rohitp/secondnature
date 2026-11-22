import { isAbsolute, relative } from "node:path";
import type { LogEvent, Session } from "../logs/types.js";
import { priceOf } from "../workflow/prices.js";
import { normCommand, repeats } from "./signals.js";

/**
 * The waste index: for each command (and each file read), how much output it showed agents, how often it ran,
 * how often it printed what an earlier run had already printed, and whether the agent then used what it was shown.
 * It's step 1 of learned waste reduction: before muninn suggests a fix it needs to know where the tokens went.
 */
export type WasteRow = {
  /** The command with paths and numbers taken out ("npm test", "pytest <path>"), or "read <file>". */
  key: string; kind: "command" | "read";
  /** One real example of it, as it was run. */
  example: string;
  runs: number; sessions: number;
  /** Tokens of output agents were shown, in all, on average and at most. */
  tokens: number; avgTokens: number; maxTokens: number;
  /** Runs whose output mostly repeated an earlier run's in the same session. */
  repeated: number;
  /** Of the runs muninn could judge, how many the agent went on to use (quoted, opened or acted on something in the output). Null when none could be judged. */
  used: number | null; judged: number;
  /**
   * Estimated dollars: each output is read once as fresh input, then again from the prompt cache on every later
   * turn of the session. Null when no session's model has a known price.
   */
  costUsd: number | null;
  tools: string[]; last: string;
};

/** Words in an output that say something specific: file names, identifiers, error codes. Common words don't count. */
const COMMON = new Set("error errors warning warnings passed failed failing running finished success successful total tests test suite suites expected received function return undefined string number object import export const default module modules".split(" "));
export function distinctive(output: string, cmd = ""): string[] {
  const words = output.match(/[A-Za-z_][\w.\-/]{5,}/g) ?? [];
  const c = cmd.toLowerCase();
  return [...new Set(words.map((w) => w.replace(/[.\-/]+$/, "")))].filter((w) => w.length >= 6 && !COMMON.has(w.toLowerCase()) && !c.includes(w.toLowerCase()) && /[a-z]/i.test(w)).slice(0, 200);
}
/** What the agent did next, as text: its next message and the next few commands and paths. */
function afterText(events: LogEvent[], i: number): string | null {
  const out: string[] = [];
  let acts = 0;
  for (let j = i + 1; j < events.length && acts < 3; j++) {
    const e = events[j]!;
    if (e.k === "typed" || e.k === "interrupt") break;
    if (e.k === "agent") { out.push(e.text); continue; }
    out.push(e.k === "cmd" ? e.cmd : `${e.path} ${e.pattern ?? ""}`); acts++;
  }
  return out.length ? out.join("\n") : null;
}
/** Model turns after a moment: each one reads everything before it again, from the prompt cache. */
const turnsAfter = (s: Session, ts: string) => (s.turns ?? []).filter((t) => t.ts > ts).length;
/** Estimated dollars for some output shown to an agent at a moment: once as fresh input, then from the cache on each later turn. */
export function outputCost(s: Session, ts: string, tokens: number): number | null {
  const price = priceOf(s.model);
  return price ? (tokens * price.input + tokens * turnsAfter(s, ts) * (price.cacheRead ?? price.input / 10)) / 1e6 : null;
}

const short = (cwd: string, p: string) => { const r = relative(cwd, p); return r && !r.startsWith("..") && !isAbsolute(r) ? r : p; };

/** Below this many tokens a run isn't worth indexing: small outputs aren't where waste is. */
export const INDEX_MIN_TOKENS = 500;

export function wasteIndex(sessions: Session[], since = ""): WasteRow[] {
  type Acc = WasteRow & { sessionSet: Set<string>; toolSet: Set<string>; cost: number; priced: boolean };
  const rows = new Map<string, Acc>();
  for (const s of sessions) {
    const cwd = s.cwd || "/";
    const prior = new Map<string, string[]>();
    s.events.forEach((e, i) => {
      if ((e.k !== "cmd" && e.k !== "file") || !e.ts || e.ts < since) return;
      if (e.k === "file" && (e.tool !== "read" || e.failed)) return;
      const size = e.size ?? e.output.length;
      const tokens = Math.ceil(size / 4);
      if (tokens < INDEX_MIN_TOKENS) return;
      const key = e.k === "cmd" ? normCommand(e.cmd) : `read ${short(cwd, e.path)}`;
      if (!key) return;
      const r: Acc = rows.get(key) ?? { key, kind: e.k === "cmd" ? "command" : "read", example: e.k === "cmd" ? e.cmd.replace(/\s+/g, " ").slice(0, 200) : short(cwd, e.path), runs: 0, sessions: 0, tokens: 0, avgTokens: 0, maxTokens: 0, repeated: 0, used: null, judged: 0, costUsd: null, tools: [], last: "", sessionSet: new Set(), toolSet: new Set(), cost: 0, priced: false };
      r.runs++; r.tokens += tokens; r.maxTokens = Math.max(r.maxTokens, tokens);
      r.sessionSet.add(s.id); r.toolSet.add(s.tool); if (e.ts > r.last) r.last = e.ts;
      const before = prior.get(key) ?? [];
      if (e.k === "cmd" && before.some((o) => repeats(o, e.output))) r.repeated++;
      prior.set(key, [...before, e.output]);
      // Did the agent use it? Only judged when the output has specific words and the agent did something after.
      const words = e.k === "cmd" ? distinctive(e.output, e.cmd) : [];
      const next = afterText(s.events, i);
      if (words.length >= 3 && next) { r.judged++; if (words.some((w) => next.includes(w))) r.used = (r.used ?? 0) + 1; else r.used ??= 0; }
      const c = outputCost(s, e.ts, tokens);
      if (c != null) { r.priced = true; r.cost += c; }
      rows.set(key, r);
    });
  }
  return [...rows.values()].map(({ sessionSet, toolSet, cost, priced, ...r }) => ({
    ...r, sessions: sessionSet.size, tools: [...toolSet], avgTokens: Math.round(r.tokens / r.runs), costUsd: priced ? cost : null,
  })).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens);
}

