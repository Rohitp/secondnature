import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../logs/types.js";

/**
 * Lines in a repo's instruction files (CLAUDE.md and friends) that may be out of date:
 * they name a file or folder that isn't there, a make target or package script that's gone,
 * or paths and commands that never come up in your sessions. Agents read these files every session,
 * so a stale line costs tokens each time and can send an agent the wrong way.
 */
export const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"];
/** How many sessions a repo needs before "never comes up" means anything. */
export const MIN_SESSIONS_FOR_UNUSED = 5;

export type Reason = "missing_path" | "missing_command" | "unused";
export type Flag = { file: string; line: number; text: string; reason: Reason; detail: string };

const EXT = /\.(md|mdx|json|jsonc|ts|tsx|js|jsx|mjs|cjs|py|toml|ya?ml|sh|txt|lock|sql|html|css|cfg|ini|env|rs|go|rb|java|kt|swift|c|h|cpp|hpp|csv|xml|proto|tf)$/i;
/** A backticked name that is a path in the repo: has a slash or a file extension, and no placeholders, globs or URLs. */
export function isPath(s: string): boolean {
  if (/[*<>{}$@?…\s]|^https?:|^~|^\.\.\//.test(s) || s.length > 120) return false;
  return s.includes("/") || EXT.test(s);
}
/** Paths and commands a line names, from its backticks. */
export function refsOf(text: string): { paths: string[]; commands: string[] } {
  const paths: string[] = []; const commands: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = m[1]!.trim();
    if (/^(make|pnpm|npm|yarn|bun|uv|npx|cargo|go|python3?|pytest|poetry|just|bash|sh|\.\/)\b/.test(t) && /\s|^\.\//.test(t)) commands.push(t);
    else if (isPath(t)) paths.push(t.replace(/^\.\//, ""));
  }
  return { paths, commands };
}

const targets = (root: string): Set<string> | null => {
  const f = join(root, "Makefile");
  if (!existsSync(f)) return null;
  return new Set([...readFileSync(f, "utf8").matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]!));
};
const scripts = (root: string): Set<string> | null => {
  try { return new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {})); } catch { return null; }
};
/** Why a command a line names no longer works, or null when it does or can't be told. */
function commandProblem(cmd: string, make: Set<string> | null, pkg: Set<string> | null): string | null {
  // A placeholder ("make try-…", "make <target>") names a family of targets, not one.
  if (/[…<>{}*]|\.\.\./.test(cmd)) return null;
  const mk = cmd.match(/^make\s+([A-Za-z0-9_.-]+)/);
  if (mk && make && !make.has(mk[1]!)) return `\`make ${mk[1]}\` isn't a target in the Makefile`;
  const run = cmd.match(/^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9_:.-]+)/);
  const builtin = /^(install|i|add|remove|exec|dlx|test|run|ci|init|link|publish|update|why|list|ls|x|create)$/;
  if (run && pkg && !builtin.test(run[1]!) && !pkg.has(run[1]!)) return `\`${run[1]}\` isn't a script in package.json`;
  return null;
}

/** Lines of an instruction file worth judging: not headings, blank lines or code blocks. */
function lines(content: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let fence = false;
  content.split("\n").forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (fence || !l.trim() || /^\s*#/.test(l) || /^\s*<!--/.test(l)) return;
    out.push({ n: i + 1, text: l });
  });
  return out;
}

/**
 * A checker for one repo: why a piece of text names something that's no longer there (a missing path, a make
 * target or package script that's gone), or null. Used for instruction-file lines and for kept lessons.
 */
export function repoChecker(root: string): { problem: (text: string) => { reason: "missing_path" | "missing_command"; detail: string } | null; inRepo: (p: string) => boolean } {
  const make = targets(root); const pkg = scripts(root);
  // A path counts as there if it's at the root or anywhere in the tracked files ("tests/" can mean each package's own).
  let tracked: string[] = [];
  try { tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 64 * 1024 * 1024 }).split("\n"); } catch { /* not a git checkout: the root check alone */ }
  const inRepo = (p: string) => {
    if (existsSync(join(root, p))) return true;
    const want = p.replace(/\/$/, "");
    return tracked.some((f) => f === want || f.endsWith(`/${want}`) || f.startsWith(`${want}/`) || f.includes(`/${want}/`));
  };
  const problem = (text: string) => {
    const { paths, commands } = refsOf(text);
    const missing = paths.filter((p) => !inRepo(p));
    if (missing.length) return { reason: "missing_path" as const, detail: `${missing.map((p) => `\`${p}\``).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in the repo` };
    const broken = commands.map((c) => commandProblem(c, make, pkg)).find(Boolean);
    return broken ? { reason: "missing_command" as const, detail: broken } : null;
  };
  return { problem, inRepo };
}

/** Checks one repo's instruction files against the repo and its sessions. */
export function checkRepo(root: string, sessions: Session[]): Flag[] {
  const flags: Flag[] = [];
  const { problem } = repoChecker(root);
  // What sessions in this repo actually touched: commands run and what agents wrote.
  const hay = sessions.length >= MIN_SESSIONS_FOR_UNUSED
    ? sessions.flatMap((s) => s.events.map((e) => (e.k === "cmd" ? e.cmd : e.k === "agent" ? e.text : ""))).join("\n").toLowerCase()
    : null;
  for (const file of MEMORY_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const { n, text } of lines(readFileSync(path, "utf8"))) {
      const { paths, commands } = refsOf(text);
      if (!paths.length && !commands.length) continue;
      const bad = problem(text);
      if (bad) { flags.push({ file, line: n, text: text.trim(), ...bad }); continue; }
      if (hay) {
        // Commands are matched on their first two words, paths on their last part, so "make check -j4" or "./core/x" still count.
        const keys = [...commands.map((c) => c.split(/\s+/).slice(0, 2).join(" ")), ...paths.map((p) => p.replace(/\/$/, "").split("/").pop()!)].map((k) => k.toLowerCase());
        if (keys.every((k) => !hay.includes(k))) flags.push({ file, line: n, text: text.trim(), reason: "unused", detail: `none of what it names came up in your last ${sessions.length} sessions here` });
      }
    }
  }
  return flags;
}

const idOf = (repo: string, f: Flag) => createHash("sha1").update(`${repo}\u0000${f.file}\u0000${f.text}`).digest("hex").slice(0, 16);

/** Saves this repo's flags. A line you kept stays kept; a line that's no longer flagged is dropped. */
export async function saveFlags(db: Client, repo: string, flags: Flag[]) {
  const ids = new Set<string>();
  for (const f of flags) {
    const id = idOf(repo, f); ids.add(id);
    await db.execute({ sql: "INSERT INTO memory_lines (id,repo_id,file,line,text,reason,detail,status,checked_at) VALUES (?,?,?,?,?,?,?,'open',?) ON CONFLICT(id) DO UPDATE SET line=excluded.line, reason=excluded.reason, detail=excluded.detail, checked_at=excluded.checked_at", args: [id, repo, f.file, f.line, f.text, f.reason, f.detail, new Date().toISOString()] });
  }
  const old = (await db.execute({ sql: "SELECT id FROM memory_lines WHERE repo_id=? AND status='open'", args: [repo] })).rows.map((r) => String(r.id));
  for (const id of old) if (!ids.has(id)) await db.execute({ sql: "DELETE FROM memory_lines WHERE id=?", args: [id] });
}

export type MemoryLine = { id: string; repo_id: string; file: string; line: number; text: string; reason: Reason; detail: string; status: string };
export async function openFlags(db: Client, repo: string | null): Promise<MemoryLine[]> {
  return (await db.execute({ sql: `SELECT * FROM memory_lines WHERE (status='open' OR (status='removed' AND removed_at>=?)) ${repo ? "AND repo_id=?" : ""} ORDER BY file, line`, args: [new Date(Date.now() - 86_400_000).toISOString(), ...(repo ? [repo] : [])] })).rows as unknown as MemoryLine[];
}

/** Removes a flagged line from its file, if the line is still there as it was. Returns false when it changed since. */
export async function removeLine(db: Client, id: string, root: string): Promise<boolean> {
  const r = (await db.execute({ sql: "SELECT * FROM memory_lines WHERE id=?", args: [id] })).rows[0] as unknown as MemoryLine | undefined;
  if (!r) return false;
  const path = join(root, r.file);
  if (!existsSync(path)) return false;
  const all = readFileSync(path, "utf8").split("\n");
  // Where the line is now: at its number if unchanged, else the one exact match.
  let at = all[r.line - 1]?.trim() === r.text ? r.line - 1 : -1;
  if (at < 0) { const hits = all.flatMap((l, i) => (l.trim() === r.text ? [i] : [])); if (hits.length === 1) at = hits[0]!; }
  if (at < 0) return false;
  const removed = all[at]!;
  all.splice(at, 1);
  writeFileSync(path, all.join("\n"));
  await db.execute({ sql: "UPDATE memory_lines SET status='removed', line=?, removed_text=?, removed_at=? WHERE id=?", args: [at + 1, removed, new Date().toISOString(), id] });
  return true;
}
/** Puts a removed line back where it was. */
export async function restoreLine(db: Client, id: string, root: string): Promise<boolean> {
  const r = (await db.execute({ sql: "SELECT * FROM memory_lines WHERE id=? AND status='removed'", args: [id] })).rows[0] as unknown as (MemoryLine & { removed_text: string }) | undefined;
  if (!r) return false;
  const path = join(root, r.file);
  if (!existsSync(path)) return false;
  const all = readFileSync(path, "utf8").split("\n");
  all.splice(Math.min(r.line - 1, all.length), 0, r.removed_text);
  writeFileSync(path, all.join("\n"));
  await db.execute({ sql: "UPDATE memory_lines SET status='open' WHERE id=?", args: [id] });
  return true;
}
export async function keepLine(db: Client, id: string) {
  await db.execute({ sql: "UPDATE memory_lines SET status='kept' WHERE id=?", args: [id] });
}

/** The repo's top folder on this machine, from the folders muninn has seen it in. */
export async function rootOf(db: Client, repo: string): Promise<string | null> {
  const paths = String((await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0]?.paths ?? "[]");
  let list: string[] = [];
  try { list = JSON.parse(paths); } catch { /* none */ }
  for (const p of list) {
    if (!existsSync(p)) continue;
    try { return execFileSync("git", ["-C", p, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim(); } catch { /* try the next */ }
  }
  return null;
}
/** Checks one repo and saves what it finds. Returns how many lines are flagged. */
export async function checkAndSave(db: Client, repo: string, sessions: Session[]): Promise<number> {
  const root = await rootOf(db, repo);
  if (!root) return 0;
  const flags = checkRepo(root, sessions);
  await saveFlags(db, repo, flags);
  return Number((await db.execute({ sql: "SELECT count(*) n FROM memory_lines WHERE repo_id=? AND status='open'", args: [repo] })).rows[0]?.n ?? 0);
}
