import { closeSync, globSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { leftAlone, logRoots } from "../config.js";
import { repoIdentity } from "../repo/identity.js";
import { readClaude } from "./claude-code.js";
import { readCodex } from "./codex.js";
import { readAntigravity } from "./antigravity.js";
import { readCursor, slugToPath } from "./cursor.js";
import { isOwnRun, type Session, type WorkflowRun } from "./types.js";
import { archivedOnly } from "../store/sessions.js";
import { roleOf } from "../workflow/runs.js";

export type Scan = { sessions: Session[]; byRepo: Map<string, Session[]>; missingFolder: number; ownRuns: number; files: { claude: number; codex: number; cursor: number; antigravity: number } };

export function logFiles() {
  const roots = logRoots();
  return {
    roots,
    claude: globSync("*/*.jsonl", { cwd: roots.claude }).map((f) => join(roots.claude, f)),
    /** Subagents' own logs, beside the session that started them. */
    claudeSub: [...globSync("*/*/subagents/*.jsonl", { cwd: roots.claude }), ...globSync("*/*/subagents/workflows/*/*.jsonl", { cwd: roots.claude })].map((f) => join(roots.claude, f)),
    /** Claude Code workflow runs' summary files: name, phases, agents, tokens, and the log lines the workflow wrote. */
    claudeWorkflows: globSync("*/*/workflows/*.json", { cwd: roots.claude }).map((f) => join(roots.claude, f)),
    codex: globSync("**/rollout-*.jsonl", { cwd: roots.codex }).map((f) => join(roots.codex, f)),
    cursor: globSync("*/agent-transcripts/**/*.jsonl", { cwd: roots.cursor }).map((f) => join(roots.cursor, f)),
    antigravity: globSync("{antigravity,antigravity-ide,antigravity-cli}/brain/*/.system_generated/logs/transcript.jsonl", { cwd: roots.antigravity }).map((f) => join(roots.antigravity, f)),
  };
}
/** Reads one transcript, picking the reader by where the file lives. */
export function readAny(file: string): Session {
  const roots = logRoots();
  if (file.startsWith(roots.cursor) || file.includes("/.cursor/")) return readCursor(file, file.startsWith(roots.cursor) ? roots.cursor : file.slice(0, file.indexOf("/.cursor/") + 17));
  if (file.startsWith(roots.codex) || file.includes("/.codex/") || /rollout-.*\.jsonl$/.test(file)) return readCodex(file);
  return readClaude(file);
}

/** Reads every available log and groups sessions by repo. Agent subprocess logs are skipped. */
export function scanLogs(): Scan {
  const f = logFiles();
  const scan: Scan = { sessions: [], byRepo: new Map(), missingFolder: 0, ownRuns: 0, files: { claude: f.claude.length, codex: f.codex.length, cursor: f.cursor.length, antigravity: f.antigravity.length } };
  const all = [...f.claude.map(readClaude), ...f.codex.map(readCodex), ...f.cursor.map((x) => readCursor(x, f.roots.cursor)), ...f.antigravity.map(readAntigravity)];
  // Sessions whose log the tool has since deleted, read from muninn's compressed copy.
  for (const a of archivedOnly()) { try { all.push(a.tool === "claude" ? readClaude(a.file) : readCodex(a.file)); } catch { /* a damaged copy */ } }
  // Subagents go with the session that started them: same repo, never counted as sessions of their own.
  const subs = new Map<string, Session[]>();
  for (const file of f.claudeSub) { try { const x = readClaude(file); if (x.parent) subs.set(x.parent, [...(subs.get(x.parent) ?? []), x]); } catch { /* a damaged log */ } }
  // Antigravity swarm agents: conversations started by another conversation's message, not by you.
  for (const x of all) if (x.tool === "antigravity" && x.parent) subs.set(x.parent, [...(subs.get(x.parent) ?? []), x]);
  for (const s of all) if (subs.has(s.id)) s.subagents = subs.get(s.id);
  // Workflow runs a session started, from their summary files.
  const wfs = new Map<string, WorkflowRun[]>();
  for (const file of f.claudeWorkflows) {
    try {
      const o = JSON.parse(readFileSync(file, "utf8"));
      const session = basename(dirname(dirname(file)));
      const w: WorkflowRun = { id: String(o.runId ?? basename(file, ".json")), name: String(o.workflowName ?? ""), status: String(o.status ?? ""), started: typeof o.startTime === "number" ? new Date(o.startTime).toISOString() : String(o.timestamp ?? ""), durationMs: Number(o.durationMs ?? 0), agents: Number(o.agentCount ?? 0), tokens: Number(o.totalTokens ?? 0), phases: Array.isArray(o.phases) ? o.phases.map((p: { title?: string }) => String(p.title ?? "")) : [], logs: Array.isArray(o.logs) ? o.logs.map(String).slice(0, 50) : [] };
      wfs.set(session, [...(wfs.get(session) ?? []), w]);
    } catch { /* a summary being written */ }
  }
  for (const s of all) if (wfs.has(s.id)) s.workflowRuns = wfs.get(s.id);
  // Each session's role in a team of agents, for runs, session reviews and insights.
  for (const s of all) for (const x of [s, ...(s.subagents ?? [])]) { try { x.role = roleOf(x); } catch { /* roles are extra */ } }
  for (const s of all) {
    // A session nobody typed in still counts when its model did work: another session or agent started it with a
    // brief. Those sessions are where unattended work, and most of its cost, happens.
    if (!s.events.some((e) => e.k === "typed")) { if (!s.turns?.length) continue; s.unattended = true; }
    if (leftAlone(s.tool)) continue; // a tool you unticked in setup isn't read
    if (isOwnRun(s)) { scan.ownRuns++; continue; }
    const repo = s.cwd ? repoIdentity(s.cwd) : null;
    if (!repo) { scan.missingFolder++; continue; }
    scan.sessions.push(s);
    if (!scan.byRepo.has(repo)) scan.byRepo.set(repo, []);
    scan.byRepo.get(repo)!.push(s);
  }
  return scan;
}

/** The working folder a log was recorded in, read from the first part of the file only, so it's quick. */
function folderOf(file: string, tool: "claude" | "codex" | "cursor", cursorRoot: string): string | null {
  if (tool === "cursor") return slugToPath(file.slice(cursorRoot.length + 1).split(/[\\/]/)[0] ?? "");
  let head = "";
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch { return null; }
  const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

/**
 * Every repo you have sessions in on this machine, from the logs themselves, without a scan.
 * The page lists these so a repo shows up whether or not muninn has learned anything there yet.
 */
export function reposInLogs(): Map<string, string> {
  const f = logFiles();
  const folders = new Set<string>();
  for (const [tool, files] of [["claude", f.claude], ["codex", f.codex], ["cursor", f.cursor]] as const) {
    for (const file of files) { const d = folderOf(file, tool, f.roots.cursor); if (d) folders.add(d); }
  }
  // Antigravity logs don't record a folder: it's worked out from the files the agent touched.
  for (const file of f.antigravity) { try { const d = readAntigravity(file).cwd; if (d) folders.add(d); } catch { /* unreadable log */ } }
  const repos = new Map<string, string>();
  for (const d of folders) { const r = repoIdentity(d); if (r && !repos.has(r)) repos.set(r, d); }
  return repos;
}

/** Each coding tool on this machine, with how many sessions and repos its logs hold, for setup's "Found on this Mac". */
export function toolsOnThisMac(codexInstalled: boolean): { id: "claude-code" | "cursor" | "antigravity" | "codex"; name: string; sessions: number; repos: number; installed: boolean }[] {
  const f = logFiles();
  const repos = (files: string[], tool: "claude" | "codex" | "cursor") => new Set(files.map((x) => folderOf(x, tool, f.roots.cursor)).filter(Boolean).map((d) => repoIdentity(d!)).filter(Boolean)).size;
  const agRepos = new Set(f.antigravity.map((x) => { try { const d = readAntigravity(x).cwd; return d ? repoIdentity(d) : null; } catch { return null; } }).filter(Boolean)).size;
  const has = (p: string) => { try { return globSync("*", { cwd: p }).length > 0; } catch { return false; } };
  return [
    { id: "claude-code" as const, name: "Claude Code", sessions: f.claude.length, repos: repos(f.claude, "claude"), installed: f.claude.length > 0 || has(dirname(f.roots.claude)) },
    { id: "cursor" as const, name: "Cursor", sessions: f.cursor.length, repos: repos(f.cursor, "cursor"), installed: f.cursor.length > 0 || has(dirname(f.roots.cursor)) },
    { id: "antigravity" as const, name: "Antigravity", sessions: f.antigravity.length, repos: agRepos, installed: f.antigravity.length > 0 || has(join(f.roots.antigravity, "antigravity")) },
    { id: "codex" as const, name: "Codex", sessions: f.codex.length, repos: repos(f.codex, "codex"), installed: codexInstalled || f.codex.length > 0 },
  ].filter((t) => t.installed);
}
