import type { Client } from "@libsql/client";
import { effortMoments } from "../learn/signals.js";
import { wasteIndex, type WasteRow } from "../learn/waste-index.js";
import { scanLogs } from "../logs/discover.js";
import type { Session } from "../logs/types.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";
import { reportData } from "./report.js";
import { listQueries } from "../store/queries.js";
import { loadRuns, runNumbers, savedFindings, STALL_MIN, type Run } from "./run-findings.js";

const TOOL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity" };
const KIND: Record<string, string> = {
  loop: "the same command failing again and again", failure_then_fix: "commands that failed before they worked", mistake_returned: "a failure that keeps coming back",
  refetch: "re-running commands to see more output", stopped: "commands you stopped", wrong_path: "looking for files in the wrong place", big_file: "files too big to read in one go",
  big_output: "commands that printed far more than needed", reread: "reading the same unchanged file again", one_by_one: "doing one step at a time what a script could do at once",
};
export type Insights = {
  days: number; repo: string | null;
  sessions: { total: number; byTool: Record<string, number>; byRepo: Record<string, number> };
  /** Where output tokens went, per command and per file read, biggest cost first (top 10). */
  index: WasteRow[];
  effort: { wastedTokens: number; byKind: { kind: string; label: string; tokens: number; count: number }[]; top: { text: string; tokens: number }[]; stopped: number; interrupted: number };
  lessons: { told: number; toldSessions: number; kept: number; working: number; cameBack: { text: string; verdict: string }[] };
  skills: { name: string; uses: number }[];
  waiting: { suggestions: number; changes: number };
  spend: { calls: number; costUsd: number };
  /** Questions agents asked secondnature (MCP tools or muninn ask; a person's terminal questions left out). */
  asked: { count: number; found: number; bySurface: { surface: string; count: number }[]; nothing: string[] };
  /** Autonomous runs (a main session and the agents it handed work to) that ended in the window. */
  runs: { count: number; minutes: number; tokens: number; sentBack: number; rework: number; reworkTokens: number; stallMinutes: number; blockersLeft: { workflows: number; issues: number }; byRole: { role: string; tokens: number; share: number }[]; findings: string[] };
};

const lastTs = (s: Session) => s.events.reduce((m, e) => (e.ts > m ? e.ts : m), "");

/** One week (or `days`) of coding-agent sessions: how much was done, what wasted effort, and whether lessons helped. */
export async function insightsData(db: Client, repo: string | null, days = 7, sessions?: Session[], runList?: Run[]): Promise<Insights> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const all = sessions ?? scanLogs().sessions;
  const here = all.filter((s) => lastTs(s) >= since && (!repo || (s.cwd && repoIdentity(s.cwd) === repo)));
  const byTool: Record<string, number> = {}, byRepo: Record<string, number> = {};
  for (const s of here) { byTool[s.tool] = (byTool[s.tool] ?? 0) + 1; const r = (s.cwd && repoIdentity(s.cwd)) || "?"; byRepo[r] = (byRepo[r] ?? 0) + 1; }

  // Effort only from this window: moments whose last sighting falls inside it.
  const moments = effortMoments(here).filter((m) => m.last >= since);
  const byKind = new Map<string, { tokens: number; count: number }>();
  for (const m of moments) { const k = byKind.get(m.signal) ?? { tokens: 0, count: 0 }; k.tokens += m.wasted ?? 0; k.count++; byKind.set(m.signal, k); }
  const interrupted = here.reduce((n, s) => n + s.events.filter((e) => e.k === "interrupt" && e.ts >= since).length, 0);
  const stopped = here.reduce((n, s) => n + s.events.filter((e) => e.k === "cmd" && e.stopped && e.ts >= since).length, 0);

  const scope = repo ? "AND (l.repo_id=? OR l.scope='global')" : "";
  const d = (await db.execute({ sql: `SELECT count(*) n, count(DISTINCT d.session) s FROM deliveries d JOIN lessons l ON l.id=d.lesson_id WHERE d.outcome='sent' AND d.ts>=? ${scope}`, args: repo ? [since, repo] : [since] })).rows[0]!;
  const report = await reportData(db, repo);
  const skillsApplied = (await db.execute({ sql: "SELECT payload FROM proposals WHERE kind='skill' AND status='applied'" + (repo ? " AND repo_id=?" : ""), args: repo ? [repo] : [] })).rows.map((r) => String(JSON.parse(String(r.payload)).name));
  const skills = skillsApplied.map((name) => ({ name, uses: here.reduce((n, s) => n + s.events.filter((e) => e.k === "file" && e.tool === "skill" && e.path === name && e.ts >= since).length, 0) }));
  const waitingSug = Number((await db.execute({ sql: `SELECT count(*) n FROM lessons l WHERE l.status='proposed' ${repo ? "AND l.repo_id=?" : ""}`, args: repo ? [repo] : [] })).rows[0]?.n ?? 0);
  const waitingCh = Number((await db.execute({ sql: `SELECT count(*) n FROM proposals WHERE status='proposed' ${repo ? "AND (repo_id=? OR repo_id IS NULL)" : ""}`, args: repo ? [repo] : [] })).rows[0]?.n ?? 0);
  const spend = (await db.execute({ sql: "SELECT count(*) n, coalesce(sum(cost_usd),0) c FROM llm_calls WHERE ts>=?", args: [since] })).rows[0]!;

  const runs = (runList ?? await loadRuns(db, repo)).filter((r) => r.ended_at >= since && (!repo || r.repo_id === repo));
  const nums = runs.map(runNumbers);
  const roleTokens = new Map<string, number>();
  for (const n of nums) for (const r of n.roles) roleTokens.set(r.role, (roleTokens.get(r.role) ?? 0) + r.tokens);
  const runTokens = nums.reduce((a, n) => a + n.tokens, 0);
  const found = await savedFindings(db, runs);
  const qs = (await listQueries(db, { repo, days })).filter((x) => x.tool !== "terminal");
  const surfaces = new Map<string, number>(); for (const x of qs) surfaces.set(x.surface, (surfaces.get(x.surface) ?? 0) + 1);

  return {
    days, repo,
    sessions: { total: here.length, byTool, byRepo },
    index: wasteIndex(here, since).slice(0, 10),
    effort: {
      wastedTokens: moments.reduce((a, m) => a + (m.wasted ?? 0), 0),
      byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, label: KIND[kind] ?? kind, ...v })).sort((a, b) => b.tokens - a.tokens || b.count - a.count),
      top: moments.filter((m) => (m.wasted ?? 0) > 0).sort((a, b) => (b.wasted ?? 0) - (a.wasted ?? 0)).slice(0, 3).map((m) => ({ text: m.text, tokens: m.wasted ?? 0 })),
      stopped, interrupted,
    },
    lessons: {
      told: Number(d.n ?? 0), toldSessions: Number(d.s ?? 0), kept: report.lessons.length,
      working: report.lessons.filter((l) => l.after === 0 && l.sent > 0).length,
      cameBack: report.lessons.filter((l) => l.after > 0).slice(0, 3).map((l) => ({ text: l.text, verdict: l.verdict })),
    },
    skills, waiting: { suggestions: waitingSug, changes: waitingCh },
    spend: { calls: Number(spend.n ?? 0), costUsd: Number(spend.c ?? 0) },
    asked: {
      count: qs.length, found: qs.filter((x) => x.results > 0).length,
      bySurface: [...surfaces.entries()].map(([surface, count]) => ({ surface, count })).sort((a, b) => b.count - a.count),
      nothing: [...new Set(qs.filter((x) => !x.results && x.query).map((x) => x.query))].slice(0, 3),
    },
    runs: {
      count: runs.length, minutes: nums.reduce((a, n) => a + n.minutes, 0), tokens: runTokens,
      sentBack: nums.reduce((a, n) => a + n.sentBack, 0), rework: nums.reduce((a, n) => a + n.rework, 0), reworkTokens: nums.reduce((a, n) => a + n.reworkTokens, 0),
      stallMinutes: nums.reduce((a, n) => a + n.stalls.reduce((b, x) => b + x.minutes, 0), 0),
      blockersLeft: runs.flatMap((r) => r.workflows ?? []).filter((w) => w.blocking_left > 0).reduce((a, w) => ({ workflows: a.workflows + 1, issues: a.issues + w.blocking_left }), { workflows: 0, issues: 0 }),
      byRole: [...roleTokens.entries()].map(([role, t]) => ({ role, tokens: t, share: runTokens ? t / runTokens : 0 })).sort((a, b) => b.tokens - a.tokens),
      findings: Object.values(found).flatMap((f) => f.items.slice(0, 1).map((i) => i.text)).slice(0, 3),
    },
  };
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export function insightsText(i: Insights): string {
  const out: string[] = [];
  const where = i.repo ? i.repo.split("/").pop() : "all repos";
  out.push(`Your last ${i.days} days with coding agents (${where})`, "");
  if (!i.sessions.total && !i.runs.count && !i.asked.count) return `${out.join("\n")}No sessions in this time.`;
  out.push(`Sessions: ${i.sessions.total} (${Object.entries(i.sessions.byTool).map(([t, n]) => `${TOOL[t] ?? t} ${n}`).join(", ")})${i.repo ? "" : `, in ${Object.keys(i.sessions.byRepo).length} repo(s)`}.`);
  out.push("", "Where effort went to waste");
  if (!i.effort.byKind.length) out.push("  Nothing stood out: no loops, repeated failures or wrong paths.");
  for (const b of i.effort.byKind.slice(0, 5)) out.push(`  ${b.count} × ${b.label}${b.tokens ? `, about ${k(b.tokens)} tokens` : ""}`);
  for (const t of i.effort.top) out.push(`  Costliest: ${t.text.length > 110 ? t.text.slice(0, 109) + "…" : t.text} (about ${k(t.tokens)} tokens)`);
  if (i.effort.interrupted) out.push(`  You stopped an answer ${i.effort.interrupted} time(s) while it was being written.`);
  if (i.index.length) {
    out.push("", "Where output tokens went (biggest first)");
    for (const r of i.index.slice(0, 6)) {
      const bits = [`${r.runs} run(s), about ${k(r.tokens)} tokens${r.costUsd != null ? ` ($${r.costUsd.toFixed(2)} with cache re-reads)` : ""}`];
      if (r.repeated) bits.push(`${r.repeated} repeated earlier output`);
      if (r.judged >= 2 && r.used != null) bits.push(`agent used it ${r.used} of ${r.judged} time(s)`);
      out.push(`  ${r.kind === "read" ? r.key : "`" + r.key + "`"}: ${bits.join("; ")}`);
    }
  }
  out.push("", "Lessons");
  out.push(`  Told ${i.lessons.told} time(s) in ${i.lessons.toldSessions} session(s). Of ${i.lessons.kept} kept, ${i.lessons.working} were told and haven't come back.`);
  for (const c of i.lessons.cameBack) out.push(`  Came back: "${c.text.slice(0, 90)}${c.text.length > 90 ? "…" : ""}". ${c.verdict}`);
  if (i.asked.count) {
    out.push("", "What agents asked");
    out.push(`  ${i.asked.count} question(s), ${i.asked.found} found something (${Math.round((i.asked.found / i.asked.count) * 100)}%). Most used: ${i.asked.bySurface.slice(0, 3).map((x) => `${x.surface} ${x.count}`).join(", ")}.`);
    for (const q of i.asked.nothing) out.push(`  Found nothing: "${q.length > 90 ? q.slice(0, 89) + "…" : q}"`);
  }
  if (i.runs.count) {
    const r = i.runs;
    const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
    out.push("", "Autonomous runs");
    out.push(`  ${r.count} run(s) with more than one agent, ${hm(r.minutes)} in all, about ${k(r.tokens)} tokens.`);
    if (r.byRole.length) out.push(`  Tokens by role: ${r.byRole.slice(0, 5).map((x) => `${x.role} ${Math.round(x.share * 100)}%`).join(", ")}.`);
    if (r.sentBack || r.rework) out.push(`  ${[r.sentBack ? `Work sent back ${r.sentBack} time(s)` : "", r.rework ? `${r.rework} follow-up fix(es) asked for` : ""].filter(Boolean).join(", ")}${r.reworkTokens ? `; the redo took about ${k(r.reworkTokens)} tokens` : ""}.`);
    if (r.blockersLeft.workflows) out.push(`  ${r.blockersLeft.workflows} workflow(s) finished with ${r.blockersLeft.issues} blocking review issue(s) still open.`);
    if (r.stallMinutes) out.push(`  No agent was working for ${hm(r.stallMinutes)}, in gaps of ${STALL_MIN} minutes or more.`);
    for (const f of r.findings) out.push(`  ${f}`);
  }
  if (i.skills.length) { out.push("", "Skills you applied"); for (const s of i.skills) out.push(`  ${s.name}: used ${s.uses} time(s)`); }
  if (i.waiting.suggestions || i.waiting.changes) out.push("", `Waiting for you: ${[i.waiting.suggestions ? `${i.waiting.suggestions} suggested lesson(s)` : "", i.waiting.changes ? `${i.waiting.changes} proposed change(s)` : ""].filter(Boolean).join(" and ")}. Open muninn ui.`);
  out.push("", `muninn's own AI calls: ${i.spend.calls}${i.spend.costUsd ? `, about $${i.spend.costUsd.toFixed(2)}` : ""}.`);
  return out.join("\n");
}

/** muninn insights [--days 7] [--all-repos] */
export async function insights(args: string[]) {
  const at = args.indexOf("--days");
  const days = at >= 0 ? Math.max(1, Number(args[at + 1]) || 7) : 7;
  const repo = args.includes("--all-repos") ? null : repoIdentity(process.cwd());
  console.log(insightsText(await insightsData(await openDb(), repo, days)));
}
