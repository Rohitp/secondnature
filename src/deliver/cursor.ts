import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { settings } from "../config.js";
import { currentBranch, handoffText, latestHandoff } from "../handoff/handoff.js";

const PREFIX = "muninn";
const EXCLUDE = ".cursor/rules/muninn*.mdc";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const HEADER = "Written by muninn from earlier coding sessions, and rewritten when lessons change. Edit lessons with `muninn edit`, not here.";
const ASK = 'To find how something works or runs in this repo or another, run `muninn ask "your question"` in the terminal.';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "keyword";
const yamlText = (s: string) => JSON.stringify(s.replace(/\s+/g, " "));

export type RuleFile = { name: string; body: string };

/** The rule files for one repo: one always-applied file, and one agent-requested file per keyword. */
export async function cursorRules(db: Client, repo: string, root?: string, role: string | null = null): Promise<RuleFile[]> {
  // A role's lessons go only into that role's worktree; the repo's own folder gets the lessons for every agent.
  const scope = "status='live' AND off=0 AND (scope='global' OR repo_id=?) AND (role IS NULL OR role IS ?)";
  // Lessons already in the team's shared Cursor rule aren't repeated in muninn's own.
  const shared = await (await import("./team.js")).sharedIn(db, repo);
  const dup = (id: unknown) => shared.targets.has("cursor") && shared.ids.has(String(id));
  const always = (await db.execute({ sql: `SELECT id,text FROM lessons WHERE ${scope} AND always_on=1 ORDER BY updated_at`, args: [repo, role] })).rows.filter((r) => !dup(r.id)).map((r) => String(r.text));
  const files: RuleFile[] = [{
    name: `${PREFIX}.mdc`,
    body: `---\ndescription: Lessons kept in muninn for this repo\nalwaysApply: true\n---\n\n# Lessons from muninn\n\n${HEADER}\n\n${always.map((t) => `- ${t}`).join("\n") || "- None yet."}\n\n${ASK}\n`,
  }];
  const kw = (await db.execute({ sql: "SELECT l.id, lower(t.pattern) p, l.text FROM triggers t JOIN lessons l ON l.id=t.lesson_id WHERE l.status='live' AND l.off=0 AND (l.scope='global' OR l.repo_id=?) AND (l.role IS NULL OR l.role IS ?) AND l.always_on=0 ORDER BY p, l.updated_at", args: [repo, role] })).rows;
  const groups = new Map<string, string[]>();
  for (const r of kw) { if (dup(r.id)) continue; const p = String(r.p); if (!groups.has(p)) groups.set(p, []); groups.get(p)!.push(String(r.text)); }
  for (const [p, texts] of groups) {
    const desc = `Use when the task involves "${p}". ${texts[0]!.slice(0, 160)}`;
    files.push({ name: `${PREFIX}-${slug(p)}.mdc`, body: `---\ndescription: ${yamlText(desc)}\nalwaysApply: false\n---\n\n# muninn lessons for "${p}"\n\n${HEADER}\n\n${texts.map((t) => `- ${t}`).join("\n")}\n` });
  }
  const branch = root ? currentBranch(root) : null;
  const h = branch ? await latestHandoff(db, repo, branch, settings().handoffDays) : null;
  if (h) files.push({ name: `${PREFIX}-handoff.mdc`, body: `---\ndescription: Where the last session on this branch left off\nalwaysApply: true\n---\n\n${handoffText(h, settings().handoffStaleDays)}\n` });
  const { getPlan, planText } = await import("../plan/plan.js");
  const plan = branch ? planText(await getPlan(db, repo, branch), repo.split("/").pop() ?? repo, branch) : null;
  if (plan) files.push({ name: `${PREFIX}-plan.mdc`, body: `---\ndescription: The plan for the branch checked out: goal, open items, recent decisions\nalwaysApply: true\n---\n\n${plan}\n` });
  return files;
}

function repoRoot(paths: string[]): string | null {
  for (const p of paths) { try { if (existsSync(p)) return git(p, "rev-parse", "--show-toplevel"); } catch { /* try the next path */ } }
  return null;
}
function exclude(root: string) {
  const info = join(resolve(root, git(root, "rev-parse", "--git-common-dir")), "info");
  mkdirSync(info, { recursive: true });
  const f = join(info, "exclude");
  if (!existsSync(f) || !readFileSync(f, "utf8").split("\n").includes(EXCLUDE)) appendFileSync(f, `\n# Written by muninn for Cursor\n${EXCLUDE}\n`);
}
export async function enabled(db: Client): Promise<string[]> {
  const v = (await db.execute("SELECT value FROM meta WHERE key='cursor_repos'")).rows[0]?.value;
  return v ? JSON.parse(String(v)) : [];
}
const setEnabled = (db: Client, repos: string[]) => db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES ('cursor_repos',?)", args: [JSON.stringify([...new Set(repos)].sort())] });

/** Writes the rule files for a repo, removes muninn files that are no longer needed, and keeps them out of git. */
export async function writeCursorRules(db: Client, repo: string): Promise<{ root: string; files: string[] } | null> {
  const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0];
  const root = row ? repoRoot(JSON.parse(String(row.paths))) : null;
  if (!root) return null;
  const dir = join(root, ".cursor", "rules");
  mkdirSync(dir, { recursive: true });
  exclude(root);
  const files = await cursorRules(db, repo, root);
  for (const f of files) writeFileSync(join(dir, f.name), f.body);
  const keep = new Set(files.map((f) => f.name));
  for (const f of readdirSync(dir)) if (f.startsWith(PREFIX) && f.endsWith(".mdc") && !keep.has(f)) rmSync(join(dir, f));
  return { root, files: [...keep] };
}
export async function enableCursor(db: Client, repo: string) {
  await setEnabled(db, [...(await enabled(db)), repo]);
  return writeCursorRules(db, repo);
}
/** Rewrites the files agents read, for every repo that has them on: Cursor rules and CLAUDE.local.md. Called after lessons change. */
export async function syncCursor(db: Client) {
  for (const repo of await enabled(db)) { try { await writeCursorRules(db, repo); } catch { /* a moved or deleted repo shouldn't stop the rest */ } }
  const { syncLessonFiles } = await import("./local-file.js");
  await syncLessonFiles(db);
  const { syncAntigravity } = await import("./antigravity.js");
  await syncAntigravity(db);
}
export async function disableCursor(db: Client, repo: string | null) {
  const repos = repo ? [repo] : await enabled(db);
  for (const r of repos) {
    const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [r] })).rows[0];
    const root = row ? repoRoot(JSON.parse(String(row.paths))) : null;
    const dir = root ? join(root, ".cursor", "rules") : null;
    if (dir && existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(PREFIX) && f.endsWith(".mdc")) rmSync(join(dir, f));
  }
  await setEnabled(db, repo ? (await enabled(db)).filter((r) => r !== repo) : []);
}
