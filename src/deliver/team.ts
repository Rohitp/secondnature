import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLesson, decide } from "../store/lessons.js";
import { toAntigravity } from "./antigravity.js";
import { clean, repoRoot, withBlock } from "./local-file.js";

/**
 * Team lessons: a repo's kept lessons, written into the repo so they're reviewed like code and reach every coding
 * tool the team uses. `.muninn/lessons.md` is the shared copy muninn reads back; each tool gets the same lessons in
 * the file it reads:
 *   claude       a marked part of CLAUDE.md          (Claude Code)
 *   agents       a marked part of AGENTS.md          (Codex and others that read AGENTS.md)
 *   copilot      a marked part of .github/copilot-instructions.md
 *   cursor       .cursor/rules/team-lessons.mdc
 *   antigravity  .agents/rules/team-lessons.md
 * Only lessons for this repo and every agent are shared: lessons kept for all your repos, or for one role, stay yours.
 * Kept short on purpose: agents read these files every session, and long generated files cost more than they help.
 */
export const TEAM_FILE = ".muninn/lessons.md";
export const TEAM_START = "<!-- muninn:team:start -->";
export const TEAM_END = "<!-- muninn:team:end -->";
export type Target = "claude" | "agents" | "copilot" | "cursor" | "antigravity";
export const TARGETS: Target[] = ["claude", "agents", "copilot", "cursor", "antigravity"];
const PATHS: Record<Target, string> = {
  claude: "CLAUDE.md", agents: "AGENTS.md", copilot: join(".github", "copilot-instructions.md"),
  cursor: join(".cursor", "rules", "team-lessons.mdc"), antigravity: join(".agents", "rules", "team-lessons.md"),
};
/** At most this many lessons, and about this many words, go into the shared files. */
export const TEAM_MAX = { lessons: 15, words: 450 };

type TeamLesson = { id: string; text: string; keyword: string | null };
const meta = (repo: string) => `team:${repo}`;

/** The lessons to share: every-session ones first, then keyword ones, within the limits. */
export async function teamLessons(db: Client, repo: string): Promise<TeamLesson[]> {
  const rows = (await db.execute({ sql: `SELECT l.id, l.text, l.always_on, (SELECT min(lower(pattern)) FROM triggers t WHERE t.lesson_id=l.id) kw
    FROM lessons l WHERE l.status='live' AND l.off=0 AND l.scope='repo' AND l.repo_id=? AND l.role IS NULL AND l.kind='rule'
    ORDER BY l.always_on DESC, coalesce(l.reviewed_at, l.updated_at)`, args: [repo] })).rows;
  const out: TeamLesson[] = []; let words = 0;
  for (const r of rows) {
    if (!r.always_on && !r.kw) continue; // only found by search: not something to put in every agent's instructions
    const text = clean(String(r.text)); const w = text.split(/\s+/).length;
    if (out.length >= TEAM_MAX.lessons || words + w > TEAM_MAX.words) break;
    out.push({ id: String(r.id), text, keyword: r.always_on ? null : String(r.kw) }); words += w;
  }
  return out;
}

const line = (l: TeamLesson) => (l.keyword ? `- When the task involves "${l.keyword}": ${l.text}` : `- ${l.text}`);
const HEADER = "Kept with muninn from this team's coding sessions. Change them by editing .muninn/lessons.md in a pull request, or with muninn; this part is rewritten by `muninn share`.";
export function markdownBlock(ls: TeamLesson[]): string {
  return [TEAM_START, "## Team lessons", "", HEADER, "", ...ls.map(line), TEAM_END].join("\n");
}
/** The shared copy: one lesson per line, keyword lessons marked, so a teammate's muninn can read them back. */
export function teamFile(ls: TeamLesson[]): string {
  return ["# Team lessons", "", "Kept with muninn (secondnature) from this team's coding sessions. One lesson per line. Edit in a pull request like any code; run `muninn share` to copy changes into each tool's file.", "", ...ls.map(line), ""].join("\n");
}
/** Lessons in a shared copy, as written by teamFile (or edited by hand in the same shape). */
export function parseTeamFile(text: string): { text: string; keyword: string | null }[] {
  return text.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => {
    const body = l.replace(/^\s*[-*]\s+/, "").trim();
    const m = body.match(/^When the task involves "([^"]+)":\s*(.+)$/);
    return m ? { text: m[2]!, keyword: m[1]! } : { text: body, keyword: null };
  });
}
function cursorFile(ls: TeamLesson[]): string {
  return `---\ndescription: Team lessons kept with muninn for this repo\nalwaysApply: true\n---\n\n# Team lessons\n\n${HEADER}\n\n${ls.map(line).join("\n")}\n`;
}

/**
 * Whether git ignores a file in the repo, and the rule that does it ("/repo/.gitignore", line 7, ".muninn/"),
 * so muninn can say why the shared copy won't be committed and how to let it through.
 */
export function ignoredBy(root: string, rel: string): { file: string; line: number; pattern: string } | null {
  try {
    const out = execFileSync("git", ["-C", root, "check-ignore", "-v", "--no-index", rel], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = out.match(/^(.*?):(\d+):(.*?)\t/);
    // With -v, git also prints a "!" rule that lets the file through: that means it isn't ignored.
    return m && !m[3]!.startsWith("!") ? { file: m[1]!, line: Number(m[2]), pattern: m[3]! } : null;
  } catch { return null; } // exit code 1: not ignored (or not a git repo)
}
/** What to put in .gitignore so git keeps the shared copy, given the rule that ignores it. */
export function letThrough(pattern: string): string[] {
  const dir = pattern.replace(/^\//, "").replace(/\/$/, "");
  // A whole folder ignored (".muninn/") hides everything in it, even files a later "!" line names: ignore what's in it instead.
  if (dir === ".muninn" || dir === ".muninn/*") return [`${pattern.startsWith("/") ? "/" : ""}.muninn/*`, `!${TEAM_FILE}`];
  return [`!${TEAM_FILE}`];
}

/** Writes the shared copy and each tool's file. Returns the files changed, relative to the repo. */
export async function share(db: Client, repo: string, targets: Target[] = TARGETS): Promise<{ root: string; files: string[]; lessons: number; ignored: { file: string; line: number; pattern: string } | null }> {
  const root = await repoRoot(db, repo);
  if (!root) throw new Error("Couldn't find this repo's folder on this machine.");
  const ls = await teamLessons(db, repo);
  const changed: string[] = [];
  const put = (rel: string, after: string | null) => {
    const file = join(root, rel); const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (after === before) return;
    if (after === null) { if (before !== null) { rmSync(file); changed.push(rel); } return; }
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, after); changed.push(rel);
  };
  const block = (rel: string) => { const f = join(root, rel); const before = existsSync(f) ? readFileSync(f, "utf8") : ""; const after = withBlock(before, ls.length ? markdownBlock(ls) : null, TEAM_START, TEAM_END); put(rel, after.trim() ? after : null); };
  put(TEAM_FILE, teamFile(ls));
  for (const t of targets) {
    if (t === "cursor") put(PATHS.cursor, ls.length ? cursorFile(ls) : null);
    else if (t === "antigravity") put(PATHS.antigravity, ls.length ? toAntigravity({ name: "team-lessons.mdc", body: cursorFile(ls) }).body : null);
    else block(PATHS[t]);
  }
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [meta(repo), JSON.stringify({ ids: ls.map((l) => l.id), targets })] });
  return { root, files: changed, lessons: ls.length, ignored: ignoredBy(root, TEAM_FILE) };
}

/** Takes muninn's parts out of every file again, and forgets the repo is shared. The shared copy is left for git to remove. */
export async function unshare(db: Client, repo: string): Promise<string[]> {
  const root = await repoRoot(db, repo);
  if (!root) return [];
  const changed: string[] = [];
  for (const t of TARGETS) {
    const f = join(root, PATHS[t]);
    if (!existsSync(f)) continue;
    if (t === "cursor" || t === "antigravity") { rmSync(f); changed.push(PATHS[t]); continue; }
    const before = readFileSync(f, "utf8"); const after = withBlock(before, null, TEAM_START, TEAM_END);
    if (after !== before) { if (after.trim()) writeFileSync(f, after); else rmSync(f); changed.push(PATHS[t]); }
  }
  await db.execute({ sql: "DELETE FROM meta WHERE key=?", args: [meta(repo)] });
  return changed;
}

/** Lessons in the shared copy that this muninn doesn't have yet (a teammate's), kept as live lessons so they're measured too. */
export async function importTeam(db: Client, repo: string): Promise<number> {
  const root = await repoRoot(db, repo);
  const f = root ? join(root, TEAM_FILE) : null;
  if (!f || !existsSync(f)) return 0;
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set((await db.execute({ sql: "SELECT text FROM lessons WHERE repo_id=? AND status IN ('live','proposed','retired','rejected')", args: [repo] })).rows.map((r) => norm(clean(String(r.text)))));
  let added = 0;
  for (const l of parseTeamFile(readFileSync(f, "utf8"))) {
    if (have.has(norm(l.text))) continue;
    const id = await createLesson(db, { repo_id: repo, text: l.text, source: "manual", status: "live", by: "team", reviewed: true });
    await decide(db, id, l.keyword ? { triggers: [l.keyword] } : { alwaysOn: true });
    have.add(norm(l.text)); added++;
  }
  return added;
}

/** Ids of lessons in a repo's shared files, and which tools read them there, so they aren't also sent by hooks or local rules. */
export async function sharedIn(db: Client, repo: string | null): Promise<{ ids: Set<string>; targets: Set<Target> }> {
  if (!repo) return { ids: new Set(), targets: new Set() };
  const v = (await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [meta(repo)] })).rows[0]?.value;
  const p = v ? JSON.parse(String(v)) : { ids: [], targets: [] };
  return { ids: new Set(p.ids), targets: new Set(p.targets) };
}
