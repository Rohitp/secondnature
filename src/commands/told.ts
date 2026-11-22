import type { Client } from "@libsql/client";
import { settings } from "../config.js";

/**
 * What secondnature told agents through its hooks: each recent session, what it got, and when nothing was sent, why.
 * Each delivery names the session's repo. Older rows (before 21 Nov 2026) don't, so those sessions are tied to one through
 * what else is known about them: their stored log, the handoff they were given, a loop they hit, or a single-repo lesson.
 */
export type ToldItem = { kind: "lesson" | "handoff" | "plan" | "note"; id: string; text: string; why: string };
export type ToldSession = {
  session: string; tool: string; start: string; last: string;
  told: ToldItem[]; held: ToldItem[]; fromFile: number; loops: { cmd: string; n: number }[];
  checked: number; outcomes: Record<string, number>;
};
export type NeverTold = { id: string; text: string; role: string | null; kept: string; sessionsSince: number; tooEarly: boolean; how: "always" | "keyword" | "lookup"; keywords: string[] };
export type ToldData = { days: number; sessions: ToldSession[]; outcomes: Record<string, number>; unplaced: number; minSessions: number; neverTold: NeverTold[];
  /** How much muninn may add to an agent: lessons and tokens per message, tokens per session. Past these, lessons are held back. */
  room: { lessons: number; tokens: number; sessionTokens: number } };

type Row = Record<string, unknown>;
/** A lesson not told is only worth flagging once this many sessions in its repo have run since it was kept. */
export const MIN_SESSIONS = 3;
const s = (v: unknown) => (v == null ? "" : String(v));

export async function toldData(db: Client, repo: string | null, days = 7): Promise<ToldData> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = (await db.execute({
    sql: `SELECT d.ts,d.tool,d.session,d.event,d.source,d.outcome,d.lesson_id,d.handoff_id,d.trigger_id,d.repo,d.kind,
            l.text ltext,l.plain lplain,CASE WHEN l.scope='repo' THEN l.repo_id END lrepo,h.text htext,h.repo_id hrepo
          FROM deliveries d LEFT JOIN lessons l ON l.id=d.lesson_id LEFT JOIN handoffs h ON h.id=d.handoff_id
          WHERE d.ts>=? ORDER BY d.ts`,
    args: [since],
  })).rows as unknown as Row[];
  // Which repo each session belongs to: its stored log first, then a loop it hit, a handoff or a single-repo lesson it got.
  const repoOf = new Map<string, string>();
  const place = (sess: unknown, r: unknown) => { if (sess && r && !repoOf.has(s(sess))) repoOf.set(s(sess), s(r)); };
  for (const r of rows) place(r.session, r.repo);
  const sessions = [...new Set(rows.map((r) => s(r.session)).filter(Boolean))];
  for (let i = 0; i < sessions.length; i += 300) {
    const part = sessions.slice(i, i + 300); const qs = part.map(() => "?").join(",");
    for (const t of ["chunks", "live_loops"]) {
      const found = (await db.execute({ sql: `SELECT DISTINCT session, repo_id FROM ${t} WHERE repo_id IS NOT NULL AND session IN (${qs})`, args: part })).rows as unknown as Row[];
      for (const f of found) place(f.session, f.repo_id);
    }
  }
  // A lesson kept "everywhere" still names the repo it came from, so only one kept for a single repo places a session.
  for (const r of rows) { place(r.session, r.hrepo); place(r.session, r.lrepo); }
  const loops = (await db.execute({ sql: "SELECT session,cmd,n FROM live_loops WHERE hinted=1 AND last_ts>=?", args: [since] })).rows as unknown as Row[];

  const by = new Map<string, ToldSession>();
  const outcomes: Record<string, number> = {};
  const unplacedSet = new Set<string>();
  for (const r of rows) {
    const sess = s(r.session);
    if (repo && repoOf.get(sess) !== repo) { if (sess && !repoOf.has(sess)) unplacedSet.add(sess); continue; }
    const o = s(r.outcome);
    outcomes[o] = (outcomes[o] ?? 0) + 1;
    if (!sess) continue;
    let x = by.get(sess);
    if (!x) by.set(sess, (x = { session: sess, tool: s(r.tool), start: s(r.ts), last: s(r.ts), told: [], held: [], fromFile: 0, loops: [], checked: 0, outcomes: {} }));
    x.last = s(r.ts);
    x.outcomes[o] = (x.outcomes[o] ?? 0) + 1;
    // Older rows have no kind: a lesson, or a handoff where one is named.
    const kind = s(r.kind) || (r.handoff_id ? "handoff" : "lesson");
    if (kind === "lesson") x.checked++;
    if (o === "limit" && r.lesson_id && !x.held.some((h) => h.id === r.lesson_id)) x.held.push({ kind: "lesson", id: s(r.lesson_id), text: s(r.lplain || r.ltext), why: "no room left in that message or session" });
    if (o !== "sent") continue;
    // Loop warnings show from live_loops, which also has the command and how often it failed.
    if (kind === "loop") continue;
    if (kind === "plan") x.told.push({ kind: "plan", id: "", text: "This branch's plan", why: "at a fresh start" });
    else if (kind === "note") x.told.push({ kind: "note", id: "", text: "That past sessions are stored and can be looked up", why: r.source === "compact" ? "right after the conversation was compressed" : "at a fresh start" });
    else if (kind === "handoff") x.told.push({ kind: "handoff", id: s(r.handoff_id), text: s(r.htext), why: "where the last session on this branch left off" });
    else if (r.trigger_id === "CLAUDE.local.md") x.fromFile++;
    else if (r.lesson_id) x.told.push({ kind: "lesson", id: s(r.lesson_id), text: s(r.lplain || r.ltext), why: r.trigger_id ? `matched "${s(r.trigger_id)}"` : r.event === "SubagentStart" ? "every new agent gets it" : r.event === "SessionStart" ? "every session gets it" : "kept after this session began" });
  }
  for (const l of loops) by.get(s(l.session))?.loops.push({ cmd: s(l.cmd), n: Number(l.n) });

  // Lessons kept for this repo (or everywhere) that no agent was told in the window.
  const live = (await db.execute({
    sql: `SELECT l.id,l.text,l.plain,l.always_on,l.role,coalesce(l.reviewed_at,l.created_at) kept,(SELECT group_concat(pattern,'|') FROM triggers t WHERE t.lesson_id=l.id) kw
          FROM lessons l WHERE l.status='live' AND l.off=0 AND (l.scope='global' OR l.repo_id IS ?)
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.lesson_id=l.id AND d.outcome='sent' AND d.ts>=?)
          ORDER BY l.updated_at DESC`,
    args: [repo, since],
  })).rows as unknown as Row[];
  const neverTold = live.map((l): NeverTold => {
    const keywords = s(l.kw).split("|").filter(Boolean);
    // Sessions here that were still running after it was kept: each was a chance to tell it.
    const sessionsSince = [...by.values()].filter((x) => x.last >= s(l.kept)).length;
    return { id: s(l.id), text: s(l.plain || l.text), role: l.role ? s(l.role) : null, kept: s(l.kept), sessionsSince, tooEarly: sessionsSince < MIN_SESSIONS, how: Number(l.always_on) ? "always" : keywords.length ? "keyword" : "lookup", keywords };
  });
  const list = [...by.values()].sort((a, b) => b.start.localeCompare(a.start));
  const cfg = settings();
  return { days, sessions: list, outcomes, unplaced: unplacedSet.size, minSessions: MIN_SESSIONS, neverTold, room: { lessons: cfg.maxPerDelivery, tokens: cfg.tokensPerDelivery, sessionTokens: cfg.tokensPerSession } };
}
