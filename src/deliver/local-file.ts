import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Lessons in CLAUDE.local.md: the file Claude Code reads at the start of every session in a repo, meant for
 * one person's machine and kept out of git. Claude Code reads it even where muninn's hooks aren't installed
 * or don't run. Per repo, off by default:
 *   off    no file is written
 *   local  "This machine only": always-on lessons go in CLAUDE.local.md, which git is told to ignore
 * muninn owns only the part between its two marker lines and leaves the rest of the file as it is.
 */
export type LessonFileMode = "off" | "local";
export const FILE = "CLAUDE.local.md";
export const START = "<!-- muninn:lessons:start -->";
export const END = "<!-- muninn:lessons:end -->";

const key = (repo: string) => `lesson_file:${repo}`;
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export async function lessonFileMode(db: Client, repo: string): Promise<LessonFileMode> {
  const v = String((await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [key(repo)] })).rows[0]?.value ?? "");
  return v === "local" ? "local" : "off";
}

/** Lesson text can't hold a marker, or a quote from a session could end muninn's part of the file early. */
export const clean = (t: string) => t.replace(/\s+/g, " ").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;").trim();

/**
 * Where muninn's part of a file starts and ends: a line that is exactly the start marker, through the next line
 * that is exactly the end marker. A marker quoted in a sentence, indented, or inside a code example doesn't count.
 */
export function findBlock(text: string, startMark = START, endMark = END): { start: number; end: number } | null {
  let offset = 0, start: number | null = null, fence: string | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "").trimEnd();
    const f = bare.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (fence === null) fence = f[1]!; else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && bare.trim() === f[1]) fence = null; }
    else if (fence === null) {
      if (bare === startMark) start = offset;
      else if (bare === endMark && start !== null) return { start, end: offset + bare.length };
    }
    offset += line.length;
  }
  return null;
}

/** The file with muninn's part replaced, added at the end, or taken out (block null). Everything else is kept. */
export function withBlock(text: string, block: string | null, startMark = START, endMark = END): string {
  const at = findBlock(text, startMark, endMark);
  if (at) {
    const before = text.slice(0, at.start), after = text.slice(at.end).replace(/^\r?\n/, "");
    if (block) return before + block + "\n" + after;
    return (before.replace(/\n+$/, "\n") + after).replace(/^\n+/, "");
  }
  if (!block) return text;
  return text.trim() ? `${text.replace(/\n*$/, "\n\n")}${block}\n` : `${block}\n`;
}

export async function blockFor(db: Client, repo: string): Promise<string> {
  // Lessons already in the team's CLAUDE.md aren't repeated here.
  const shared = (await (await import("./team.js")).sharedIn(db, repo));
  const rows = (await db.execute({ sql: "SELECT id,text FROM lessons WHERE status='live' AND off=0 AND always_on=1 AND role IS NULL AND (scope='global' OR repo_id=?) ORDER BY updated_at", args: [repo] })).rows
    .filter((r) => !(shared.targets.has("claude") && shared.ids.has(String(r.id))));
  return [
    START,
    "## Lessons from muninn",
    "",
    "Kept by muninn from earlier coding sessions, and rewritten when lessons change. Edit them in `muninn ui`; changes made here are overwritten.",
    "",
    ...(rows.length ? rows.map((r) => `- ${clean(String(r.text))}`) : ["- None yet."]),
    "",
    'To find how something works or runs in this repo, run `muninn ask "your question"` in the terminal.',
    END,
  ].join("\n");
}

export function rootOf(paths: string[]): string | null {
  for (const p of paths) { try { if (existsSync(p)) return git(p, "rev-parse", "--show-toplevel"); } catch { /* try the next path */ } }
  return null;
}
/** Tells git to ignore a path in this clone only (.git/info/exclude), unless something already ignores it. */
export function keepOutOfGit(root: string, path = FILE, why = "lessons for this machine only") {
  try { git(root, "check-ignore", "-q", path); return; } catch { /* not ignored yet */ }
  const info = join(resolve(root, git(root, "rev-parse", "--git-common-dir")), "info");
  mkdirSync(info, { recursive: true });
  appendFileSync(join(info, "exclude"), `\n# Written by muninn: ${why}\n${path}\n`);
}
/** A repo's folder on this machine, from the paths muninn has seen it at. */
export async function repoRoot(db: Client, repo: string): Promise<string | null> {
  const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0];
  return row ? rootOf(JSON.parse(String(row.paths))) : null;
}

/** Writes or removes muninn's part of CLAUDE.local.md for one repo, to match its setting. */
export async function writeLessonFile(db: Client, repo: string): Promise<{ file: string; mode: LessonFileMode } | null> {
  const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0];
  const root = row ? rootOf(JSON.parse(String(row.paths))) : null;
  if (!root) return null;
  const file = join(root, FILE);
  const mode = await lessonFileMode(db, repo);
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (mode === "off") {
    if (!findBlock(before)) return { file, mode };
    const after = withBlock(before, null);
    // Remove the file only if muninn's part was all there was.
    if (after.trim()) writeFileSync(file, after); else rmSync(file);
    return { file, mode };
  }
  keepOutOfGit(root);
  const after = withBlock(before, await blockFor(db, repo));
  if (after !== before) writeFileSync(file, after);
  return { file, mode };
}

export async function setLessonFile(db: Client, repo: string, mode: LessonFileMode) {
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [key(repo), mode] });
  return writeLessonFile(db, repo);
}

/** Rewrites the file for every repo that has it on. Called after lessons change. */
export async function syncLessonFiles(db: Client) {
  const rows = (await db.execute("SELECT key FROM meta WHERE key LIKE 'lesson_file:%' AND value='local'")).rows;
  for (const r of rows) { try { await writeLessonFile(db, String(r.key).slice("lesson_file:".length)); } catch { /* a moved or deleted repo shouldn't stop the rest */ } }
}
