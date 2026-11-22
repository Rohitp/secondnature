import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keepOutOfGit, repoRoot } from "../deliver/local-file.js";

/**
 * A change muninn proposes to a file agents read, which you apply or dismiss on the page:
 *   guard        an "ask first" permission rule, from commands you keep stopping
 *   skill        a new skill, from steps that repeat across sessions
 *   instruction  an edit to CLAUDE.md, AGENTS.md or a skill, from what your sessions show
 *   trim         a script that shows agents only what matters from a command's output, and a lesson to use it
 * Nothing is written until you apply it, and an applied change can be undone.
 */
export type Kind = "guard" | "skill" | "instruction" | "trim";
export type Evidence = { session: string; tool: string; ts: string; quote: string };
export type Proposal = {
  id: string; repo_id: string | null; kind: Kind; key: string; title: string; why: string;
  payload: Record<string, unknown>; evidence: Evidence[]; status: "proposed" | "applied" | "dismissed";
  created_at: string; decided_at: string | null;
};
export type NewProposal = Omit<Proposal, "id" | "status" | "created_at" | "decided_at">;
/** One file change: the file, what it should hold (null removes it), and whether to keep it out of git. */
export type Change = { file: string; after: string | null; exclude?: { root: string; path: string } };
/** Each kind says how to turn its proposal into file changes, given the repo's folder. */
export type Applier = (p: Proposal, root: string | null) => Change[] | string;
const appliers: Partial<Record<Kind, Applier>> = {};
export const registerApplier = (k: Kind, a: Applier) => { appliers[k] = a; };
/** What else a kind does once its files are written (keep a lesson), and how to take that back on undo. */
export type After = { applied: (db: Client, p: Proposal) => Promise<Record<string, unknown>>; undone: (db: Client, p: Proposal, extra: Record<string, unknown> | undefined) => Promise<void> };
const afters: Partial<Record<Kind, After>> = {};
export const registerAfter = (k: Kind, a: After) => { afters[k] = a; };

const row = (r: Record<string, unknown>): Proposal => ({
  id: String(r.id), repo_id: r.repo_id ? String(r.repo_id) : null, kind: String(r.kind) as Kind, key: String(r.key), title: String(r.title), why: String(r.why),
  payload: JSON.parse(String(r.payload)), evidence: JSON.parse(String(r.evidence)), status: String(r.status) as Proposal["status"],
  created_at: String(r.created_at), decided_at: r.decided_at ? String(r.decided_at) : null,
});

/**
 * Adds a proposal, or refreshes one still waiting with the same key. One you applied or dismissed is left alone,
 * so a dismissed idea doesn't come back each scan. Returns whether it's new.
 */
export async function propose(db: Client, p: NewProposal, opts: { status?: "dismissed" } = {}): Promise<boolean> {
  const old = (await db.execute({ sql: "SELECT id,status FROM proposals WHERE coalesce(repo_id,'')=? AND key=?", args: [p.repo_id ?? "", p.key] })).rows[0];
  if (old && old.status !== "proposed") return false;
  if (old) {
    await db.execute({ sql: "UPDATE proposals SET title=?,why=?,payload=?,evidence=? WHERE id=?", args: [p.title, p.why, JSON.stringify(p.payload), JSON.stringify(p.evidence.slice(-5)), String(old.id)] });
    return false;
  }
  // A candidate judged not worth proposing is stored as dismissed, so it isn't judged again every scan.
  await db.execute({ sql: "INSERT INTO proposals (id,repo_id,kind,key,title,why,payload,evidence,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)", args: [randomUUID(), p.repo_id, p.kind, p.key, p.title, p.why, JSON.stringify(p.payload), JSON.stringify(p.evidence.slice(-5)), new Date().toISOString(), opts.status ?? "proposed"] });
  return true;
}

export async function listProposals(db: Client, repo: string | null, status: Proposal["status"] | "all" = "proposed"): Promise<Proposal[]> {
  const where = [status === "all" ? "1" : "status=?", repo ? "(repo_id=? OR repo_id IS NULL)" : "1"].join(" AND ");
  const args = [...(status === "all" ? [] : [status]), ...(repo ? [repo] : [])];
  return (await db.execute({ sql: `SELECT * FROM proposals WHERE ${where} ORDER BY created_at DESC`, args })).rows.map((r) => row(r as Record<string, unknown>));
}
/** Whether a proposal with this key was ever made (waiting, applied or dismissed). */
export async function known(db: Client, repo: string | null, key: string): Promise<boolean> {
  return (await db.execute({ sql: "SELECT 1 FROM proposals WHERE coalesce(repo_id,'')=? AND key=?", args: [repo ?? "", key] })).rows.length > 0;
}
export async function getProposal(db: Client, id: string): Promise<Proposal | null> {
  const r = (await db.execute({ sql: "SELECT * FROM proposals WHERE id=?", args: [id] })).rows[0];
  return r ? row(r as Record<string, unknown>) : null;
}
export async function dismiss(db: Client, id: string) {
  await db.execute({ sql: "UPDATE proposals SET status='dismissed', decided_at=? WHERE id=? AND status='proposed'", args: [new Date().toISOString(), id] });
}

/** Writes a proposal's changes, keeping each file's earlier content so Undo can put it back. */
export async function apply(db: Client, id: string): Promise<{ files: string[] }> {
  const p = await getProposal(db, id);
  if (!p || p.status !== "proposed") throw new Error("That change isn't waiting any more.");
  const applier = appliers[p.kind];
  if (!applier) throw new Error(`muninn doesn't know how to apply a ${p.kind} change.`);
  const root = p.repo_id ? await repoRoot(db, p.repo_id) : null;
  const changes = applier(p, root);
  if (typeof changes === "string") throw new Error(changes);
  const record = changes.map((c) => ({ file: c.file, before: existsSync(c.file) ? readFileSync(c.file, "utf8") : null, after: c.after }));
  for (const c of changes) {
    if (c.after === null) { if (existsSync(c.file)) rmSync(c.file); }
    else { mkdirSync(dirname(c.file), { recursive: true }); writeFileSync(c.file, c.after); }
    if (c.exclude) { try { keepOutOfGit(c.exclude.root, c.exclude.path, "a change you applied for this machine only"); } catch { /* not a git repo */ } }
  }
  const extra = afters[p.kind] ? await afters[p.kind]!.applied(db, p) : null;
  const payload = extra ? { ...p.payload, after: extra } : p.payload;
  await db.execute({ sql: "UPDATE proposals SET status='applied', decided_at=?, applied=?, payload=? WHERE id=?", args: [new Date().toISOString(), JSON.stringify(record), JSON.stringify(payload), id] });
  return { files: changes.map((c) => c.file) };
}

/** Puts files back as they were before a change was applied, unless they were edited since. */
export async function undo(db: Client, id: string): Promise<void> {
  const r = (await db.execute({ sql: "SELECT status, applied FROM proposals WHERE id=?", args: [id] })).rows[0];
  if (!r || r.status !== "applied" || !r.applied) throw new Error("That change hasn't been applied.");
  const record = JSON.parse(String(r.applied)) as { file: string; before: string | null; after: string | null }[];
  for (const c of record) {
    const now = existsSync(c.file) ? readFileSync(c.file, "utf8") : null;
    if (now !== c.after) throw new Error(`${c.file} was changed after muninn applied this, so it was left alone. Undo it by hand.`);
  }
  for (const c of record) {
    if (c.before === null) { if (existsSync(c.file)) rmSync(c.file); }
    else writeFileSync(c.file, c.before);
  }
  const p = await getProposal(db, id);
  if (p && afters[p.kind]) {
    await afters[p.kind]!.undone(db, p, p.payload.after as Record<string, unknown> | undefined);
    const { after: _, ...rest } = p.payload;
    await db.execute({ sql: "UPDATE proposals SET payload=? WHERE id=?", args: [JSON.stringify(rest), id] });
  }
  await db.execute({ sql: "UPDATE proposals SET status='proposed', decided_at=NULL, applied=NULL WHERE id=?", args: [id] });
}
