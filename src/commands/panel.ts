import type { Client } from "@libsql/client";
import { syncCursor } from "../deliver/cursor.js";
import { age, currentBranch, latestHandoff } from "../handoff/handoff.js";
import { settings } from "../config.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";
import { decide, getLesson } from "../store/lessons.js";
import { shortRepo } from "./ask.js";
export { shortRepo };
import { defaultRoute } from "./review.js";
import { ASKED, shortCommand, tellKey } from "../deliver/hook.js";

export type PanelData = {
  repo: string | null; repoShort: string; branch: string | null;
  sent: { id: string; text: string; plain: string | null; why: string; at: string }[];
  handoff: { text: string; age: string; tool: string; delivered: boolean } | null;
  waiting: { count: number; top: { id: string; text: string; kind: string; route: string }[] };
  week: { sent: number; sessions: number; kept: number; cameBack: number; muninnCostUsd: number | null; muninnCalls: number };
  /** Commands that failed the same way 3 or more times in a row this session, newest first. */
  loops: { name: string; n: number; err: string; tokens: number; at: string; told: boolean }[];
};

/** Why a lesson was sent, in words, from the delivery row. */
export function whySent(event: string, source: string | null, keyword: string | null): string {
  if (keyword === ASKED) return "you asked from the panel";
  if ((event === "SessionStart" || event === "SubagentStart") && keyword === "CLAUDE.local.md") return "always-on, read from CLAUDE.local.md";
  if (event === "SessionStart") return source === "compact" ? "always-on, sent again after compaction" : "always-on, at session start";
  if (event === "SubagentStart") return "always-on, for a subagent";
  if (event === "UserPromptSubmit") return keyword ? `your prompt said "${keyword}"` : "matched your prompt";
  if (event === "PostToolUseFailure" || event === "PostToolUse") return keyword ? `a failed command matched "${keyword}"` : "after a failed command";
  return event;
}

/** Everything the Claude Code panel shows, for one session and folder. */
export async function panelData(db: Client, session: string | null, cwd: string): Promise<PanelData> {
  const repo = repoIdentity(cwd);
  const branch = currentBranch(cwd);
  const rows = session ? (await db.execute({ sql: "SELECT d.lesson_id, d.event, d.source, d.trigger_id, max(d.ts) at, l.text, l.plain FROM deliveries d JOIN lessons l ON l.id=d.lesson_id WHERE d.session=? AND d.outcome='sent' GROUP BY d.lesson_id ORDER BY at DESC", args: [session] })).rows : [];
  const sent = rows.map((r) => ({ id: String(r.lesson_id), text: String(r.text), plain: r.plain ? String(r.plain) : null, why: whySent(String(r.event), r.source ? String(r.source) : null, r.trigger_id ? String(r.trigger_id) : null), at: String(r.at) }));
  let handoff: PanelData["handoff"] = null;
  const given = session ? (await db.execute({ sql: "SELECT h.text, h.created_at, h.tool FROM deliveries d JOIN handoffs h ON h.id=d.handoff_id WHERE d.session=? ORDER BY d.ts DESC LIMIT 1", args: [session] })).rows[0] : undefined;
  if (given) handoff = { text: String(given.text), age: age(String(given.created_at)), tool: String(given.tool), delivered: true };
  else if (repo && branch) {
    const h = await latestHandoff(db, repo, branch, settings().handoffDays, session);
    if (h) handoff = { text: h.text, age: age(h.created_at), tool: h.tool, delivered: false };
  }
  const waitingRows = (await db.execute({ sql: "SELECT id,text,plain,kind,signal,suggested_keywords,suggested_scope FROM lessons WHERE status='proposed' AND (repo_id IS ? OR repo_id=?) ORDER BY sessions DESC, last_seen DESC", args: [repo, repo] })).rows;
  const top = waitingRows.slice(0, 3).map((r) => {
    const d = defaultRoute({ text: String(r.text), kind: String(r.kind ?? "rule"), signal: r.signal ? String(r.signal) : null, suggested_keywords: r.suggested_keywords ? String(r.suggested_keywords) : null, suggested_scope: r.suggested_scope ? String(r.suggested_scope) : null });
    return { id: String(r.id), text: String(r.plain ?? r.text), kind: String(r.kind ?? "rule"), route: d.route === "always" ? `always-on${d.global ? ", any repo" : ""}` : d.route === "keyword" ? `keyword: ${d.keywords.join(", ")}` : "search only" };
  });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const w = (await db.execute({ sql: "SELECT count(*) n, count(DISTINCT session) s FROM deliveries WHERE outcome='sent' AND lesson_id IS NOT NULL AND ts>=?", args: [since] })).rows[0]!;
  const kept = Number((await db.execute({ sql: "SELECT count(*) n FROM lessons WHERE status='live' AND reviewed_at>=?", args: [since] })).rows[0]?.n ?? 0);
  const back = Number((await db.execute({ sql: "SELECT count(DISTINCT e.lesson_id) n FROM evidence e JOIN lessons l ON l.id=e.lesson_id WHERE l.status='live' AND e.seen_at>=? AND e.seen_at>=coalesce(l.reviewed_at,l.created_at)", args: [since] })).rows[0]?.n ?? 0);
  const c = (await db.execute({ sql: "SELECT count(*) n, sum(cost_usd) cost, count(cost_usd) priced FROM llm_calls WHERE ts>=?", args: [since] })).rows[0]!;
  const loopRows = session ? (await db.execute({ sql: "SELECT cmd,n,err,tokens,last_ts,hinted FROM live_loops WHERE session=? AND n>=3 ORDER BY last_ts DESC LIMIT 5", args: [session] })).rows : [];
  // A kept lesson whose word matches the looping command or its error, but that this session wasn't told: offer to tell it now.
  const { matches } = await import("../deliver/hook.js");
  const keyed = loopRows.length ? (await db.execute({ sql: "SELECT l.id, l.text, l.plain, coalesce(l.reviewed_at,l.created_at) kept, t.pattern FROM lessons l JOIN triggers t ON t.lesson_id=l.id WHERE l.status='live' AND l.off=0 AND (l.scope='global' OR l.repo_id IS ?)", args: [repo] })).rows : [];
  const toldHere = new Set(sent.map((x) => x.id));
  const dialNow = loopRows.length ? await (await import("../store/dial.js")).getDial(db, repo) : "anytime";
  const started = session ? String((await db.execute({ sql: "SELECT min(ts) t FROM deliveries WHERE session=?", args: [session] })).rows[0]?.t ?? "") : "";
  const loops = loopRows.map((r) => {
    const hay = `${r.cmd}\n${r.err}`;
    const k = keyed.find((x) => !toldHere.has(String(x.id)) && matches(String(x.pattern), hay));
    const why = started && String(k?.kept) > started ? "this session started before you kept it"
      : dialNow !== "anytime" ? `secondnature is set to speak up ${dialNow === "quiet" ? "only when asked" : "only at session start"} here`
      : `its word "${k?.pattern}" wasn't in a message or failed command that reached secondnature`;
    const lesson = k ? { id: String(k.id), text: String(k.plain ?? k.text), why } : null;
    return { name: shortCommand(String(r.cmd)), n: Number(r.n), err: String(r.err), tokens: Number(r.tokens), at: String(r.last_ts), told: Number(r.hinted) > 0, lesson };
  });
  return {
    repo, repoShort: shortRepo(repo), branch, sent, handoff, loops,
    waiting: { count: waitingRows.length, top },
    week: { sent: Number(w.n), sessions: Number(w.s), kept, cameBack: back, muninnCostUsd: Number(c.priced) ? Number(c.cost) : null, muninnCalls: Number(c.n) },
  };
}

export async function panel(args: string[]) {
  const at = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] ?? null : null; };
  const db = await openDb();
  const session = at("--session"); const cwd = at("--cwd") ?? process.cwd();
  const data = await panelData(db, session, cwd);
  const { homeData } = await import("./home.js");
  // The panel's newer fields (dial, receipt, came back, what agents carry) come from the same source as the web Home.
  const home = await homeData(db, data.repo, session);
  // The branch's plan in short, for "where you left off": the goal, where it stands, the next few steps.
  const { getPlan } = await import("../plan/plan.js");
  const p = data.repo && data.branch ? await getPlan(db, data.repo, data.branch) : null;
  const plan = p && (p.goal || p.status || p.open.length) ? { goal: p.goal?.text ?? null, status: p.status?.text ?? null, next: p.open.slice(0, 3).map((o) => o.text) } : null;
  // For the first-run note: how many sessions muninn has seen here, and whether a scan is running.
  const sessionsHere = data.repo ? Number((await db.execute({ sql: "SELECT count(*) n FROM (SELECT session FROM handoffs WHERE repo_id=? UNION SELECT session FROM checkpoints WHERE repo_id=?)", args: [data.repo, data.repo] })).rows[0]?.n ?? 0) : 0;
  const { scanRunning } = await import("./auto.js");
  const kept = data.repo ? Number((await db.execute({ sql: "SELECT count(*) n FROM lessons WHERE status='live' AND (repo_id=? OR scope='global')", args: [data.repo] })).rows[0]?.n ?? 0) : 0;
  console.log(JSON.stringify({ ...data, ...home, branch: data.branch, handoff: data.handoff, loops: data.loops, plan, kept, scanning: scanRunning(), sessionsHere }));
}

/** `muninn dial` shows how much muninn speaks unprompted in this repo; `muninn dial quiet|start|anytime` sets it. */
export async function dial(args: string[]) {
  const { getDial, setDial, DIALS } = await import("../store/dial.js");
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  const label = { quiet: "only when asked", start: "at session start", anytime: "whenever relevant" };
  const words = { quiet: "It never speaks up on its own. Agents can still look things up with muninn ask.", start: "It tells agents your every-session lessons and where you left off when a session starts, then stays silent.", anytime: "It speaks up at the start of a session, and mid-task when a word you chose comes up or a command fails the way it has before." };
  // Friendlier names work too.
  const alias: Record<string, string> = { asked: "quiet", "only-when-asked": "quiet", "session-start": "start", relevant: "anytime", "whenever-relevant": "anytime" };
  if (args[0] && alias[args[0]]) args[0] = alias[args[0]]!;
  const want = args[0];
  if (want) {
    if (!DIALS.includes(want as never)) { console.error(`Usage: muninn dial ${DIALS.join("|")}`); process.exitCode = 1; return; }
    await setDial(db, repo, want as never);
  }
  const d = await getDial(db, repo);
  console.log(`In ${shortRepo(repo)}, muninn speaks up ${label[d]}. ${words[d]}\nChange it with: muninn dial quiet (only when asked) | start (at session start) | anytime (whenever relevant)`);
}

/** Records "helped" or "wrong" for something muninn told an agent. */
export async function feedback(args: string[]) {
  const { recordFeedback } = await import("../store/dial.js");
  const [id, verdict] = args;
  if (!id || (verdict !== "helped" && verdict !== "wrong")) { console.error("Usage: muninn feedback <lesson-id> helped|wrong [--session id]"); process.exitCode = 1; return; }
  const db = await openDb();
  const l = await getLesson(db, id);
  if (!l) { console.error("No lesson with that id."); process.exitCode = 1; return; }
  const i = args.indexOf("--session");
  await recordFeedback(db, { lessonId: l.id, verdict, session: i >= 0 ? args[i + 1] ?? null : null });
  console.log(verdict === "helped" ? "Noted: it helped." : `Noted: wrong here. Retire it with "muninn retire ${l.id.slice(0, 8)}" if it's wrong everywhere.`);
}

/** One-click keep from the panel: muninn's defaults for delivery and scope. */
export async function keepWithDefaults(args: string[]) {
  const db = await openDb();
  const l = args[0] ? await getLesson(db, args[0]) : null;
  if (!l || l.status !== "proposed") { console.error("No lesson to review with that id."); process.exitCode = 1; return; }
  const d = defaultRoute(l);
  await decide(db, l.id, { status: "live", alwaysOn: d.route === "always", triggers: d.route === "keyword" ? d.keywords : [], ...(d.global ? { global: true } : {}) });
  await syncCursor(db);
  console.log(`Kept ${l.id.slice(0, 8)}. Agents are told it ${d.route === "always" ? "every session" : d.route === "keyword" ? `when "${d.keywords.join('", "')}" comes up` : "only when they search"}${d.global ? ", in every repo" : ""}, from their next session.`);
}
export async function reject(args: string[]) {
  const db = await openDb();
  const l = args[0] ? await getLesson(db, args[0]) : null;
  if (!l || l.status !== "proposed") { console.error("No lesson to review with that id."); process.exitCode = 1; return; }
  await decide(db, l.id, { status: "rejected" });
  console.log(`Not kept: ${l.id.slice(0, 8)}. muninn won't suggest it again.`);
}


/** `muninn tell <lesson-id> --session <id>`: tell a kept lesson to that session's agent on its next turn. */
export async function tell(args: string[]) {
  const i = args.indexOf("--session"); const session = i >= 0 ? args[i + 1] : null; const id = args.find((a, n) => n !== i && n !== i + 1 && !a.startsWith("--"));
  if (!id || !session) { console.error("Usage: muninn tell <lesson-id> --session <session-id>"); process.exitCode = 1; return; }
  const db = await openDb();
  const l = await getLesson(db, id);
  if (!l || l.status !== "live") { console.error("No kept lesson with that id."); process.exitCode = 1; return; }
  const key = tellKey(session);
  const now = JSON.parse(String((await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [key] })).rows[0]?.value ?? "[]")) as string[];
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [key, JSON.stringify([...new Set([...now, l.id])])] });
  console.log("Queued. The agent is told it with your next message, or its next failed command.");
}
