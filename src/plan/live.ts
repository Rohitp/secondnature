import type { Client } from "@libsql/client";
import { existsSync, globSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logRoots } from "../config.js";
import { readClaude } from "../logs/claude-code.js";
import { isOwnRun, type Session } from "../logs/types.js";
import { repoIdentity } from "../repo/identity.js";
import { linkLaunched, roleOf } from "../workflow/runs.js";

/**
 * "Working now": the sessions and subagents running in a repo at this moment, each with one line on what it's doing.
 * The plan itself only changes when a session checkpoints or ends, and sessions a coordinator starts work on branches
 * of their own, so without this the coordinator's plan says nothing about them while they work.
 *
 * Two sources: the logs (which sessions wrote anything in the last few minutes), and notes the agents write with the
 * plan_note tool. A note wins over muninn's guess from the log, because the agent knows what it is doing.
 */
export type NoteState = "working" | "blocked" | "waiting" | "done";
export const NOTE_STATES: NoteState[] = ["working", "blocked", "waiting", "done"];
export type PlanNote = { repo_id: string; branch: string; who: string; state: NoteState; text: string; at: string };
export type WorkingRow = {
  name: string; kind: "session" | "subagent" | "note"; branch: string | null; at: string; state: NoteState | "active";
  /** What it's doing: the agent's own note, else its subagent task or its latest message. */
  doing: string | null; from: "note" | "log";
  /** For a subagent: the session that started it. */
  parent?: string;
};

/** A subagent's job from its task: the short description it was started with ("Review 12.3 live diff"), not the prompt after it. */
export const taskLine = (task: string) => { const first = task.split("\n").find((l) => l.trim())?.trim() ?? ""; const m = first.match(/^(.{4,80}?):\s+(.*)$/);
  // "Reviewer: check PR #78" names the role, so the job is after it; "Review 12.3 live diff: You are…" is the job, then the prompt.
  const line = !m ? first : m[1]!.split(/\s+/).length <= 2 ? m[2]! : m[1]!;
  return oneLine(line, 120); };
/** A log counts as running when it was written to this recently. */
export const ACTIVE_MS = 15 * 60_000;
/** Notes stop showing after this long; "done" notes sooner. */
export const NOTE_MS = 24 * 3_600_000;
export const DONE_NOTE_MS = 2 * 3_600_000;
/** Coordinator logs looked at for the names they gave the sessions they started. */
const LOOKBACK_MS = 24 * 3_600_000;

const now = () => new Date().toISOString();
/** First sentence of a message, as plain text: Markdown links and code marks taken out. */
export const oneLine = (t: string, max = 180) => { const s = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]{1,2}([^`*_]+)[`*_]{1,2}/g, "$1").replace(/\s+/g, " ").trim(); const cut = s.match(/^(.{40,}?[.!?])\s/)?.[1] ?? s; return cut.length > max ? cut.slice(0, max - 1) + "…" : cut; };

export async function setNote(db: Client, n: Omit<PlanNote, "at">): Promise<PlanNote> {
  const note = { ...n, who: n.who.trim().slice(0, 60), text: n.text.trim().slice(0, 240), at: now() };
  await db.execute({ sql: "INSERT OR REPLACE INTO plan_notes (repo_id,branch,who,state,text,at) VALUES (?,?,?,?,?,?)", args: [note.repo_id, note.branch, note.who, note.state, note.text, note.at] });
  return note;
}
/** A repo's notes that are still worth showing, newest first. */
export async function recentNotes(db: Client, repo: string, at = Date.now()): Promise<PlanNote[]> {
  const rows = (await db.execute({ sql: "SELECT * FROM plan_notes WHERE repo_id=? AND at>=? ORDER BY at DESC", args: [repo, new Date(at - NOTE_MS).toISOString()] }).catch(() => ({ rows: [] }))).rows as unknown as PlanNote[];
  return rows.filter((r) => r.state !== "done" || at - Date.parse(r.at) < DONE_NOTE_MS);
}

/** Claude Code's folder name for a working folder: every character that isn't a letter or digit becomes "-". */
export const slugOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

const cache = new Map<string, { mtime: number; s: Session }>();
function read(file: string, mtime: number): Session | null {
  const c = cache.get(file);
  if (c && c.mtime === mtime) return c.s;
  try { const s = readClaude(file); cache.set(file, { mtime, s }); return s; } catch { return null; }
}
const ids = new Map<string, string | null>();
const idOf = (cwd: string) => { if (!ids.has(cwd)) ids.set(cwd, existsSync(cwd) ? repoIdentity(cwd) : null); return ids.get(cwd)!; };

export type LiveAgent = { session: Session; name: string; last: string; kind: "session" | "subagent"; parent?: string; doing: string | null };
/**
 * Claude Code sessions and subagents in the repo whose log changed in the last ACTIVE_MS: the repo's own folder and its
 * worktrees. Sessions started from the desktop app get the name their coordinator gave them.
 */
export function liveAgents(repo: string, roots: string[], at = Date.now()): { live: LiveAgent[]; recent: Map<string, Session> } {
  const base = logRoots().claude;
  const none = { live: [] as LiveAgent[], recent: new Map<string, Session>() };
  if (!existsSync(base)) return none;
  const slugs = roots.map(slugOf);
  let dirs: string[] = [];
  try { dirs = readdirSync(base).filter((d) => slugs.some((s) => d === s || d.startsWith(s + "-"))); } catch { return none; }
  const recent: { s: Session; mtime: number }[] = [];
  for (const d of dirs) for (const f of globSync("*.jsonl", { cwd: join(base, d) })) {
    const file = join(base, d, f);
    let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch { continue; }
    if (at - mtime > LOOKBACK_MS) continue;
    const s = read(file, mtime);
    // Another repo whose folder name starts the same way, or a run muninn started itself.
    if (!s || isOwnRun(s) || (s.cwd && idOf(s.cwd) !== repo)) continue;
    recent.push({ s, mtime });
  }
  linkLaunched(recent.map((r) => r.s));
  const out: LiveAgent[] = [];
  for (const { s, mtime } of recent) {
    const subs: LiveAgent[] = [];
    for (const f of globSync("subagents/**/*.jsonl", { cwd: s.file!.replace(/\.jsonl$/, "") })) {
      const file = join(s.file!.replace(/\.jsonl$/, ""), f);
      let m = 0; try { m = statSync(file).mtimeMs; } catch { continue; }
      if (at - m > ACTIVE_MS) continue;
      const sub = read(file, m);
      if (sub) subs.push({ session: sub, name: roleOf(sub), last: new Date(m).toISOString(), kind: "subagent", parent: roleOf(s), doing: sub.task ? taskLine(sub.task) : null });
    }
    if (at - mtime > ACTIVE_MS && !subs.length) continue;
    const said = [...s.events].reverse().find((e) => e.k === "agent");
    out.push({ session: s, name: roleOf(s), last: new Date(mtime).toISOString(), kind: "session", doing: said && said.k === "agent" ? oneLine(said.text) : null }, ...subs);
  }
  return { live: out, recent: new Map(recent.map((r) => [r.s.id, r.s])) };
}

async function rootsOf(db: Client, repo: string): Promise<string[]> {
  try { return (JSON.parse(String((await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0]?.paths ?? "[]")) as string[]).filter(Boolean); } catch { return []; }
}

/**
 * What's running for a branch's plan: live sessions on that branch, the sessions they started (which work on branches
 * of their own), those sessions' subagents, and the notes agents left. A session's newest note, from any branch,
 * replaces muninn's guess for it. `branch` null means the whole repo.
 */
export async function workingNow(db: Client, repo: string, branch: string | null, at = Date.now()): Promise<WorkingRow[]> {
  const { live, recent } = liveAgents(repo, await rootsOf(db, repo), at);
  const top = (l: LiveAgent) => (l.kind === "subagent" ? live.find((x) => x.kind === "session" && x.session.id === l.session.parent) : l);
  const onBranch = (l: LiveAgent | undefined): boolean => {
    if (!l) return false;
    if (!branch || l.session.branch === branch) return true;
    const by = l.session.launchedBy ? recent.get(l.session.launchedBy) : undefined;
    return !!by && by.branch === branch;
  };
  // A coordinator whose own log has gone quiet while the sessions it started work: it's waiting on them, so it's listed first.
  const waiting = new Map<string, Session>();
  for (const l of live) { const by = l.session.launchedBy ? recent.get(l.session.launchedBy) : undefined; if (by && !live.some((x) => x.session.id === by.id)) waiting.set(by.id, by); }
  for (const c of waiting.values()) {
    const last = [...c.events].reverse().find((e) => e.ts)?.ts ?? new Date(at).toISOString();
    live.unshift({ session: c, name: roleOf(c), last, kind: "session", doing: "Waiting on the sessions it started." });
  }
  const notes = await recentNotes(db, repo, at);
  const used = new Set<PlanNote>();
  const noteFor = (name: string) => { const n = notes.find((x) => x.who.toLowerCase() === name.toLowerCase()); if (n) used.add(n); return n; };
  const rows: WorkingRow[] = [];
  for (const l of live) {
    if (!onBranch(top(l))) continue;
    const n = noteFor(l.name);
    rows.push({ name: l.name, kind: l.kind, branch: l.session.branch ?? null, at: n && n.at > l.last ? n.at : l.last, state: n?.state ?? "active", doing: n?.text ?? l.doing, from: n ? "note" : "log", ...(l.parent ? { parent: l.parent } : {}) });
  }
  // Notes for agents muninn can't see running: their log is quiet, or they run in a tool muninn reads only later.
  for (const n of notes) if (!used.has(n) && (!branch || n.branch === branch) && !rows.some((r) => r.name.toLowerCase() === n.who.toLowerCase())) rows.push({ name: n.who, kind: "note", branch: n.branch, at: n.at, state: n.state, doing: n.text, from: "note" });
  return rows;
}

const ago = (iso: string, at = Date.now()) => { const m = Math.max(0, Math.round((at - Date.parse(iso)) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const STATE: Record<WorkingRow["state"], string> = { active: "", working: "", blocked: "BLOCKED: ", waiting: "WAITING ON YOU: ", done: "DONE: " };
/** Working-now rows as plain lines, for agents. */
export function workingLines(rows: WorkingRow[], at = Date.now()): string[] {
  return rows.map((r) => `${r.kind === "subagent" ? "  - " : "- "}${r.name}${r.kind === "subagent" ? ` (subagent of ${r.parent})` : ""}${r.branch ? ` on ${r.branch}` : ""}, ${ago(r.at, at)}: ${STATE[r.state]}${r.doing ?? "no note yet"}${r.from === "log" ? " [from its log]" : ""}`);
}
