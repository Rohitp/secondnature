import { spawn } from "node:child_process";
import { closeSync, existsSync, globSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, isPaused, logRoots, settings } from "../config.js";

const stampFile = () => join(ensureHome(), "last-auto.json");
const lockFile = () => join(ensureHome(), "auto.lock");

export function countLogs(): number {
  const r = logRoots();
  return globSync("*/*.jsonl", { cwd: r.claude }).length + globSync("**/rollout-*.jsonl", { cwd: r.codex }).length + globSync("*/agent-transcripts/**/*.jsonl", { cwd: r.cursor }).length
    + globSync("{antigravity,antigravity-ide,antigravity-cli}/brain/*/.system_generated/logs/transcript.jsonl", { cwd: r.antigravity }).length;
}
/** Whether a scan is due: at most once a day, or after enough new sessions. */
export function scanDue(now = Date.now()): boolean {
  const cfg = settings();
  if (!cfg.autoLearn || isPaused() || process.env.MUNINN_INTERNAL) return false;
  if (!existsSync(stampFile())) return true;
  const { at, logs } = JSON.parse(readFileSync(stampFile(), "utf8"));
  return now - at >= cfg.autoMinHours * 3_600_000 || countLogs() - logs >= cfg.autoMinNewSessions;
}
/** Whether a long, still-running session should start a scan: lessons shouldn't wait for a session that may last days. */
export function longScanDue(transcriptBytes: number, now = Date.now()): boolean {
  const cfg = settings();
  if (!cfg.autoLearn || isPaused() || process.env.MUNINN_INTERNAL || transcriptBytes < cfg.longSessionBytes) return false;
  if (!existsSync(stampFile())) return true;
  const { at } = JSON.parse(readFileSync(stampFile(), "utf8"));
  return now - at >= cfg.autoLongSessionHours * 3_600_000;
}
export function takeLock(now = Date.now()): boolean {
  const f = lockFile();
  if (existsSync(f) && now - statSync(f).mtimeMs < 3_600_000) return false;
  rmSync(f, { force: true });
  try { closeSync(openSync(f, "wx")); return true; } catch { return false; }
}
export const releaseLock = () => rmSync(lockFile(), { force: true });
export const stamp = (now = Date.now()) => writeFileSync(stampFile(), JSON.stringify({ at: now, logs: countLogs() }));

/**
 * Starts a scan in a separate process and returns at once. Called from the SessionEnd hook (only when one is due),
 * and from the page's "Check now" (force: right away).
 */
export function startAutoScan(opts: { force?: boolean } = {}): boolean {
  if (!opts.force && !scanDue()) return false;
  if (scanRunning()) return false;
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const child = spawn(process.execPath, [cli, "learn", "--auto", "--all-repos", ...(opts.force ? ["--force"] : [])], { detached: true, stdio: "ignore", env: { ...process.env, MUNINN_INTERNAL: "" } });
  child.unref();
  return true;
}
/** Whether a scan is running now: its lock is held and recent. */
export const scanRunning = (now = Date.now()) => existsSync(lockFile()) && now - statSync(lockFile()).mtimeMs < 3_600_000;

/** Called from the SessionEnd hook: writes a handoff for that session in a separate process. */
export function startHandoff(transcript: string, client: string) {
  if (isPaused() || process.env.MUNINN_INTERNAL) return;
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const child = spawn(process.execPath, [cli, "handoff", "--transcript", transcript, "--client", client], { detached: true, stdio: "ignore", env: { ...process.env, MUNINN_INTERNAL: "" } });
  child.unref();
}

/** Called from the Stop and PreCompact hooks: updates the branch's plan from the new part of the session, in a separate process. */
export function startCheckpoint(transcript: string, client: string) {
  if (isPaused() || process.env.MUNINN_INTERNAL) return;
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const child = spawn(process.execPath, [cli, "checkpoint", "--transcript", transcript, "--client", client], { detached: true, stdio: "ignore", env: { ...process.env, MUNINN_INTERNAL: "" } });
  child.unref();
}

/** Called when an agent says with plan_note that a step is done: folds the notes into the plan, in a separate process. */
export function startNotesFold(repo: string, branch: string) {
  if (isPaused() || process.env.MUNINN_INTERNAL) return;
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const child = spawn(process.execPath, [cli, "plan", "notes", "--repo", repo, "--branch", branch], { detached: true, stdio: "ignore", env: { ...process.env, MUNINN_INTERNAL: "" } });
  child.unref();
}
