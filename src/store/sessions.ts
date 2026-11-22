import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { ensureHome, logRoots } from "../config.js";
import type { Embed } from "../embed/model.js";
import type { Session } from "../logs/types.js";
import { redact } from "../privacy/redact.js";
import { repoIdentity } from "../repo/identity.js";

export { PRIVATE, stripPrivate } from "../logs/types.js";
import { stripPrivate } from "../logs/types.js";

/**
 * How much of each part an exchange keeps. Generous enough that nearly every reply is kept whole; past that, the
 * start and end are kept and the gap says how much was left out. Search by meaning reads only the first `embed`.
 */
const CAP = { typed: 4000, agent: 8000, cmds: 20, cmd: 140, files: 20, text: 12000, embed: 1500 };
/** Keeps the start and end of text that's too long, saying how much of the middle was left out. */
export const keepEnds = (t: string, max: number) => {
  if (t.length <= max) return t;
  const head = Math.floor(max / 3), tail = max - head;
  return `${t.slice(0, head)}\n[… ${(t.length - head - tail).toLocaleString("en-GB")} characters left out …]\n${t.slice(-tail)}`;
};
export type Exchange = { seq: number; ts: string; text: string };

/**
 * A session as exchanges: each thing the engineer typed, with what the agent said and did until the next one.
 * Plain text, redacted, with <private> parts taken out. This is what's stored and searched.
 */
export function exchanges(s: Session): Exchange[] {
  const out: Exchange[] = [];
  let cur: { seq: number; ts: string; typed: string; agent: string[]; cmds: string[]; files: Set<string>; stopped: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    const agent = cur.agent.join("\n").trim();
    const said = keepEnds(agent, CAP.agent);
    const text = [
      `ENGINEER: ${keepEnds(cur.typed, CAP.typed)}`,
      said ? `AGENT: ${said}` : "",
      cur.cmds.length ? `RAN: ${cur.cmds.slice(0, CAP.cmds).join("; ")}${cur.cmds.length > CAP.cmds ? `; and ${cur.cmds.length - CAP.cmds} more` : ""}` : "",
      cur.files.size ? `FILES: ${[...cur.files].slice(0, CAP.files).join(", ")}` : "",
      cur.stopped ? "The engineer stopped the answer." : "",
    ].filter(Boolean).join("\n");
    out.push({ seq: cur.seq, ts: cur.ts, text: keepEnds(redact(stripPrivate(text)), CAP.text) });
  };
  s.events.forEach((e, i) => {
    if (e.k === "typed") { flush(); cur = { seq: i, ts: e.ts, typed: e.text.trim(), agent: [], cmds: [], files: new Set(), stopped: false }; return; }
    if (!cur) return;
    if (e.k === "agent") cur.agent.push(e.text.trim());
    else if (e.k === "cmd") {
      const c = e.cmd.replace(/\s+/g, " ").trim().slice(0, CAP.cmd);
      const err = e.failed ? (e.output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "").slice(0, 100) : "";
      cur.cmds.push(e.stopped ? `\`${c}\` (stopped by the engineer)` : e.failed ? `\`${c}\` failed: ${err}` : `\`${c}\``);
    } else if (e.k === "file") cur.files.add(`${e.tool} ${e.path.replace(s.cwd + "/", "")}${e.failed ? " (failed)" : ""}`);
    else if (e.k === "interrupt") cur.stopped = true;
  });
  flush();
  return out;
}

const vec = (v: Float32Array) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
export const unvec = (b: unknown) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); };

/**
 * Stores sessions as exchanges, with a vector each for search by meaning. Only log files that grew since the
 * last time are read again, and only new exchanges are embedded; exchanges that changed are replaced.
 */
export async function indexSessions(db: Client, sessions: Session[], embed: Embed, opts: { ignored?: Set<string>; onProgress?: (done: number, total: number) => void } = {}): Promise<{ sessions: number; added: number; removed: number }> {
  const res = { sessions: 0, added: 0, removed: 0 };
  const todo: Session[] = [];
  for (const s of sessions) {
    if (!s.file) continue;
    const size = existsSync(s.file) ? statSync(s.file).size : -1;
    const row = (await db.execute({ sql: "SELECT size, indexed_at FROM session_files WHERE file=?", args: [s.file] })).rows[0];
    if (row?.indexed_at && Number(row.size) === size) continue;
    todo.push(s);
  }
  for (const [n, s] of todo.entries()) {
    opts.onProgress?.(n, todo.length);
    const repo = s.cwd ? repoIdentity(s.cwd) : null;
    if (repo && opts.ignored?.has(repo)) continue;
    const ex = exchanges(s).map((x) => ({ ...x, id: createHash("sha1").update(`${s.id}\u0000${x.seq}\u0000${x.text}`).digest("hex").slice(0, 24) }));
    const have = new Set((await db.execute({ sql: "SELECT id FROM chunks WHERE session=?", args: [s.id] })).rows.map((r) => String(r.id)));
    const keep = new Set(ex.map((x) => x.id));
    for (const id of have) if (!keep.has(id)) { await db.execute({ sql: "DELETE FROM chunks WHERE id=?", args: [id] }); await db.execute({ sql: "DELETE FROM chunks_fts WHERE chunk_id=?", args: [id] }); res.removed++; }
    const fresh = ex.filter((x) => !have.has(x.id));
    const vectors = fresh.length ? await embed(fresh.map((x) => x.text.slice(0, CAP.embed))) : new Map();
    for (const x of fresh) {
      const v = vectors.get(x.text.slice(0, CAP.embed));
      await db.execute({ sql: "INSERT OR REPLACE INTO chunks (id,repo_id,session,tool,branch,ts,seq,text,embedding) VALUES (?,?,?,?,?,?,?,?,?)", args: [x.id, repo, s.id, s.tool, s.branch ?? null, x.ts, x.seq, x.text, v ? vec(v) : null] });
      await db.execute({ sql: "INSERT INTO chunks_fts (chunk_id,text) VALUES (?,?)", args: [x.id, x.text] });
      res.added++;
    }
    await db.execute({ sql: "INSERT INTO session_files (file,session,tool,size,indexed_at) VALUES (?,?,?,?,?) ON CONFLICT(file) DO UPDATE SET size=excluded.size, indexed_at=excluded.indexed_at", args: [s.file!, s.id, s.tool, existsSync(s.file!) ? statSync(s.file!).size : 0, new Date().toISOString()] });
    res.sessions++;
  }
  return res;
}

/** Where muninn keeps compressed copies of logs, so they outlive the tool's own clean-up (30 days for Claude Code). */
export const archiveDir = () => join(ensureHome(), "archive");

/** Copies new and grown Claude Code and Codex logs into the archive, compressed. Returns how many were copied. */
export async function archiveLogs(db: Client): Promise<number> {
  const roots = logRoots();
  let n = 0;
  for (const [tool, root, pattern] of [["claude", roots.claude, "*/*.jsonl"], ["codex", roots.codex, "**/rollout-*.jsonl"]] as const) {
    if (!existsSync(root)) continue;
    for (const rel of globSync(pattern, { cwd: root })) {
      const file = join(root, rel);
      const size = statSync(file).size;
      const row = (await db.execute({ sql: "SELECT archived_size FROM session_files WHERE file=?", args: [file] })).rows[0];
      if (row && Number(row.archived_size) === size) continue;
      const to = join(archiveDir(), tool, `${rel}.gz`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, gzipSync(readFileSync(file)));
      const id = rel.split("/").pop()!.replace(/\.jsonl$/, "");
      await db.execute({ sql: "INSERT INTO session_files (file,session,tool,size,archive,archived_size) VALUES (?,?,?,0,?,?) ON CONFLICT(file) DO UPDATE SET archive=excluded.archive, archived_size=excluded.archived_size", args: [file, id, tool === "claude" ? "claude-code" : "codex", to, size] });
      n++;
    }
  }
  return n;
}

/** Archived copies whose original log is gone: the sessions only muninn still has. */
export function archivedOnly(): { tool: "claude" | "codex"; file: string; original: string }[] {
  const roots = logRoots();
  const out: { tool: "claude" | "codex"; file: string; original: string }[] = [];
  for (const tool of ["claude", "codex"] as const) {
    const dir = join(archiveDir(), tool);
    if (!existsSync(dir)) continue;
    for (const rel of globSync("**/*.jsonl.gz", { cwd: dir })) {
      const original = join(tool === "claude" ? roots.claude : roots.codex, rel.replace(/\.gz$/, ""));
      if (!existsSync(original)) out.push({ tool, file: join(dir, rel), original });
    }
  }
  return out;
}


const PLAN_LABEL: Record<string, string> = { decision: "DECISION", done: "DONE", goal: "GOAL", open: "DONE" };
/**
 * The plan's goals, decisions and finished work, stored like exchanges (tool "plan") so one search covers them too.
 * Only new items are embedded; removed ones are taken out.
 */
export async function indexPlan(db: Client, embed: Embed): Promise<number> {
  const items = (await db.execute("SELECT id, repo_id, branch, kind, text, status, coalesce(closed_at, created_at) ts FROM plan_items WHERE status != 'removed' AND (kind IN ('decision','done','goal') OR (kind='open' AND status='closed'))")).rows;
  const have = new Set((await db.execute("SELECT id FROM chunks WHERE tool='plan'")).rows.map((r) => String(r.id)));
  const want = new Set(items.map((i) => `plan:${i.id}`));
  for (const id of have) if (!want.has(id)) { await db.execute({ sql: "DELETE FROM chunks WHERE id=?", args: [id] }); await db.execute({ sql: "DELETE FROM chunks_fts WHERE chunk_id=?", args: [id] }); }
  const fresh = items.filter((i) => !have.has(`plan:${i.id}`)).map((i) => ({ id: String(i.id), repo_id: String(i.repo_id), branch: i.branch ? String(i.branch) : null, ts: String(i.ts), line: `${PLAN_LABEL[String(i.kind)]}${i.branch ? ` on ${i.branch}` : ""}: ${redact(String(i.text))}` }));
  if (!fresh.length) return 0;
  const vectors = await embed(fresh.map((f) => f.line));
  for (const f of fresh) {
    const id = `plan:${f.id}`, v = vectors.get(f.line);
    await db.execute({ sql: "INSERT OR REPLACE INTO chunks (id,repo_id,session,tool,branch,ts,seq,text,embedding) VALUES (?,?,?,?,?,?,0,?,?)", args: [id, String(f.repo_id), `plan:${f.branch ?? ""}`, "plan", f.branch ? String(f.branch) : null, String(f.ts), f.line, v ? vec(v) : null] });
    await db.execute({ sql: "INSERT INTO chunks_fts (chunk_id,text) VALUES (?,?)", args: [id, f.line] });
  }
  return fresh.length;
}
