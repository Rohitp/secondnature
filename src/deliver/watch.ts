import type { Client } from "@libsql/client";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { WAIT } from "../learn/cost-signals.js";

/**
 * Watches a Claude Code session while it runs, after each shell command: how much context every step now re-reads,
 * and whether the agent is waiting by checking again and again. When either crosses a line, the agent is told once,
 * in a sentence, and a note goes on the branch's plan so the engineer sees it without asking.
 * Only the end of the transcript is read, so it stays fast on logs of many megabytes.
 */
export const WATCH = {
  /** A transcript smaller than this can't hold a heavy context: nothing is read. */
  minFile: 600_000,
  /** How much of the transcript's end is read. */
  tail: 1_500_000,
  /** Context per step at which the agent is told, once each. */
  levels: [300_000, 600_000],
  /** Waits among the recent shell commands before the agent is told. */
  waitsAt: 3,
  /** How many recent shell commands that counts over. */
  recent: 10,
};

export type Seen = { context: number; waits: number; title: string | null; branch: string | null };

/** The last `bytes` of a file as whole JSON lines. */
export function tailLines(file: string, bytes = WATCH.tail): any[] {
  const size = statSync(file).size;
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (n < size) lines.shift(); // cut mid-line
  return lines.filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** The session's latest context per step, its recent waits, and its name and branch, from the end of its transcript. */
export function seenIn(lines: any[]): Seen {
  let context = 0, title: string | null = null, branch: string | null = null;
  const cmds: string[] = [];
  for (const o of lines) {
    if (o.type === "custom-title" && typeof o.customTitle === "string") title = o.customTitle;
    if (typeof o.gitBranch === "string" && o.gitBranch) branch = o.gitBranch;
    if (o.type !== "assistant" || o.isSidechain) continue;
    const u = o.message?.usage;
    if (u) context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    for (const x of Array.isArray(o.message?.content) ? o.message.content : []) if (x?.type === "tool_use" && x.name === "Bash" && typeof x.input?.command === "string") cmds.push(x.input.command);
  }
  return { context, waits: cmds.slice(-WATCH.recent).filter((c) => WAIT.test(c)).length, title, branch };
}

const k = (n: number) => `${Math.round(n / 1000)}k`;
export type Warning = { key: string; agent: string; note: string };
/** What to tell the agent now, given what it was told already (`done` keys). Each warning goes once per session. */
export function warningsFor(s: Seen, done: Set<string>): Warning[] {
  const out: Warning[] = [];
  const level = [...WATCH.levels].reverse().find((l) => s.context >= l);
  if (level && !done.has(`heavy:${level}`)) out.push({
    key: `heavy:${level}`,
    agent: `muninn: this session now re-reads about ${k(s.context)} tokens of context on every step, even small ones. When you start a new phase (review fixes, QA fixes, rebase and merge, a small follow-up), hand it to a fresh agent or session with a short brief and a hand-over note rather than carrying this history.`,
    note: `Carries about ${k(s.context)} of context on every step; muninn suggested a fresh agent for the next phase.`,
  });
  if (s.waits >= WATCH.waitsAt && !done.has("wait")) out.push({
    key: "wait",
    agent: `muninn: you've waited by re-running a check ${s.waits} times recently, and each check re-reads about ${k(s.context)} tokens of context. Run the slow step in the background and wait for its completion notice instead of polling.`,
    note: `Waiting by re-running a check (${s.waits} times recently), each re-reading about ${k(s.context)}; muninn suggested waiting for the completion notice instead.`,
  });
  return out;
}

/**
 * The check after a shell command. Returns the text for the agent, or null. Opens the database only when there's
 * something to say, and records what was said so it isn't said again.
 */
export async function watchSession(input: { session_id?: string; transcript_path?: string; cwd?: string }, openDb: () => Promise<Client>): Promise<string | null> {
  const file = input.transcript_path, session = input.session_id;
  if (!file || !session) return null;
  let size = 0; try { size = statSync(file).size; } catch { return null; }
  if (size < WATCH.minFile) return null;
  const seen = seenIn(tailLines(file));
  if (seen.context < WATCH.levels[0]! && seen.waits < WATCH.waitsAt) return null;
  const db = await openDb();
  const key = `watch:${session}`;
  const row = (await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [key] })).rows[0];
  const done = new Set<string>(row ? (JSON.parse(String(row.value)) as string[]) : []);
  const ws = warningsFor(seen, done);
  if (!ws.length) return null;
  for (const w of ws) done.add(w.key);
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [key, JSON.stringify([...done])] });
  const { repoIdentity } = await import("../repo/identity.js");
  const repo = input.cwd ? repoIdentity(input.cwd) : null;
  // A note on the plan, so the engineer sees it under Working now, whatever the dial says.
  try {
    if (repo) {
      const { setNote } = await import("../plan/live.js");
      const who = `muninn on ${seen.title ?? "a session"}`.slice(0, 60);
      await setNote(db, { repo_id: repo, branch: seen.branch && seen.branch !== "HEAD" ? seen.branch : "main", who, state: "working", text: ws.map((w) => w.note).join(" ") });
    }
  } catch { /* the note is extra */ }
  // The dial set to quiet: muninn speaks to agents only when asked.
  const { getDial } = await import("../store/dial.js");
  if ((await getDial(db, repo)) === "quiet") return null;
  return ws.map((w) => w.agent).join("\n");
}
