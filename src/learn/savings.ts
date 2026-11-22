import type { Client } from "@libsql/client";
import type { Session } from "../logs/types.js";
import { repoIdentity } from "../repo/identity.js";
import { normCommand } from "./signals.js";
import { outputCost } from "./waste-index.js";
import { TRIM_OUT, TRIM_PATH } from "../propose/trim.js";

/**
 * What each applied output trim saved: the command's output per run before you applied it against after, on the
 * runs since, in tokens and in money (counting the prompt-cache re-reads on later turns). Also how often the agent
 * opened the full output anyway: if it does that often, the trim loses something it needs and costs more than it saves.
 */
export type FixSaving = {
  id: string; title: string; cmd: string; family: string; appliedAt: string;
  before: { runs: number; avgTokens: number };
  after: { runs: number; trimmed: number; raw: number; avgTokens: number; readBack: number };
  savedTokens: number; savedUsd: number | null;
  /** Too few runs since applying to say anything. */
  enough: boolean;
  verdict: string;
};
/** Runs since applying, before muninn reports a saving. */
export const SAVINGS_MIN_RUNS = 3;

/** The command a trimmed run wraps: "sh .muninn/bin/trim test -- npm test" → "npm test". */
export const wrapped = (cmd: string): string | null => cmd.includes(TRIM_PATH) ? cmd.split(/\s--\s/).slice(1).join(" -- ").trim() || null : null;

export async function fixSavings(db: Client, repo: string | null, sessions: Session[]): Promise<FixSaving[]> {
  const rows = (await db.execute({ sql: `SELECT id,title,payload,decided_at FROM proposals WHERE kind='trim' AND status='applied' ${repo ? "AND repo_id=?" : ""} ORDER BY decided_at`, args: repo ? [repo] : [] })).rows;
  const here = sessions.filter((s) => !repo || (s.cwd && repoIdentity(s.cwd) === repo));
  const out: FixSaving[] = [];
  for (const r of rows) {
    const p = JSON.parse(String(r.payload)); const at = String(r.decided_at); const key = String(p.key);
    const before = { runs: 0, tokens: 0 }; const after = { runs: 0, trimmed: 0, raw: 0, tokens: 0, readBack: 0, usd: 0, priced: false };
    for (const s of here) for (const e of s.events) {
      if (!e.ts) continue;
      if (e.ts >= at && ((e.k === "file" && e.path.includes(TRIM_OUT)) || (e.k === "cmd" && e.cmd.includes(TRIM_OUT) && !e.cmd.includes(TRIM_PATH)))) { after.readBack++; continue; }
      if (e.k !== "cmd") continue;
      const inner = wrapped(e.cmd);
      if (normCommand(inner ?? e.cmd) !== key) continue;
      const tokens = Math.ceil((e.size ?? e.output.length) / 4);
      if (e.ts < at) { before.runs++; before.tokens += tokens; continue; }
      after.runs++; after.tokens += tokens; if (inner) after.trimmed++; else after.raw++;
      // What this run would have cost at the old size, minus what it cost.
      const c = outputCost(s, e.ts, 1);
      if (c != null) { after.priced = true; after.usd += c * Math.max(0, (before.runs ? before.tokens / before.runs : tokens) - tokens); }
    }
    const avgBefore = before.runs ? Math.round(before.tokens / before.runs) : 0;
    const avgAfter = after.runs ? Math.round(after.tokens / after.runs) : 0;
    const savedTokens = before.runs ? Math.max(0, (avgBefore - avgAfter) * after.runs) : 0;
    const enough = after.runs >= SAVINGS_MIN_RUNS && before.runs > 0;
    const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    let verdict: string;
    if (!enough) verdict = `Not enough runs to tell yet: ${after.runs} since you applied it (muninn waits for ${SAVINGS_MIN_RUNS}).`;
    else if (after.raw > after.trimmed) verdict = `Agents still ran it without the script ${after.raw} of ${after.runs} time(s). Check its lesson is reaching them.`;
    else if (after.trimmed && after.readBack / after.trimmed > 0.3) verdict = `Agents opened the full output after ${after.readBack} of ${after.trimmed} trimmed run(s), so the trim often leaves out something they need. Consider undoing it.`;
    else if (savedTokens > 0) verdict = `Output went from about ${k(avgBefore)} to ${k(avgAfter)} tokens a run. Saved about ${k(savedTokens)} tokens${after.priced ? ` ($${after.usd.toFixed(2)})` : ""} over ${after.runs} run(s).${after.readBack ? ` The full output was opened ${after.readBack} time(s).` : ""}`;
    else verdict = `No saving: output is about ${k(avgAfter)} tokens a run now, against ${k(avgBefore)} before.`;
    out.push({ id: String(r.id), title: String(r.title), cmd: String(p.cmd), family: String(p.family), appliedAt: at,
      before: { runs: before.runs, avgTokens: avgBefore }, after: { runs: after.runs, trimmed: after.trimmed, raw: after.raw, avgTokens: avgAfter, readBack: after.readBack },
      savedTokens, savedUsd: after.priced ? after.usd : null, enough, verdict });
  }
  return out;
}
