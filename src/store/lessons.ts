import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";

export type Lesson = { role: string | null; why: string | null; off: number; plain: string | null; kind: string; suggested_keywords: string | null; suggested_scope: string | null; updated_at: string; id: string; repo_id: string | null; scope: string; text: string; source: string; signal: string | null; status: string; sessions: number; last_seen: string | null; reviewed_at: string | null; first_shown_at: string | null; news_to_engineer: number | null; edited_by_person: number; always_on: number };
const COLS = "role,why,off,plain,kind,suggested_keywords,suggested_scope,updated_at,id,repo_id,scope,text,source,signal,status,sessions,last_seen,reviewed_at,first_shown_at,news_to_engineer,edited_by_person,always_on";
const now = () => new Date().toISOString();

export async function ensureRepo(db: Client, id: string, path: string) {
  const { ignoredRepos } = await import("./ignore.js");
  if ((await ignoredRepos(db)).has(id)) return;
  const { mainFolder } = await import("../repo/identity.js");
  const main = mainFolder(path);
  await db.execute({ sql: "INSERT OR IGNORE INTO repos (id,paths) VALUES (?,?)", args: [id, JSON.stringify([main])] });
  // A folder recorded before muninn knew about worktrees may be one of them: put the main folder first.
  const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [id] })).rows[0];
  const paths = row ? (JSON.parse(String(row.paths)) as string[]) : [];
  if (paths[0] && paths[0] !== main && mainFolder(paths[0]) === main) await db.execute({ sql: "UPDATE repos SET paths=? WHERE id=?", args: [JSON.stringify([main, ...paths.filter((p) => p !== main && mainFolder(p) !== main)]), id] });
}
async function version(db: Client, id: string, by: string) {
  const l = await getLesson(db, id);
  const triggers = (await db.execute({ sql: "SELECT pattern FROM triggers WHERE lesson_id=?", args: [id] })).rows.map((r) => r.pattern);
  await db.execute({ sql: "INSERT INTO lesson_versions (id,lesson_id,snapshot,changed_by,changed_at) VALUES (?,?,?,?,?)", args: [randomUUID(), id, JSON.stringify({ ...l, triggers }), by, now()] });
}
export async function createLesson(db: Client, l: { repo_id: string | null; scope?: string; text: string; source: string; signal?: string | null; suggestedScope?: string; kind?: "rule" | "note"; suggestedKeywords?: string[]; status: string; sessions?: number; last_seen?: string | null; vector?: Float32Array; by: string; reviewed?: boolean; wasted?: number; why?: string; role?: string }) {
  const id = randomUUID(); const t = now();
  const vec = l.vector ? `[${[...l.vector].join(",")}]` : null;
  await db.execute({
    sql: `INSERT INTO lessons (id,repo_id,scope,text,source,signal,suggested_scope,kind,suggested_keywords,status,sessions,last_seen,reviewed_at,embedding,created_at,updated_at,wasted_tokens,why,role) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,${vec ? "vector32(?)" : "NULL"},?,?,?,?,?)`,
    args: [id, l.repo_id, l.scope ?? (l.repo_id ? "repo" : "global"), l.text, l.source, l.signal ?? null, l.suggestedScope ?? null, l.kind ?? "rule", l.suggestedKeywords?.length ? JSON.stringify(l.suggestedKeywords) : null, l.status, l.sessions ?? 0, l.last_seen ?? null, l.reviewed ? t : null, ...(vec ? [vec] : []), t, t, l.wasted ?? null, l.why ?? null, l.role ?? null],
  });
  await db.execute({ sql: "INSERT INTO lessons_fts (lesson_id,text) VALUES (?,?)", args: [id, l.text] });
  await version(db, id, l.by);
  return id;
}
export async function getLesson(db: Client, id: string): Promise<Lesson | null> {
  const r = await db.execute({ sql: `SELECT ${COLS} FROM lessons WHERE id=? OR id LIKE ?`, args: [id, `${id}%`] });
  return (r.rows[0] as unknown as Lesson) ?? null;
}
/** Lessons by repo and status. With `withAllRepos`, a repo's list also has the lessons kept for every repo, wherever they were learned. */
export async function listLessons(db: Client, f: { repo?: string | null; status?: string; withAllRepos?: boolean } = {}): Promise<Lesson[]> {
  const where: string[] = []; const args: string[] = [];
  if (f.repo) { where.push(f.withAllRepos ? "(repo_id=? OR scope='global')" : "repo_id=?"); args.push(f.repo); }
  if (f.status) { where.push("status=?"); args.push(f.status); }
  const r = await db.execute({ sql: `SELECT ${COLS} FROM lessons ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sessions DESC, last_seen DESC`, args });
  return r.rows as unknown as Lesson[];
}
/** A repo's lessons with their vectors. With `withGlobal`, also the kept lessons told in every repo, wherever they were learned. */
export async function lessonVectors(db: Client, repo: string, opts: { withGlobal?: boolean } = {}): Promise<{ id: string; status: string; text: string; vector: Float32Array | null; role?: string | null }[]> {
  const where = opts.withGlobal ? "(repo_id=? OR (scope='global' AND status='live'))" : "repo_id=?";
  const r = await db.execute({ sql: `SELECT id,status,text,role,vector_extract(embedding) v FROM lessons WHERE ${where} AND embedding IS NOT NULL`, args: [repo] });
  return r.rows.map((x) => ({ id: String(x.id), status: String(x.status), text: String(x.text), role: x.role == null ? null : String(x.role), vector: x.v ? Float32Array.from(JSON.parse(String(x.v))) : null }));
}
export async function addEvidence(db: Client, id: string, quotes: { tool: string; session: string; ts: string; quote: string }[]) {
  for (const q of quotes) await db.execute({ sql: "INSERT OR IGNORE INTO evidence (lesson_id,tool,session,seen_at,quote) VALUES (?,?,?,?,?)", args: [id, q.tool, q.session, q.ts, q.quote] });
}
export async function touchSeen(db: Client, id: string, sessions: number, last: string) {
  await db.execute({ sql: "UPDATE lessons SET sessions=max(sessions,?), last_seen=max(coalesce(last_seen,''),?), updated_at=? WHERE id=?", args: [sessions, last, now(), id] });
}
export async function markShown(db: Client, id: string) {
  await db.execute({ sql: "UPDATE lessons SET first_shown_at=coalesce(first_shown_at,?) WHERE id=?", args: [now(), id] });
}
/** A person's decision. Agents and scans never call this. */
export async function decide(db: Client, id: string, d: { status?: "live" | "rejected" | "retired"; text?: string; news?: boolean; alwaysOn?: boolean; global?: boolean; triggers?: string[]; off?: boolean; role?: string | null }) {
  const sets = ["updated_at=?", "reviewed_at=?"]; const t = now(); const args: (string | number)[] = [t, t];
  if (d.status) { sets.push("status=?"); args.push(d.status); }
  // New text makes the plain line and questions stale. The next learn, or the UI, writes them again.
  if (d.text !== undefined) { sets.push("text=?", "edited_by_person=1", "plain=NULL"); args.push(d.text); }
  if (d.news !== undefined) { sets.push("news_to_engineer=?"); args.push(d.news ? 1 : 0); }
  if (d.alwaysOn !== undefined) { sets.push("always_on=?"); args.push(d.alwaysOn ? 1 : 0); }
  if (d.global !== undefined) { sets.push("scope=?"); args.push(d.global ? "global" : "repo"); }
  if (d.off !== undefined) { sets.push("off=?"); args.push(d.off ? 1 : 0); }
  // The role in a team of agents it's told to ("builder"); null or "" for every agent.
  if (d.role !== undefined) { sets.push("role=?"); args.push((d.role ?? "").trim().toLowerCase() || null as unknown as string); }
  await db.execute({ sql: `UPDATE lessons SET ${sets.join(",")} WHERE id=?`, args: [...args, id] });
  if (d.text !== undefined) {
    await db.execute({ sql: "DELETE FROM lessons_fts WHERE lesson_id=?", args: [id] });
    await db.execute({ sql: "INSERT INTO lessons_fts (lesson_id,text) VALUES (?,?)", args: [id, d.text] });
    await db.execute({ sql: "DELETE FROM lesson_questions WHERE lesson_id=?", args: [id] });
  }
  if (d.triggers) {
    await db.execute({ sql: "DELETE FROM triggers WHERE lesson_id=?", args: [id] });
    for (const p of d.triggers) await db.execute({ sql: "INSERT INTO triggers (id,lesson_id,pattern,created_at) VALUES (?,?,?,?)", args: [randomUUID(), id, p, t] });
  }
  await version(db, id, "person");
}
export const routeOf = async (db: Client, l: Lesson) => (l.always_on ? true : (await db.execute({ sql: "SELECT 1 FROM triggers WHERE lesson_id=? LIMIT 1", args: [l.id] })).rows.length > 0);

export async function keywordsInUse(db: Client, repo: string | null): Promise<{ pattern: string; lessons: number }[]> {
  const r = await db.execute({ sql: "SELECT lower(t.pattern) pattern, count(*) n FROM triggers t JOIN lessons l ON l.id=t.lesson_id WHERE l.status='live' AND (l.scope='global' OR l.repo_id IS ? OR l.repo_id=?) GROUP BY lower(t.pattern) ORDER BY n DESC, pattern", args: [repo, repo] });
  return r.rows.map((x) => ({ pattern: String(x.pattern), lessons: Number(x.n) }));
}
export async function lessonsForKeyword(db: Client, repo: string | null, pattern: string): Promise<Lesson[]> {
  const r = await db.execute({ sql: `SELECT ${COLS.split(",").map((c) => "l." + c).join(",")} FROM lessons l JOIN triggers t ON t.lesson_id=l.id WHERE l.status='live' AND lower(t.pattern)=lower(?) AND (l.scope='global' OR l.repo_id IS ? OR l.repo_id=?) ORDER BY l.always_on DESC, length(t.pattern) DESC, l.updated_at DESC`, args: [pattern, repo, repo] });
  return r.rows as unknown as Lesson[];
}
const quoteKey = (session: string, quote: string) => `${session}\u0000${quote}`;
export type EvidenceOwner = { id: string; status: string; created_at: string };
/** For each (session, quote) of evidence in a repo, the lessons it already backs. */
export async function evidenceIndex(db: Client, repo: string): Promise<Map<string, EvidenceOwner[]>> {
  const r = await db.execute({ sql: "SELECT e.session, e.quote, l.id, l.status, l.created_at FROM evidence e JOIN lessons l ON l.id=e.lesson_id WHERE l.repo_id=?", args: [repo] });
  const idx = new Map<string, EvidenceOwner[]>();
  for (const x of r.rows) {
    const k = quoteKey(String(x.session), String(x.quote));
    const list = idx.get(k) ?? []; list.push({ id: String(x.id), status: String(x.status), created_at: String(x.created_at) }); idx.set(k, list);
  }
  return idx;
}
const rank = (o: EvidenceOwner) => (o.status === "live" ? 0 : o.status === "proposed" ? 1 : 2);
/** The lesson that already owns any of these quotes: live first, then the oldest proposed, then rejected or retired. */
export function ownerOf(idx: Map<string, EvidenceOwner[]>, quotes: { session: string; quote: string }[], skip?: string): EvidenceOwner | null {
  let best: EvidenceOwner | null = null;
  for (const q of quotes) for (const o of idx.get(quoteKey(q.session, q.quote)) ?? []) {
    if (o.id === skip) continue;
    if (!best || rank(o) < rank(best) || (rank(o) === rank(best) && o.created_at < best.created_at)) best = o;
  }
  return best;
}
/**
 * Proposed lessons built from the same quotes as a live or older proposed lesson are the same lesson
 * written twice. Moves their evidence to that lesson and retires them. Never touches live lessons.
 */
export async function foldDuplicates(db: Client, repo: string): Promise<number> {
  const idx = await evidenceIndex(db, repo);
  const proposed = (await db.execute({ sql: "SELECT id, created_at FROM lessons WHERE repo_id=? AND status='proposed' ORDER BY created_at DESC", args: [repo] })).rows;
  let folded = 0;
  for (const p of proposed) {
    const id = String(p.id);
    const quotes = (await db.execute({ sql: "SELECT session, quote FROM evidence WHERE lesson_id=?", args: [id] })).rows.map((x) => ({ session: String(x.session), quote: String(x.quote) }));
    const owner = ownerOf(idx, quotes, id);
    if (!owner || owner.status === "rejected" || owner.status === "retired") continue;
    if (owner.status === "proposed" && owner.created_at >= String(p.created_at)) continue;
    await db.execute({ sql: "INSERT OR IGNORE INTO evidence (lesson_id,tool,session,seen_at,quote) SELECT ?,tool,session,seen_at,quote FROM evidence WHERE lesson_id=?", args: [owner.id, id] });
    await db.execute({ sql: "UPDATE lessons SET status='retired', updated_at=? WHERE id=?", args: [now(), id] });
    await version(db, id, "learn:duplicate");
    for (const list of idx.values()) for (const o of list) if (o.id === id) o.status = "retired";
    folded++;
  }
  return folded;
}
/** Live lessons in a repo that share evidence with another live lesson. Only a person can merge these. */
export async function overlappingLive(db: Client, repo: string): Promise<[string, string][]> {
  const r = await db.execute({ sql: "SELECT DISTINCT a.lesson_id x, b.lesson_id y FROM evidence a JOIN evidence b ON a.session=b.session AND a.quote=b.quote AND a.lesson_id<b.lesson_id JOIN lessons la ON la.id=a.lesson_id JOIN lessons lb ON lb.id=b.lesson_id WHERE la.repo_id=? AND lb.repo_id=? AND la.status='live' AND lb.status='live'", args: [repo, repo] });
  return r.rows.map((x) => [String(x.x), String(x.y)]);
}
/** Combines two lessons a person chose to combine: the other is retired, and its evidence moves over. */
export async function combine(db: Client, keepId: string, otherId: string, text?: string) {
  await db.execute({ sql: "INSERT OR IGNORE INTO evidence (lesson_id,tool,session,seen_at,quote) SELECT ?,tool,session,seen_at,quote FROM evidence WHERE lesson_id=?", args: [keepId, otherId] });
  await db.execute({ sql: "INSERT OR IGNORE INTO triggers (id,lesson_id,pattern,created_at) SELECT lower(hex(randomblob(16))),?,pattern,created_at FROM triggers WHERE lesson_id=?", args: [keepId, otherId] });
  await decide(db, otherId, { status: "retired" });
  if (text) await decide(db, keepId, { text });
}
/**
 * Adds a waiting suggestion to an older lesson that already says much the same, instead of keeping both.
 * The older lesson keeps where and when it's told (every repo or one, every session or on a keyword),
 * takes the new wording if one is given, and gets the suggestion's quotes. The suggestion is retired.
 */
export async function addToOlder(db: Client, newId: string, olderId: string, text?: string) {
  const older = await getLesson(db, olderId);
  if (!older || !["live", "proposed"].includes(older.status)) throw new Error("That older lesson isn't kept or waiting any more.");
  if (older.id === newId) throw new Error("A lesson can't be added to itself.");
  await combine(db, older.id, newId, text);
  await db.execute({ sql: "UPDATE lessons SET why=coalesce(why,(SELECT why FROM lessons WHERE id=?)) WHERE id=?", args: [newId, older.id] });
  return older.id;
}
