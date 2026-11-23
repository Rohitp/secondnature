import type { Client } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { home, isPaused } from "../config.js";
import { repoIdentity } from "../repo/identity.js";
import { modelCached } from "../embed/model.js";
import { openDb } from "../store/db.js";
import { keywordsInUse } from "../store/lessons.js";
import { EVENTS, codexPresent, installed } from "./install.js";

const ago = (iso: string, now = Date.now()) => {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  const h = Math.round(m / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} minute${m === 1 ? "" : "s"} ago` : m < 2880 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(m / 1440)} days ago`;
};
const HOOK_WORDS: Record<string, string> = { SessionStart: "session start", UserPromptSubmit: "your prompts", PostToolUseFailure: "failed commands", PostToolUse: "failed commands", SubagentStart: "subagents", Stop: "plan updates while you work", PreCompact: "plan updates before compaction", SessionEnd: "session end" };

export type Health = { state: "not-set-up" | "paused" | "waiting" | "working" | "problem"; line: string; lastCall: string | null; errors: string[] };

/**
 * Is muninn working? There's no process to check: Claude Code calls muninn at set moments.
 * So "working" means its hooks are installed and Claude Code called them recently, with no error since.
 */
export async function health(db: Client, opts: { hooks?: string[]; paused?: boolean; errorLog?: string } = {}): Promise<Health> {
  const hooks = opts.hooks ?? installed();
  const lastCall = String((await db.execute("SELECT max(ts) t FROM deliveries WHERE tool='claude-code'")).rows[0]?.t ?? "") || null;
  const log = opts.errorLog ?? join(home(), "hook-errors.log");
  // Only errors newer than the last successful call matter: older ones were followed by a working call.
  const errors = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).filter((l) => !lastCall || l.slice(0, 24) > lastCall).slice(-3) : [];
  if (!hooks.length) return { state: "not-set-up", line: "muninn isn't set up on this machine. Run: muninn setup", lastCall, errors };
  if (opts.paused ?? isPaused()) return { state: "paused", line: "muninn is paused, so your agents aren't told anything. Run: muninn resume", lastCall, errors };
  if (errors.length) return { state: "problem", line: `muninn had a problem the last time Claude Code called it (${ago(errors.at(-1)!.slice(0, 24))}). The error is below.`, lastCall, errors };
  if (!lastCall) return { state: "waiting", line: "muninn is set up, but Claude Code hasn't called it yet. Start a Claude Code session in a git repo, send a message, then check again.", lastCall, errors };
  return { state: "working", line: `muninn is working. Claude Code last called it ${ago(lastCall)}.`, lastCall, errors };
}

/**
 * `muninn status`: one line per part, each with a mark and words (✓ working, ! needs you, ✗ failed, – skipped),
 * the reason under anything that needs you, and a last line saying what to run.
 */
export async function status() {
  const { c, mark, next, pad, clock, version, plural } = await import("../term.js");
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  const meta = async (k: string) => String((await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [k] })).rows[0]?.value ?? "");
  const lastTold = async (tool: string) => String((await db.execute({ sql: "SELECT max(ts) t FROM deliveries WHERE tool=? AND outcome='sent'", args: [tool] })).rows[0]?.t ?? "") || null;
  const when = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso) < 86_400_000 && new Date(iso).getDate() === new Date().getDate() && Date.now() - Date.parse(iso) > 3_600_000 ? `at ${clock(new Date(iso))}` : ago(iso)) : "");
  const rows: { m: "ok" | "need" | "fail" | "skip"; name: string; text: string; why?: string; fix?: string }[] = [];
  const h = await health(db);

  // Claude Code: hooks installed and called.
  const hooks = installed();
  const missing = Object.keys(EVENTS["claude-code"]).filter((e) => !hooks.includes(e));
  const { leftAlone } = await import("../config.js");
  if (leftAlone("claude-code")) rows.push({ m: "skip", name: "Claude Code", text: "left alone, as you chose in setup", why: "muninn setup lets you tick it again" });
  else if (!hooks.length) rows.push({ m: "need", name: "Claude Code", text: "not connected", why: "its agents aren't told your lessons", fix: "muninn setup" });
  else if (h.state === "problem") rows.push({ m: "fail", name: "Claude Code", text: "the last call failed", why: h.errors.at(-1)?.slice(25, 160), fix: "muninn connect" });
  else if (missing.length) rows.push({ m: "need", name: "Claude Code", text: `connected, but not for ${missing.map((e) => HOOK_WORDS[e]).join(", ")}`, fix: "muninn install" });
  else { const t = await lastTold("claude-code"); rows.push({ m: "ok", name: "Claude Code", text: t ? `working · last told ${when(t)}` : "connected · not told anything yet", why: t ? undefined : "start a session in a git repo and send a message" }); }

  // Cursor and Antigravity hear lessons through rules files in each repo.
  if (repo) {
    const { rulesState } = await import("../deliver/auto-rules.js");
    const r = await rulesState(db, repo).catch(() => null);
    const root = r ? (JSON.parse(String((await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0]?.paths ?? "[]")) as string[]).find((p) => existsSync(p)) : null;
    const { readdirSync } = await import("node:fs");
    const has = (dir: string, re: RegExp) => { try { return !!root && readdirSync(join(root, dir)).some((f) => re.test(f)); } catch { return false; } };
    const short = repo.split("/").pop();
    for (const [tool, name, dir, re] of [["antigravity", "Antigravity", ".agents/rules", /^muninn/], ["cursor", "Cursor", ".cursor/rules", /^muninn.*\.mdc$/]] as const) {
      if (leftAlone(tool)) { rows.push({ m: "skip", name, text: "left alone, as you chose in setup" }); continue; }
      if (!r?.[tool].on) { rows.push({ m: "skip", name, text: `off in ${short}`, why: `muninn ${tool} on gives its agent your lessons here` }); continue; }
      if (root && !has(dir, re)) { rows.push({ m: "need", name, text: `the rules file in ${short} is missing`, why: `so ${name} isn't told your lessons`, fix: "muninn connect" }); continue; }
      const t = await lastTold(tool);
      rows.push({ m: "ok", name, text: `told by rules files in ${short}${t ? ` · last told ${when(t)}` : ""}` });
    }
  }
  if (codexPresent() && leftAlone("codex")) rows.push({ m: "skip", name: "Codex", text: "left alone, as you chose in setup" });
  else if (codexPresent()) {
    const ch = installed("codex");
    const t = await lastTold("codex");
    rows.push(!ch.length ? { m: "need", name: "Codex", text: "not connected", fix: "muninn install" } : t ? { m: "ok", name: "Codex", text: `working · last told ${when(t)}` } : { m: "skip", name: "Codex", text: "hooks added, not checked live yet", why: "Codex runs them only after you trust them in its /hooks" });
  }
  // What writes lessons: the claude (or codex) command.
  const { pickRunner } = await import("../learn/writer.js");
  const runner = pickRunner("judge");
  if (runner) {
    const { spawnSync } = await import("node:child_process");
    const v = spawnSync(runner.name, ["--version"], { encoding: "utf8", timeout: 4000 }).stdout?.trim().split(/\s/)[0];
    rows.push({ m: "ok", name: "Your Claude", text: `${runner.name}${v ? ` ${v}` : ""}, writes your lessons` });
  } else rows.push({ m: "need", name: "Your Claude", text: "couldn't find the claude command", why: "only things you said word for word more than once can become lessons", fix: "claude --version" });
  rows.push(modelCached() ? { m: "ok", name: "Model", text: "downloaded" } : { m: "need", name: "Model", text: "not downloaded yet, so sessions aren't read", fix: "muninn learn --all-repos" });
  const lastLearn = await meta("last_learn");
  rows.push(lastLearn ? { m: "ok", name: "Sessions read", text: `${ago(lastLearn)} · again on its own after you work` } : { m: "need", name: "Sessions read", text: "never", fix: "muninn learn --all-repos" });
  const { scheduleOn, scheduleSupported, EVERY_HOURS } = await import("./schedule.js");
  if (scheduleSupported()) rows.push(scheduleOn() ? { m: "ok", name: "Background check", text: `every ${EVERY_HOURS} hours` } : { m: "skip", name: "Background check", text: "off", why: "scans start only when a Claude Code or Codex session ends", fix: undefined });
  if (h.state === "paused") rows.unshift({ m: "need", name: "Paused", text: "agents aren't told anything", fix: "muninn resume" });

  // Things that need a look but aren't one part.
  for (const r of (await db.execute("SELECT tool, client_version, unknown_records FROM scan_counts WHERE unknown_records>0")).rows) rows.push({ m: "need", name: "Log format", text: `${r.unknown_records} ${r.tool} ${r.client_version} records weren't recognised`, why: "the tool may have changed how it writes logs" });
  try {
    const { claudeHasMuninn } = await import("../mcp/install.js");
    if (claudeHasMuninn() === false) rows.push({ m: "need", name: "Ask from chat", text: "Claude Code doesn't list secondnature's MCP server", why: "close running Claude Code sessions first", fix: "muninn mcp install" });
  } catch { /* status shouldn't fail on this */ }
  try {
    const { archiveDir } = await import("../store/sessions.js");
    const { readdirSync, statSync } = await import("node:fs");
    const newest = readdirSync(archiveDir(), { recursive: true }).map((f) => { try { return statSync(join(archiveDir(), String(f))).mtimeMs; } catch { return 0; } }).reduce((a, b) => Math.max(a, b), 0);
    if (!newest || Date.now() - newest > 20 * 86_400_000) rows.push({ m: "need", name: "Old sessions", text: `${newest ? "not copied for over 20 days" : "not copied yet"}`, why: "Claude Code deletes logs after 30 days", fix: "muninn learn --all-repos" });
  } catch { /* nothing archived yet is covered by Sessions read */ }

  const out = [`${c.bold(`secondnature ${version()}`)}${c.dim(` · checked at ${clock()}`)}`, ""];
  for (const r of rows) {
    out.push(`${mark[r.m]()} ${c.bold(pad(r.name, 16))}${r.m === "need" || r.m === "fail" ? (r.m === "fail" ? c.fail(r.text) : c.warn(r.text)) : r.m === "skip" ? c.dim(r.text) : r.text}`);
    if (r.why) out.push(c.dim(`${" ".repeat(19)}${r.why}`));
  }
  if (repo) {
    const live = Number((await db.execute({ sql: "SELECT count(*) n FROM lessons WHERE status='live' AND off=0 AND (repo_id IS ? OR repo_id=? OR scope='global')", args: [repo, repo] })).rows[0]?.n ?? 0);
    const waiting = Number((await db.execute({ sql: "SELECT count(*) n FROM lessons WHERE status='proposed' AND (repo_id IS ? OR repo_id=?)", args: [repo, repo] })).rows[0]?.n ?? 0);
    out.push("", `In ${repo.split("/").pop()}: agents are told ${plural(live, "lesson")}${waiting ? `, and ${waiting} wait for you` : ""}.`);
  }
  const needs = rows.filter((r) => r.m === "need" || r.m === "fail");
  out.push("");
  if (!needs.length) out.push(`${mark.ok()} Everything is working.`);
  else { const fix = needs.find((r) => r.fix)?.fix; out.push(`${c.warn(`${plural(needs.length, "thing")} ${needs.length === 1 ? "needs" : "need"} you.`)}${fix ? ` ${next(fix)}` : ""}`); }
  console.log(out.join("\n"));
}
export async function keywords() {
  const db = await openDb();
  const kw = await keywordsInUse(db, repoIdentity(process.cwd()));
  if (!kw.length) { console.log("No keywords yet."); return; }
  for (const k of kw) console.log(`${k.pattern.padEnd(24)} ${k.lessons} lesson(s)`);
}
