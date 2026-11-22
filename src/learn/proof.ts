import type { Client } from "@libsql/client";
import type { Session } from "../logs/types.js";
import { repoIdentity } from "../repo/identity.js";
import { reportData, type LessonReport, type Report } from "../commands/report.js";
import { repoChecker } from "../memory/stale.js";
import { repoRoot } from "../deliver/local-file.js";
import { redact } from "../privacy/redact.js";

/**
 * The proof page's numbers: which kept lessons worked, which didn't, which can't be judged yet, and which have
 * gone stale. Every verdict carries its sample size, and the misses are shown, not hidden.
 *   worked       told to agents, at least PROOF_MIN_SESSIONS sessions since you kept it, and the problem hasn't come back
 *   came_back    the problem showed up again in a session where the lesson had its chance
 *   too_early    fewer than PROOF_MIN_SESSIONS sessions since, or never told: not enough to say
 * A lesson is stale when it names a file, make target or script that's gone from the repo, or when agents were told
 * it and the problem came back anyway in two or more sessions: the wording isn't working, so retire or rewrite it.
 */
export type Outcome = "worked" | "came_back" | "too_early";
export type Stale = { reason: "missing_path" | "missing_command" | "did_nothing"; detail: string };
export type ProvenLesson = LessonReport & { outcome: Outcome; sessionsSince: number; stale: Stale | null };
export type Proof = { repo: string | null; at: string; lessons: ProvenLesson[]; counts: Record<Outcome, number>; stale: number; report: Report };

/** Sessions since a lesson was kept before muninn says whether it worked. */
export const PROOF_MIN_SESSIONS = 3;

const startOf = (s: Session) => s.events.reduce((m, e) => (e.ts && (!m || e.ts < m) ? e.ts : m), "");

export async function proofData(db: Client, repo: string | null, sessions: Session[]): Promise<Proof> {
  const report = await reportData(db, repo, sessions);
  const here = sessions.filter((s) => !s.parent && (!repo || (s.cwd && repoIdentity(s.cwd) === repo)));
  const starts = here.map(startOf).filter(Boolean);
  const checkers = new Map<string, ReturnType<typeof repoChecker> | null>();
  const checker = async (r: string | null) => {
    if (!r) return null;
    if (!checkers.has(r)) { const root = await repoRoot(db, r); checkers.set(r, root ? repoChecker(root) : null); }
    return checkers.get(r)!;
  };
  const lessons: ProvenLesson[] = [];
  for (const l of report.lessons) {
    const sessionsSince = starts.filter((t) => t >= l.keptAt).length;
    const outcome: Outcome = l.after > 0 ? "came_back" : l.sent > 0 && sessionsSince >= PROOF_MIN_SESSIONS ? "worked" : "too_early";
    let stale: Stale | null = null;
    const gone = (await checker(l.repo ?? repo))?.problem(l.text);
    if (gone) stale = gone;
    else if (l.sent > 0 && l.after >= 2 && !l.fix) stale = { reason: "did_nothing", detail: `Agents were told it, and the problem still came back in ${l.after} sessions. Retire it, or rewrite it more plainly.` };
    lessons.push({ ...l, text: redact(l.text), outcome, sessionsSince, stale });
  }
  const counts = { worked: 0, came_back: 0, too_early: 0 } as Record<Outcome, number>;
  for (const l of lessons) counts[l.outcome]++;
  return { repo, at: new Date().toISOString(), lessons, counts, stale: lessons.filter((l) => l.stale).length, report };
}

/** One line a person can read out: "12 kept. 9 worked. 2 came back. 1 too early to tell." */
export function headline(p: Proof): string {
  const n = p.lessons.length;
  if (!n) return "No kept lessons yet.";
  const parts = [`${n} kept`, `${p.counts.worked} worked`, `${p.counts.came_back} came back`, `${p.counts.too_early} too early to tell`];
  return `${parts.join(". ")}.${p.stale ? ` ${p.stale} look stale: retire or rewrite them.` : ""}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const LABEL: Record<Outcome, string> = { worked: "Worked", came_back: "Came back", too_early: "Too early to tell" };

/** The proof as one self-contained HTML page, to send to someone. No scripts, no outside files. */
export function proofHtml(p: Proof): string {
  const where = p.repo ? p.repo.split("/").pop()! : "all repos";
  const day = p.at.slice(0, 10);
  const row = (l: ProvenLesson) => `<tr class="${l.outcome}">
      <td><span class="tag ${l.outcome}">${LABEL[l.outcome]}</span></td>
      <td>${esc(l.text)}${l.stale ? `<div class="stale">Stale: ${esc(l.stale.detail)}</div>` : ""}</td>
      <td class="n">${l.before}</td><td class="n">${l.sessionsSince}</td><td class="n">${l.after}</td><td class="n">${l.sent}</td>
      <td class="why">${esc(l.verdict)}</td></tr>`;
  const order: Outcome[] = ["came_back", "worked", "too_early"];
  const fixes = p.report.fixes;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lessons report · ${esc(where)}</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --mute:#6b6a65; --line:#e4e1d9; --ok:#2f7d4f; --bad:#b3412f; --wait:#8a7a3a; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --mute:#a3a29b; --line:#33322e; --ok:#6cc08f; --bad:#ec8a77; --wait:#d6c27a; --card:#1e1e1b; } }
body { background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; margin:0; padding:32px 16px; }
main { max-width:980px; margin:0 auto; }
h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:18px; margin:32px 0 8px; }
.sub, .why, .method { color:var(--mute); } .why { font-size:13px; }
.big { font-size:20px; margin:16px 0; }
.stats { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; min-width:120px; }
.stat b { display:block; font-size:24px; }
.tablewrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; background:var(--card); }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { font-size:12px; color:var(--mute); font-weight:600; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.tag { font-size:12px; font-weight:600; white-space:nowrap; } .tag.worked { color:var(--ok); } .tag.came_back { color:var(--bad); } .tag.too_early { color:var(--wait); }
.stale { color:var(--bad); font-size:13px; margin-top:4px; }
</style></head><body><main>
<h1>Did the lessons work? · ${esc(where)}</h1>
<div class="sub">secondnature report, ${day}. Lessons are short notes kept from earlier coding-agent sessions and told to agents in later ones.</div>
<p class="big">${esc(headline(p))}</p>
<div class="stats">
  <div class="stat"><b>${p.counts.worked}</b>worked</div>
  <div class="stat"><b>${p.counts.came_back}</b>came back</div>
  <div class="stat"><b>${p.counts.too_early}</b>too early to tell</div>
  <div class="stat"><b>${p.stale}</b>stale</div>
</div>
${fixes.length ? `<h2>Output trims</h2>
<p class="sub">Scripts that show agents only what matters from a command's output, kept in full on disk.</p>
<div class="tablewrap"><table><tr><th>Command</th><th class="n">Runs before</th><th class="n">Runs since</th><th class="n">Tokens a run, before → since</th><th class="n">Saved</th><th>Verdict</th></tr>
${fixes.map((f) => `<tr><td><code>${esc(f.cmd)}</code></td><td class="n">${f.before.runs}</td><td class="n">${f.after.runs}</td><td class="n">${k(f.before.avgTokens)} → ${k(f.after.avgTokens)}</td><td class="n">${f.enough ? `${k(f.savedTokens)} tokens${f.savedUsd != null ? `<br>$${f.savedUsd.toFixed(2)}` : ""}` : "–"}</td><td class="why">${esc(f.verdict)}</td></tr>`).join("\n")}
</table></div>` : ""}
<h2>Kept lessons</h2>
${p.lessons.length ? `<div class="tablewrap"><table><tr><th>Outcome</th><th>Lesson</th><th class="n">Sessions with the problem before</th><th class="n">Sessions since kept</th><th class="n">Problem seen since</th><th class="n">Times told</th><th>Why</th></tr>
${order.flatMap((o) => p.lessons.filter((l) => l.outcome === o)).map(row).join("\n")}
</table></div>` : `<p class="sub">No kept lessons yet.</p>`}
<h2>How this is measured</h2>
<div class="method">
<p>Each lesson comes from a problem muninn saw in session logs: a repeated correction, a command that failed before it worked, a wrong path. After a lesson is kept, muninn watches later sessions for the same problem.</p>
<p><b>Worked</b> means agents were told the lesson, at least ${PROOF_MIN_SESSIONS} sessions have run since, and the problem hasn't come back. <b>Came back</b> means it showed up again in a session where the lesson had its chance (it was told there, or the session started after it was kept). Anything with fewer sessions, or never told, is <b>too early to tell</b>; it isn't counted as a win.</p>
<p><b>Stale</b> means the lesson names a file, make target or script that is no longer in the repo, or agents were told it and the problem still came back in two or more sessions.</p>
<p>Limits: these are counts from one person's sessions, not a controlled test. A model upgrade or a change in the work can move them. Token savings are estimates at list price, counting the prompt cache re-reading output on later turns.</p>
</div>
</main></body></html>
`;
}
