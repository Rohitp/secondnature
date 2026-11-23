import type { Client } from "@libsql/client";
import { getDial, type Dial } from "../store/dial.js";
import { shortRepo } from "./ask.js";
import { whySent } from "./panel.js";
import { reportData } from "./report.js";
import { defaultRoute, worthSentence } from "./review.js";

export type ReceiptLine = { at: string; tool: string; kind: "lesson" | "handoff"; id: string; text: string; why: string; session: string | null };
export type Carried = { id: string; label: string; route: string; state: "lit" | "armed" | "fading"; lastTold: string | null; global: boolean };
export type HomeData = {
  repo: string | null; repoShort: string; dial: Dial;
  stats: { told: number; sessions: number; cameBack: number; costUsd: number | null };
  /** The week as answers to "is muninn helping?", for plain sentences rather than raw counters. */
  week: {
    sessions: number;
    mostTold: { label: string; sessions: number } | null;
    problems: { kept: number; cameBack: number };
    handoffs: number;
    costUsd: number | null;
  };
  lastToldAt: string | null;
  receipt: ReceiptLine[];
  waiting: { count: number; top: { id: string; text: string; plain: string | null; origin: string; route: string }[] };
  cameBack: { id: string; text: string; verdict: string; fix: string | null }[];
  carry: Carried[];
};

const FADE_DAYS = 14;
/** A short name for a lesson: its plain line or text, up to the first sentence or 60 characters. */
export const label = (s: string) => {
  const first = (s.split(/(?<=[.!?])\s/)[0] ?? s).replace(/\.$/, "");
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  // Cut at a word, never mid-word.
  return cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 59).replace(/[\s,;:]+$/, "") + "…";
};

/** Everything the Home screen and the Claude Code panel show. With a session, the receipt is that session's; otherwise the last day's in this repo. */
export async function homeData(db: Client, repo: string | null, session?: string | null): Promise<HomeData> {
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since1 = new Date(Date.now() - 86_400_000).toISOString();
  const inRepo = repo ? "(l.repo_id=? OR l.scope='global')" : "1=1";
  const rargs = repo ? [repo] : [];

  const lessonRows = (await db.execute({ sql: `SELECT d.ts, d.tool, d.session, d.event, d.source, d.trigger_id, l.id, l.text, l.plain FROM deliveries d JOIN lessons l ON l.id=d.lesson_id WHERE d.outcome='sent' AND ${session ? "d.session=?" : `d.ts>=? AND ${inRepo}`} ORDER BY d.ts DESC LIMIT 12`, args: session ? [session] : [since1, ...rargs] })).rows;
  const handoffRows = (await db.execute({ sql: `SELECT d.ts, d.tool, d.session, h.id, h.text, h.branch FROM deliveries d JOIN handoffs h ON h.id=d.handoff_id WHERE ${session ? "d.session=?" : `d.ts>=? ${repo ? "AND h.repo_id=?" : ""}`} ORDER BY d.ts DESC LIMIT 4`, args: session ? [session] : [since1, ...rargs] })).rows;
  const receipt: ReceiptLine[] = [
    ...lessonRows.map((r) => ({ at: String(r.ts), tool: String(r.tool), kind: "lesson" as const, id: String(r.id), text: String(r.plain ?? r.text), why: whySent(String(r.event), r.source ? String(r.source) : null, r.trigger_id ? String(r.trigger_id) : null), session: r.session ? String(r.session) : null })),
    ...handoffRows.map((r) => ({ at: String(r.ts), tool: String(r.tool), kind: "handoff" as const, id: String(r.id), text: `Where you left off: ${String(r.text).split("\n").find((x) => /^(Done|Next|Open):/.test(x))?.replace(/^\w+:\s*/, "") ?? String(r.text).split("\n")[0]}`, why: `you came back to ${r.branch}`, session: r.session ? String(r.session) : null })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // One line per lesson: the newest time it was told.
  const seen = new Set<string>();
  const receiptOnce = receipt.filter((x) => (seen.has(x.kind + x.id) ? false : (seen.add(x.kind + x.id), true)));

  const w = (await db.execute({ sql: "SELECT count(*) n, count(DISTINCT session) s, max(ts) last FROM deliveries WHERE outcome='sent' AND ts>=?", args: [since7] })).rows[0]!;
  const c = (await db.execute({ sql: "SELECT sum(cost_usd) cost, count(cost_usd) priced FROM llm_calls WHERE ts>=?", args: [since7] })).rows[0]!;
  const report = await reportData(db, repo);
  const cameBack = report.lessons.filter((l) => l.after > 0).map((l) => ({ id: l.id, text: label(l.text), full: l.text, verdict: l.verdict, fix: l.fix }));

  const waitingRows = (await db.execute({ sql: `SELECT id,text,plain,kind,signal,source,suggested_keywords,suggested_scope,wasted_tokens FROM lessons l WHERE status='proposed' ${repo ? "AND repo_id=?" : ""} ORDER BY sessions DESC, last_seen DESC`, args: rargs })).rows;
  const { originOf } = await import("./ask.js");
  const top = [];
  for (const r of waitingRows.slice(0, 3)) {
    const d = defaultRoute({ text: String(r.text), kind: String(r.kind ?? "rule"), signal: r.signal ? String(r.signal) : null, suggested_keywords: r.suggested_keywords ? String(r.suggested_keywords) : null, suggested_scope: r.suggested_scope ? String(r.suggested_scope) : null });
    top.push({ id: String(r.id), text: String(r.text), plain: r.plain ? String(r.plain) : null, origin: await originOf(db, { id: String(r.id), source: String(r.source), signal: r.signal ? String(r.signal) : null }), worth: worthSentence({ text: String(r.text), wasted_tokens: r.wasted_tokens == null ? null : Number(r.wasted_tokens) }, d.route), route: d.route === "always" ? `every session${d.global ? ", every repo" : ", this repo"}` : d.route === "keyword" ? `when "${d.keywords.join('", "')}" comes up` : "only when searched" });
  }

  const carryRows = (await db.execute({ sql: `SELECT l.id, l.text, l.plain, l.always_on, l.scope, coalesce(l.reviewed_at,l.created_at) kept, (SELECT group_concat(pattern, '", "') FROM triggers t WHERE t.lesson_id=l.id) kw, (SELECT max(ts) FROM deliveries d WHERE d.lesson_id=l.id AND d.outcome='sent') last FROM lessons l WHERE l.status='live' AND l.off=0 AND ${inRepo} ORDER BY l.always_on DESC, last DESC`, args: rargs })).rows;
  const fadeBefore = new Date(Date.now() - FADE_DAYS * 86_400_000).toISOString();
  const carry: Carried[] = carryRows.map((r) => {
    const last = r.last ? String(r.last) : null;
    const fading = (last ?? String(r.kept)) < fadeBefore;
    return { id: String(r.id), label: label(String(r.plain ?? r.text)), route: r.always_on ? "every session" : r.kw ? `when "${r.kw}" comes up` : "only when searched", state: fading ? "fading" : r.always_on ? "lit" : "armed", lastTold: last, global: r.scope === "global" };
  });

  const most = (await db.execute({ sql: `SELECT l.text, l.plain, count(DISTINCT d.session) s FROM deliveries d JOIN lessons l ON l.id=d.lesson_id WHERE d.outcome='sent' AND d.ts>=? AND ${inRepo} GROUP BY l.id ORDER BY s DESC LIMIT 1`, args: [since7, ...rargs] })).rows[0];
  const lessonSessions = Number((await db.execute({ sql: `SELECT count(DISTINCT d.session) s FROM deliveries d JOIN lessons l ON l.id=d.lesson_id WHERE d.outcome='sent' AND d.ts>=? AND ${inRepo}`, args: [since7, ...rargs] })).rows[0]?.s ?? 0);
  const handoffs = Number((await db.execute({ sql: `SELECT count(*) n FROM deliveries d JOIN handoffs h ON h.id=d.handoff_id WHERE d.outcome='sent' AND d.ts>=? ${repo ? "AND h.repo_id=?" : ""}`, args: [since7, ...rargs] })).rows[0]?.n ?? 0);
  // "Problems you kept a lesson for": kept lessons that came from something going wrong before (evidence before keeping).
  const withProblem = report.lessons.filter((l) => l.before > 0);

  return {
    week: {
      sessions: lessonSessions,
      mostTold: most ? { label: label(String(most.plain ?? most.text)), sessions: Number(most.s) } : null,
      problems: { kept: withProblem.length, cameBack: withProblem.filter((l) => l.after > 0).length },
      handoffs,
      costUsd: Number(c.priced) ? Number(c.cost) : null,
    },
    repo, repoShort: shortRepo(repo), dial: await getDial(db, repo),
    stats: { told: Number(w.n), sessions: Number(w.s), cameBack: cameBack.length, costUsd: Number(c.priced) ? Number(c.cost) : null },
    lastToldAt: w.last ? String(w.last) : null,
    receipt: receiptOnce,
    waiting: { count: waitingRows.length, top },
    cameBack, carry,
  };
}

/** `muninn` with nothing after it: what needs you, the week in a sentence, and the commands grouped by when you'd use them. */
export async function homeScreen(commandCount: number) {
  const { c, mark, next, pad, plural } = await import("../term.js");
  const { openDb } = await import("../store/db.js");
  const { repoIdentity } = await import("../repo/identity.js");
  const { currentBranch } = await import("../handoff/handoff.js");
  const { health } = await import("./status.js");
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  const branch = repo ? currentBranch(process.cwd()) : null;
  const h = await homeData(db, repo);
  const hl = await health(db);
  const out: string[] = [];
  out.push(`${c.bold("secondnature")}${c.dim(repo ? ` · ${shortRepo(repo)}${branch ? ` · ${branch}` : ""}` : " · not in a git repo")}`, "");
  // What needs you, most pressing first, each with its one next step.
  const needs: [string, string][] = [];
  const { leftAlone } = await import("../config.js");
  if (hl.state === "not-set-up" && !leftAlone("claude-code")) needs.push(["secondnature isn't set up on this machine, so agents aren't told anything.", "muninn setup"]);
  else if (hl.state === "paused") needs.push(["secondnature is paused, so agents aren't told anything.", "muninn resume"]);
  else if (hl.state === "problem") needs.push(["secondnature had a problem the last time Claude Code called it.", "muninn status"]);
  if (h.waiting.count) needs.push([`${c.bold(`${plural(h.waiting.count, "new lesson")} to review.`)} Agents aren't told until you keep one.`, "muninn ui"]);
  if (h.cameBack.length) needs.push([`${plural(h.cameBack.length, "problem")} you kept a lesson for came back: “${h.cameBack[0]!.text}”${h.cameBack.length > 1 ? " and others" : ""}.`, "muninn report"]);
  if (needs.length) for (const [what, cmd] of needs) out.push(`${mark.need()} ${what}`, `  ${next(cmd)}`);
  else out.push(`${mark.ok()} Nothing needs you.${repo ? "" : " Run muninn inside a git repo to see that repo."}`);
  out.push("");
  const w = h.week;
  const week = [w.sessions ? `lessons were told in ${plural(w.sessions, "session")}.` : "nothing was told to your agents yet."];
  if (w.problems.kept) week.push(w.problems.cameBack ? `${w.problems.cameBack} of the ${plural(w.problems.kept, "problem")} you kept a lesson for came back.` : `None of the ${plural(w.problems.kept, "problem")} you kept a lesson for came back.`);
  out.push(`This week: ${week.join(" ")}`, "");
  const group = (title: string, rows: [string, string][]) => { out.push(c.bold(title)); for (const [cmd, what] of rows) out.push(`  ${c.cmd(pad(cmd, 20))}${c.dim(what)}`); out.push(""); };
  group("Every day", [["muninn ui", "open the page"], ['muninn ask "…"', "ask about your past work"], ["muninn plan", "where this branch stands"]]);
  group("Check on it", [["muninn status", "is everything connected"], ["muninn report", "is it helping"], ["muninn insights", "where agents wasted effort this week"]]);
  group("Share and undo", [["muninn share", "put this repo's lessons in the repo, for your team"], ["muninn pause", "stop telling agents for now"], ["muninn uninstall", "remove the hooks, keep your lessons"]]);
  out.push(`${c.dim(`All ${commandCount} commands:`)} ${c.cmd("muninn help")}`);
  console.log(out.join("\n"));
}
