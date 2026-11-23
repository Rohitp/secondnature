import type { Client } from "@libsql/client";
import { execFileSync, spawn } from "node:child_process";
import { userInfo } from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { askData, originOf, shortRepo } from "../commands/ask.js";
import { askInThread, deleteThread, getThread, listThreads } from "../commands/answer.js";
import { logFile, withLinks } from "../commands/source-links.js";
import { homeData } from "../commands/home.js";
import { adoptRepo } from "../repo/adopt.js";
import { addItem, editItem, setPlanStatus, getPlan, planBranches, planFileOn, setPlanFile, setStatus, writePlanFile } from "../plan/plan.js";
import { currentBranch } from "../handoff/handoff.js";
import { scanRunning, startAutoScan } from "../commands/auto.js";
import { getDial, recordFeedback, setDial } from "../store/dial.js";
import { loadEmbedder, modelCached, type Embed } from "../embed/model.js";
import { fillExplanations } from "../learn/explain.js";
import { replay } from "../learn/replay.js";
import { keepLine, openFlags, removeLine, restoreLine, rootOf } from "../memory/stale.js";
import { pickRunner, saveUsage } from "../learn/writer.js";
import { reportData } from "../commands/report.js";
import { defaultRoute, isPreference, similar, suggestKeyword, usefulKeyword, worthSentence } from "../commands/review.js";
import { settings } from "../config.js";
import { syncCursor } from "../deliver/cursor.js";
import { lessonFileMode, setLessonFile } from "../deliver/local-file.js";
import { apply, dismiss, listProposals, proposeInstructions, undo } from "../propose/index.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";
import { combine, decide, ensureRepo, getLesson, keywordsInUse, listLessons } from "../store/lessons.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read on every request, so an edited page shows on the next load without a restart.
const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "public", "index.html");
const page = () => readFileSync(PAGE_PATH, "utf8");
// Changes whenever this process starts, so an open tab can tell the server restarted with new code.
const BOOT = randomBytes(6).toString("hex");
const pageHash = () => createHash("sha1").update(page()).digest("hex").slice(0, 12);

type Handler = (db: Client, q: URLSearchParams, body: any) => Promise<unknown>;
/** Where the page's first-run setup is: connecting tools, downloading the model, reading sessions, done or failed. */
const firstRun: { stage: "idle" | "connecting" | "model" | "reading" | "done" | "error"; error: string | null } = { stage: "idle", error: null };
let embedder: Promise<Embed> | null = null;
const embed = () => (embedder ??= modelCached() ? loadEmbedder() : Promise.reject(new Error("The search model isn't downloaded yet. Run muninn learn once.")));

async function lessonDetail(db: Client, id: string) {
  const l = await getLesson(db, id);
  if (!l) return null;
  const evidence = (await db.execute({ sql: "SELECT tool,session,seen_at,quote FROM evidence WHERE lesson_id=? ORDER BY seen_at DESC LIMIT 20", args: [l.id] })).rows;
  const triggers = (await db.execute({ sql: "SELECT pattern FROM triggers WHERE lesson_id=?", args: [l.id] })).rows.map((r) => String(r.pattern));
  const sim = l.status === "proposed" ? await similar(db, l) : null;
  const fromWriter = l.suggested_keywords ? (JSON.parse(l.suggested_keywords) as string[]).filter(usefulKeyword) : [];
  const suggested = fromWriter.length ? fromWriter : [suggestKeyword(l.text)].filter(Boolean);
  const origin = await originOf(db, { id: l.id, source: l.source, signal: l.signal });
  // Files or folders the lesson names that are no longer in the repo: the lesson may be out of date.
  const missing = (await db.execute({ sql: "SELECT dst_id FROM links WHERE src_id=? AND rel='applies_to' AND how='missing'", args: [l.id] }).catch(() => ({ rows: [] }))).rows.map((r) => String(r.dst_id));
  return { ...l, missing, worth: worthSentence(l as any, defaultRoute(l).route), preference: isPreference(l), defaults: defaultRoute(l), repo_short: shortRepo(l.repo_id), origin, evidence, triggers, suggested, similar: sim ? { id: sim.lesson.id, text: sim.lesson.text, plain: sim.lesson.plain, status: sim.lesson.status, score: sim.score } : null };
}

/** A branch's plan for the page, defaulting to the branch checked out in the repo's folder, plus the other branches with plans. */
function whoAmI(): string {
  try { const n = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (n) return n.split(/\s+/)[0]!; } catch { /* no git name */ }
  try { return userInfo().username; } catch { return ""; }
}
async function planView(db: Client, repo: string, branch: string | null) {
  const row = (await db.execute({ sql: "SELECT paths FROM repos WHERE id=?", args: [repo] })).rows[0];
  const root = row ? ((JSON.parse(String(row.paths)) as string[]).find((p) => existsSync(p)) ?? null) : null;
  const checkedOut = root ? currentBranch(root) : null;
  const b = branch || checkedOut || "main";
  const branches = await planBranches(db, repo, root);
  if (!branches.some((x) => x.name === b)) branches.unshift({ name: b, open: 0, merged: false });
  const { getHistory } = await import("../plan/history.js");
  return { branch: b, checkedOut, branches, plan: await getPlan(db, repo, b), history: await getHistory(db, repo, b), fileOn: await planFileOn(db, repo) };
}

const routes: Record<string, Handler> = {
  "GET /api/repos": async (db) => (await db.execute("SELECT r.id, (SELECT count(*) FROM lessons l WHERE l.repo_id=r.id AND l.status='proposed') waiting, (SELECT count(*) FROM lessons l WHERE l.repo_id=r.id AND l.status='live') live FROM repos r ORDER BY live+waiting DESC, r.id")).rows,
  "GET /api/lessons": async (db, q) => {
    const repo = q.get("repo") || null; const status = q.get("status") || "proposed";
    // Kept lessons for every repo are told here too, wherever they were learned, so they're listed here.
    const rows = await listLessons(db, { repo, status, withAllRepos: status === "live" });
    const out = [];
    for (const l of rows.slice(0, 200)) out.push(await lessonDetail(db, l.id));
    return out;
  },
  "GET /api/keywords": async (db, q) => keywordsInUse(db, q.get("repo") || null),
  "POST /api/decide": async (db, _q, b) => {
    const id = String(b.id ?? "");
    if (!(await getLesson(db, id))) throw new Error("No lesson with that id.");
    if (b.action === "reject") await decide(db, id, { status: "rejected" });
    else if (b.action === "retire") await decide(db, id, { status: "retired" });
    else if (b.action === "keep" || b.action === "save") {
      const keywords = String(b.keywords ?? "").toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
      const route = String(b.route ?? "none");
      await decide(db, id, {
        ...(b.action === "keep" ? { status: "live" as const } : {}),
        ...(typeof b.text === "string" && b.text.trim() ? { text: b.text.trim() } : {}),
        ...(typeof b.news === "boolean" ? { news: b.news } : {}),
        ...(typeof b.global === "boolean" ? { global: b.global } : {}),
        // Which role hears it: a role name, or "" for every agent.
        ...(typeof b.role === "string" ? { role: b.role } : {}),
        alwaysOn: route === "always",
        triggers: route === "keyword" ? keywords : [],
      });
      // "Applies to" another repo: the lesson was learned in one repo but is about another, so move it there.
      if (typeof b.repo === "string" && b.repo && !b.global) {
        await db.execute({ sql: "INSERT OR IGNORE INTO repos (id,paths) VALUES (?,'[]')", args: [b.repo] });
        await db.execute({ sql: "UPDATE lessons SET repo_id=? WHERE id=?", args: [b.repo, id] });
      }
    } else if (b.action === "combine") {
      await combine(db, id, String(b.other ?? ""), typeof b.text === "string" && b.text.trim() ? b.text.trim() : undefined);
      await decide(db, id, { status: "live", alwaysOn: b.route === "always", triggers: b.route === "keyword" ? String(b.keywords ?? "").toLowerCase().split(",").map((k: string) => k.trim()).filter(Boolean) : [] });
    } else if (b.action === "on" || b.action === "off") {
      // The switch: off keeps the lesson but stops agents being told it.
      await decide(db, id, { off: b.action === "off" });
    } else throw new Error("Unknown action.");
    await syncCursor(db);
    // New text needs a new plain line and questions. Written in the background, so the page doesn't wait.
    const fresh = await getLesson(db, id);
    const runner = pickRunner("background");
    if (fresh && !fresh.plain && runner && ["live", "proposed"].includes(fresh.status)) void embed().then((e) => fillExplanations(db, runner, e, { ids: [id], async: true })).then(() => saveUsage(db, runner, "plain lines")).catch(() => { /* filled on the next learn */ });
    return lessonDetail(db, id);
  },
  "GET /api/report": async (db, q) => reportData(db, q.get("repo") || null),
  "GET /api/home": async (db, q) => homeData(db, q.get("repo") || null),
  // The running plan: read it, change it, and the PLAN.md switch. Changes refresh PLAN.md (if on) and Cursor's rules.
  // "When would this have been told?": trigger words tried against past sessions in the repo.
  "POST /api/replay": async (_db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("This lesson isn't tied to a repo, so there are no sessions to try it on.");
    const route = b.route === "always" || b.route === "none" ? b.route : "keyword";
    return replay(repo, route, String(b.words ?? "").split(","));
  },
  // Lines in CLAUDE.md (and similar files) that may be out of date: remove, put back, or keep.
  "GET /api/memory": async (db, q) => (await openFlags(db, q.get("repo") || null)).map((r) => ({ id: r.id, repo_id: r.repo_id, file: r.file, line: r.line, text: r.text, reason: r.reason, detail: r.detail, status: r.status })),
  "POST /api/memory": async (db, _q, b) => {
    const id = String(b.id ?? ""); const row = (await openFlags(db, null)).find((r) => r.id === id);
    if (!row) throw new Error("That line isn't flagged any more.");
    if (b.action === "keep") { await keepLine(db, id); return { ok: true }; }
    const root = await rootOf(db, row.repo_id);
    if (!root) throw new Error("Couldn't find this repo's folder.");
    const ok = b.action === "remove" ? await removeLine(db, id, root) : b.action === "restore" ? await restoreLine(db, id, root) : (() => { throw new Error("Unknown action."); })();
    if (!ok) throw new Error(b.action === "remove" ? `The line changed in ${row.file} since muninn checked it, so it was left alone.` : "Couldn't put the line back.");
    return { ok: true };
  },
  "GET /api/plan": async (db, q) => {
    const repo = q.get("repo"); if (!repo) throw new Error("Pick a repo to see its plan.");
    return planView(db, repo, q.get("branch"));
  },
  "POST /api/plan": async (db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("Pick a repo first.");
    const branch = String(b.branch ?? "") || (await planView(db, repo, null)).branch;
    if (b.action === "add") await addItem(db, repo, branch, b.kind === "goal" ? "goal" : "open", String(b.text ?? ""), { person: true });
    else if (b.action === "status") await setPlanStatus(db, repo, branch, String(b.text ?? ""), true);
    else if (b.action === "edit") await editItem(db, String(b.id), String(b.text ?? ""));
    else if (b.action === "close") await setStatus(db, String(b.id), "closed", "person");
    else if (b.action === "reopen") await setStatus(db, String(b.id), "active", "person");
    else if (b.action === "remove") await setStatus(db, String(b.id), "removed", "person");
    else throw new Error("Unknown action.");
    await writePlanFile(db, repo); await syncCursor(db);
    return planView(db, repo, branch);
  },
  "POST /api/plan-file": async (db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("Pick a repo first.");
    await setPlanFile(db, repo, !!b.on);
    return { fileOn: await planFileOn(db, repo) };
  },
  "GET /api/insights": async (db, q) => { const { insightsData, insightsText } = await import("../commands/insights.js"); return { text: insightsText(await insightsData(db, q.get("repo") || null, Number(q.get("days")) || 7)) }; },
  "GET /api/recall": async (db, q) => (await import("../commands/recall.js")).recallData(db, q.get("q") ?? "", q.get("repo") || null, { embed: await embed().catch(() => undefined), limit: 8 }),
  "POST /api/link": async (db, _q, b) => {
    const { setLink } = await import("../links/links.js");
    await setLink(db, ["decision", String(b.decision ?? "")], "motivates", ["outcome", String(b.outcome ?? "")], b.action === "add");
    return { ok: true };
  },
  "GET /api/proposals": async (db, q) => {
    const repo = q.get("repo") || null;
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    return { waiting: await listProposals(db, repo, "proposed"), applied: (await listProposals(db, repo, "applied")).filter((p) => (p.decided_at ?? "") >= since).slice(0, 5) };
  },
  "POST /api/proposals": async (db, _q, b) => {
    const id = String(b.id ?? "");
    if (b.action === "apply") return apply(db, id);
    if (b.action === "dismiss") { await dismiss(db, id); return { ok: true }; }
    if (b.action === "undo") { await undo(db, id); return { ok: true }; }
    throw new Error("Unknown action.");
  },
  "POST /api/propose": async (db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("Pick a repo first.");
    const runner = pickRunner("judge");
    if (!runner) throw new Error("This needs the claude (or codex) command, which muninn couldn't find.");
    const r = await proposeInstructions(db, repo, runner);
    await saveUsage(db, runner, "instruction review");
    return r;
  },
  "GET /api/lesson-file": async (db, q) => { const repo = q.get("repo"); if (!repo) throw new Error("Pick a repo first."); return { mode: await lessonFileMode(db, repo) }; },
  "POST /api/lesson-file": async (db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("Pick a repo first.");
    const r = await setLessonFile(db, repo, b.mode === "local" ? "local" : "off");
    return { mode: await lessonFileMode(db, repo), written: !!r };
  },
  "GET /api/queries": async (db, q) => {
    const { listQueries, lessonFinds } = await import("../store/queries.js");
    const days = Number(q.get("days") || 7);
    const queries = await listQueries(db, { repo: q.get("repo") || null, days });
    // The text of each lesson a question found, so an opened question shows it, whichever repo the lesson is kept in.
    const ids = [...new Set(queries.flatMap((x) => x.result_ids).filter((r) => r.kind === "lesson" || r.kind === "note").map((r) => r.id))].slice(0, 400);
    const lessonText: Record<string, string> = {};
    if (ids.length) for (const r of (await db.execute({ sql: `SELECT id, text FROM lessons WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids })).rows) lessonText[String(r.id)] = String(r.text);
    return { queries, lessonText, lessonFinds: await lessonFinds(db, { days: Number(q.get("findsDays") || 3650) }) };
  },
  "GET /api/told": async (db, q) => (await import("../commands/told.js")).toldData(db, q.get("repo") || null, Number(q.get("days") || 7)),
  "GET /api/role-effects": async (db, q) => (await import("../workflow/effect.js")).roleEffects(db, q.get("repo") || null),
  "GET /api/runs": async (db, q) => (await import("../workflow/runs.js")).listRuns(db, { repo: q.get("repo") || null, teamOnly: q.get("all") !== "1", limit: Number(q.get("limit") || 30) }),
  "GET /api/rules": async (db, q) => { const repo = q.get("repo"); if (!repo) throw new Error("Pick a repo first."); return (await import("../deliver/auto-rules.js")).rulesState(db, repo); },
  "POST /api/rules": async (db, _q, b) => {
    const repo = String(b.repo ?? ""); if (!repo) throw new Error("Pick a repo first.");
    if (b.tool !== "cursor" && b.tool !== "antigravity") throw new Error("Rules are for cursor or antigravity.");
    const m = await import("../deliver/auto-rules.js");
    await m.setRules(db, repo, b.tool, !!b.on);
    return m.rulesState(db, repo);
  },
  "POST /api/dial": async (db, _q, b) => { await setDial(db, b.repo || null, b.dial); return { dial: await getDial(db, b.repo || null) }; },
  "POST /api/feedback": async (db, _q, b) => {
    if (b.verdict !== "helped" && b.verdict !== "wrong") throw new Error("Feedback is helped or wrong.");
    await recordFeedback(db, { lessonId: b.kind === "handoff" ? null : String(b.id), handoffId: b.kind === "handoff" ? String(b.id) : null, session: b.session ?? null, verdict: b.verdict });
    return { ok: true };
  },
  "GET /api/handoffs": async (db, q) => {
    const repo = q.get("repo");
    return (await db.execute({ sql: `SELECT id,repo_id,branch,tool,created_at,text FROM handoffs ${repo ? "WHERE repo_id=?" : ""} ORDER BY created_at DESC LIMIT 30`, args: repo ? [repo] : [] })).rows;
  },
  "GET /api/ask": async (db, q) => askData(db, q.get("q") ?? "", q.get("repo") || null, { includeWaiting: true, embed: await embed().catch(() => undefined) }),
  "POST /api/answer": async (db, _q, b) => {
    const runner = pickRunner("background");
    if (!runner) throw new Error("No Claude Code found to write an answer.");
    try { const r = await askInThread(db, String(b.q ?? ""), b.repo || null, runner, await embed(), b.thread ? String(b.thread) : null); return { ...r.answer, sources: await withLinks(db, r.answer.sources), thread: r.thread }; }
    finally { await saveUsage(db, runner, "answer"); }
  },
  // Opens a past session's log in Finder (or the file manager), so a source can be checked at its origin.
  "POST /api/reveal": async (db, _q, b) => {
    const f = await logFile(db, String(b.session ?? ""));
    if (!f) throw new Error("That session's log isn't on this machine any more.");
    if (process.platform === "darwin") spawn("open", ["-R", f], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "linux") spawn("xdg-open", [dirname(f)], { stdio: "ignore", detached: true }).unref();
    else throw new Error(`The log is at ${f}`);
    return { file: f };
  },
  "GET /api/ask-suggestions": async (db, q) => (await import("../commands/suggestions.js")).getSuggestions(db, q.get("repo") || null),
  "GET /api/threads": async (db, q) => listThreads(db, q.get("repo") || null),
  "GET /api/thread": async (db, q) => {
    const t = await getThread(db, q.get("id") ?? ""); if (!t) throw new Error("That thread is gone.");
    return { ...t, turns: await Promise.all(t.turns.map(async (u) => ({ ...u, sources: await withLinks(db, u.sources) }))) };
  },
  "POST /api/thread-delete": async (db, _q, b) => { await deleteThread(db, String(b.id ?? "")); return { ok: true }; },
  // "Is it helping?": each kept lesson's outcome, output trims, and repeated problems by day for the chart.
  "GET /api/impact": async (db, q) => {
    const repo = q.get("repo") || null;
    const { proofData, headline, PROOF_MIN_SESSIONS } = await import("../learn/proof.js");
    const proof = await proofData(db, repo, (await import("../logs/discover.js")).scanLogs().sessions);
    const DAYS = 14; const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
    const inRepo = repo ? "AND (l.repo_id=? OR l.scope='global')" : "";
    const args = repo ? [since, repo] : [since];
    // Sessions a problem turned up in, per day: problems a kept lesson covers, and the rest.
    const ev = (await db.execute({ sql: `SELECT substr(e.seen_at,1,10) day, l.status='live' kept, count(DISTINCT e.session||e.lesson_id) n FROM evidence e JOIN lessons l ON l.id=e.lesson_id WHERE substr(e.seen_at,1,10)>=? ${inRepo} AND l.status IN ('live','proposed','retired') GROUP BY 1,2`, args })).rows;
    const keptOn = (await db.execute({ sql: `SELECT substr(coalesce(l.reviewed_at,l.created_at),1,10) day, count(*) n FROM lessons l WHERE l.status='live' AND substr(coalesce(l.reviewed_at,l.created_at),1,10)>=? ${inRepo} GROUP BY 1`, args })).rows;
    const days = [...Array(DAYS)].map((_, i) => new Date(Date.now() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10)).map((day) => ({
      day,
      covered: Number(ev.find((r) => r.day === day && Number(r.kept))?.n ?? 0),
      other: Number(ev.find((r) => r.day === day && !Number(r.kept))?.n ?? 0),
      kept: Number(keptOn.find((r) => r.day === day)?.n ?? 0),
    }));
    return { headline: headline(proof), minSessions: PROOF_MIN_SESSIONS, counts: proof.counts, lessons: proof.lessons.map(({ id, text, keptAt, before, after, sent, sessionsSince, outcome, verdict, stale, fix }) => ({ id, text, keptAt, before, after, sent, sessionsSince, outcome, verdict, stale, fix })), fixes: proof.report.fixes, days };
  },
  // "Make a page to send someone": the same one-page report as muninn report --page, shown in Finder.
  "POST /api/proof-page": async (db, _q, b) => {
    const repo = typeof b.repo === "string" && b.repo ? b.repo : null;
    const { proofData, proofHtml } = await import("../learn/proof.js");
    const { home } = await import("../config.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const proof = await proofData(db, repo, (await import("../logs/discover.js")).scanLogs().sessions);
    // In Downloads, where a page to send someone is easy to find; muninn's own folder if there's no Downloads.
    const { homedir } = await import("node:os"); const { existsSync } = await import("node:fs");
    const dl = join(homedir(), "Downloads");
    const file = join(existsSync(dl) ? dl : join(home(), "reports"), `secondnature-report-${repo ? `${repo.split("/").pop()}-` : ""}${proof.at.slice(0, 10)}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, proofHtml(proof));
    if (process.platform === "darwin") spawn("open", ["-R", file], { stdio: "ignore", detached: true }).unref();
    return { file };
  },
  // First run: what's on this Mac, then connect, download the model and read every repo, then the top finds.
  "GET /api/firstrun": async (db) => {
    const { logFiles, reposInLogs } = await import("../logs/discover.js");
    const { installed, codexPresent } = await import("../commands/install.js");
    const f = logFiles(); const repos = reposInLogs();
    const tools = [
      { id: "claude-code", name: "Claude Code", logs: f.claude.length, how: "Told by hooks: at session start, on your prompt, when a command fails" },
      { id: "cursor", name: "Cursor", logs: f.cursor.length, how: "Told by rules files in each repo where you use it, kept out of git" },
      { id: "antigravity", name: "Antigravity", logs: f.antigravity.length, how: "Told by rules and hooks, per agent role" },
      { id: "codex", name: "Codex", logs: f.codex.length, how: "Told by hooks", present: codexPresent() },
    ].filter((t) => t.logs > 0 || t.present || t.id === "claude-code");
    const n = (sql: string) => db.execute(sql).then((r) => Number(r.rows[0]?.n ?? 0));
    return {
      tools, repos: repos.size, hooked: installed("claude-code").length > 0, model: modelCached(), writer: !!pickRunner("judge"),
      stage: firstRun.stage, error: firstRun.error, scanning: scanRunning(),
      lastLearn: String((await db.execute("SELECT value FROM meta WHERE key='last_learn'")).rows[0]?.value ?? "") || null,
      found: await n("SELECT count(*) n FROM lessons WHERE status='proposed'"), kept: await n("SELECT count(*) n FROM lessons WHERE status='live'"),
      foundRepos: await n("SELECT count(DISTINCT repo_id) n FROM lessons WHERE status='proposed'"),
    };
  },
  "POST /api/firstrun": async () => {
    if (firstRun.stage === "connecting" || firstRun.stage === "model" || firstRun.stage === "reading") return { stage: firstRun.stage };
    Object.assign(firstRun, { stage: "connecting", error: null });
    // Runs on after the request returns; the page polls GET /api/firstrun for the stage.
    void (async () => {
      try {
        const { connectEverything } = await import("../commands/connect.js");
        await connectEverything();
        if (!modelCached()) { firstRun.stage = "model"; embedder = null; await loadEmbedder(); }
        firstRun.stage = "reading";
        startAutoScan({ force: true });
        // The scan runs in its own process: wait for its lock to clear (it can take a few minutes).
        await new Promise((r) => setTimeout(r, 3000));
        while (scanRunning()) await new Promise((r) => setTimeout(r, 3000));
        firstRun.stage = "done";
      } catch (e) { Object.assign(firstRun, { stage: "error", error: e instanceof Error ? e.message : String(e) }); }
    })();
    return { stage: firstRun.stage };
  },
  // Which coding tools are set up to be told, for Home's "Connected tools".
  "GET /api/tools": async (db, q) => {
    const { installed, codexPresent } = await import("../commands/install.js");
    const repo = q.get("repo");
    const rules = repo ? await (await import("../deliver/auto-rules.js")).rulesState(db, repo).catch(() => null) : null;
    const out: { id: string; name: string; on: boolean; state: string; missing?: boolean }[] = [];
    const cc = installed("claude-code").length > 0;
    out.push({ id: "claude-code", name: "Claude Code", on: cc, state: cc ? "Told by hooks" : "Not set up. Run muninn setup" });
    if (rules && repo) {
      const { rulesMissing } = await import("../deliver/auto-rules.js");
      for (const [id, name, how] of [["cursor", "Cursor", "Told by rules files"], ["antigravity", "Antigravity", "Told by rules and hooks"]] as const) {
        const missing = rules[id].on && (await rulesMissing(db, repo, id).catch(() => false));
        out.push({ id, name, on: rules[id].on && !missing, missing, state: missing ? "Rules file missing" : rules[id].on ? how : "Off in this repo" });
      }
    }
    if (codexPresent()) { const on = installed("codex").length > 0; out.push({ id: "codex", name: "Codex", on, state: on ? "Told by hooks" : "Not set up. Run muninn setup" }); }
    return out;
  },
  // Your name for the sidebar: git's user.name, else your login on this Mac.
  "GET /api/settings": async () => ({ maxPerDelivery: settings().maxPerDelivery, who: whoAmI() }),
  "GET /api/version": async () => ({ boot: BOOT, page: pageHash() }),
  // Scans: when the last one finished, whether one is running, and "Check now".
  "GET /api/scan": async (db) => ({ running: scanRunning(), needsModel: !modelCached(), lastLearn: String((await db.execute("SELECT value FROM meta WHERE key='last_learn'")).rows[0]?.value ?? "") || null }),
  "POST /api/scan": async () => ({ started: startAutoScan({ force: true }), running: true }),
  // What a run of autonomous work shows: kept findings for runs the page lists, or one call to your Claude for a run.
  "POST /api/run-findings": async (db, _q, b) => {
    const m = await import("../commands/run-findings.js");
    if (b.action === "find") {
      const run = b.run as import("../commands/run-findings.js").Run;
      if (!run?.id || !Array.isArray(run.sessions) || !Array.isArray(run.handoffs)) throw new Error("That run is missing its sessions.");
      const runner = pickRunner("judge"); if (!runner) throw new Error("Finding what a run shows needs Claude Code or Codex on this machine.");
      try { return await m.findRunFindings(db, run, runner); } finally { await saveUsage(db, runner, "run findings"); }
    }
    // The runs the page shows: their numbers, and findings kept from an earlier look.
    const runs = (Array.isArray(b.runs) ? b.runs : []).filter((r: { sessions?: unknown; handoffs?: unknown }) => Array.isArray(r?.sessions) && Array.isArray(r?.handoffs)) as import("../commands/run-findings.js").Run[];
    const saved = await m.savedFindings(db, runs);
    return Object.fromEntries(runs.map((r) => [r.id, { numbers: m.runNumbers(r), findings: saved[r.id] ?? null }]));
  },
  "GET /api/schedule": async () => { const m = await import("../commands/schedule.js"); return { supported: m.scheduleSupported(), on: m.scheduleOn(), everyHours: m.EVERY_HOURS }; },
  "POST /api/schedule": async (_db, _q, b) => { const m = await import("../commands/schedule.js"); m.setSchedule(!!b.on); return { supported: true, on: m.scheduleOn(), everyHours: m.EVERY_HOURS }; },
};

const readBody = (req: IncomingMessage) => new Promise<string>((ok, fail) => {
  let s = ""; req.setEncoding("utf8");
  req.on("data", (c) => { s += c; if (s.length > 1e6) { fail(new Error("Body too large")); req.destroy(); } });
  req.on("end", () => ok(s)); req.on("error", fail);
});
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * A local page for reviewing and editing lessons. Listens on 127.0.0.1 only, and every request needs
 * a random token from the URL muninn prints, so other web pages in the browser can't call it.
 */
/** A free local port: the one asked for if it's free, else any. */
function freePort(want: number): Promise<number> {
  return new Promise((ok) => {
    const probe = createServer();
    probe.once("error", () => { const any = createServer(); any.listen(0, "127.0.0.1", () => { const a = any.address(); any.close(() => ok(typeof a === "object" && a ? a.port : 0)); }); });
    probe.listen(want, "127.0.0.1", () => probe.close(() => ok(want)));
  });
}
const openLink = (link: string) => {
  if (process.platform === "darwin") spawn("open", [link], { stdio: "ignore", detached: true }).unref();
  else if (process.platform === "linux") spawn("xdg-open", [link], { stdio: "ignore", detached: true }).unref();
};

/**
 * Runs the page server under Node's watcher, so it restarts by itself when muninn's code is rebuilt.
 * The token and port are fixed for the whole run, so an open tab keeps working across restarts and reloads itself.
 */
export async function serve(args: string[]) {
  const portArg = args.indexOf("--port");
  const want = portArg >= 0 ? Number(args[portArg + 1]) : 4747;
  if (process.env.MUNINN_UI_CHILD || args.includes("--no-watch")) return serveNow(args, want);
  const token = randomBytes(18).toString("base64url");
  const port = await freePort(want);
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = join(dist, "cli.js");
  const child = spawn(process.execPath, ["--watch-path", dist, "--watch-preserve-output", cli, "ui", ...args.filter((a) => a !== "--detach")], {
    stdio: "inherit", env: { ...process.env, MUNINN_UI_CHILD: "1", MUNINN_UI_TOKEN: token, MUNINN_UI_PORT: String(port) },
  });
  const link = `http://127.0.0.1:${port}/?t=${token}`;
  if (!args.includes("--no-open")) {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    openLink(link);
  }
  await new Promise<void>((done) => child.on("exit", () => done()));
}

async function serveNow(args: string[], want: number) {
  const db = await openDb();
  const token = process.env.MUNINN_UI_TOKEN || randomBytes(18).toString("base64url");
  const here = repoIdentity(process.cwd());
  await adoptRepo(db, here, process.cwd());
  // List every repo you have sessions in, straight from the logs, so the picker doesn't wait for a scan.
  const listReposFromLogs = async () => {
    try { const { reposInLogs } = await import("../logs/discover.js"); for (const [id, dir] of reposInLogs()) await ensureRepo(db, id, dir); }
    catch { /* the picker still has what muninn already knew */ }
  };
  await listReposFromLogs();
  setInterval(listReposFromLogs, 10 * 60_000).unref();
  const port = process.env.MUNINN_UI_PORT ? Number(process.env.MUNINN_UI_PORT) : want;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(type === "application/json" ? JSON.stringify(body) : String(body));
    };
    if (req.headers.host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host)) return send(403, { error: "Wrong host." });
    if (req.method === "GET" && url.pathname === "/") {
      if (!same(url.searchParams.get("t") ?? "", token)) return send(403, "Open the link muninn printed in the terminal.", "text/plain");
      return send(200, page().replace("__TOKEN__", token).replace("__REPO__", JSON.stringify(here)), "text/html; charset=utf-8");
    }
    if (!same(String(req.headers["x-muninn-token"] ?? ""), token)) return send(403, { error: "Missing token." });
    // The answer as it happens: one JSON line per stage (searching, what was found, writing), then the answer.
    if (req.method === "POST" && url.pathname === "/api/answer-stream") {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
      const runner = pickRunner("background");
      try {
        if (!runner) throw new Error("No Claude Code found to write an answer.");
        const b = JSON.parse((await readBody(req)) || "{}");
        const r = await askInThread(db, String(b.q ?? ""), b.repo || null, runner, await embed(), b.thread ? String(b.thread) : null, line);
        line({ stage: "done", ...r.answer, sources: await withLinks(db, r.answer.sources), thread: r.thread });
      } catch (e) { line({ stage: "error", error: e instanceof Error ? e.message : String(e) }); }
      finally { if (runner) await saveUsage(db, runner, "answer").catch(() => {}); res.end(); }
      return;
    }
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return send(404, { error: "Not found." });
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      send(200, await h(db, url.searchParams, body));
    } catch (e) { send(400, { error: e instanceof Error ? e.message : String(e) }); }
  });
  await new Promise<void>((ok) => {
    server.once("error", () => { server.listen(0, "127.0.0.1", ok); });
    server.listen(port, "127.0.0.1", ok);
  });
  const addr = server.address();
  const link = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}/?t=${token}`;
  console.log(`muninn is open at ${link}\nIt updates by itself when muninn changes. Press Ctrl+C to stop.`);
  // Under the watcher the parent opens the browser once; on its own, open it here.
  if (!process.env.MUNINN_UI_CHILD && !args.includes("--no-open")) openLink(link);
  await new Promise(() => { /* runs until Ctrl+C */ });
}
