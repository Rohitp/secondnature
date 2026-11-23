import { createInterface } from "node:readline/promises";
import { isPaused, settings } from "../config.js";
import { loadEmbedder, modelCached, MODEL_SIZE, MODEL_SOURCE } from "../embed/model.js";
import { learnRepo } from "../learn/pipeline.js";
import { pickRunner, pickWriter, saveUsage } from "../learn/writer.js";
import { fillExplanations } from "../learn/explain.js";
import { latestHandoff, makeHandoff, needsHandoff } from "../handoff/handoff.js";
import { scanLogs } from "../logs/discover.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";
import { ensureRepo, foldDuplicates, overlappingLive } from "../store/lessons.js";
import { adoptRepo } from "../repo/adopt.js";
import { review } from "./review.js";
import { repoBlock, repoLabel, scanSummary, type RepoReport } from "./learn-summary.js";

/**
 * Run by hand, learn says what it read, what it found, and where to review it; --verbose gives the old per-repo
 * detail, --review keeps or skips the new ones right here. Automatic scans (auto) print nothing.
 */
export async function learn(opts: { allRepos?: boolean; auto?: boolean; noReview?: boolean; verbose?: boolean; review?: boolean }): Promise<number> {
  if (opts.auto && isPaused()) return 0;
  const here = opts.allRepos ? null : repoIdentity(process.cwd());
  if (!opts.allRepos && !here) { const t = await import("../term.js"); console.error(`${t.mark.fail()} This folder isn't in a git repo, and secondnature learns per repo.\n  ${t.next("muninn learn --all-repos", "reads every repo instead")}`); process.exitCode = 1; return 0; }
  if (opts.auto || opts.verbose) return learnInner(opts, here);
  // The short version: the detail below is quiet, and a summary is printed at the end.
  const t = await import("../term.js");
  const out = console.log;
  const db0 = await openDb();
  const since = String((await db0.execute("SELECT value FROM meta WHERE key='last_learn'")).rows[0]?.value ?? "");
  const started = new Date().toISOString();
  const pre = scanLogs();
  const fresh = pre.sessions.filter((s) => (!here || s.cwd && repoIdentity(s.cwd) === here) && (s.events.at(-1)?.ts ?? "") > since);
  const byTool = new Map<string, number>(); for (const s of fresh) byTool.set(s.tool, (byTool.get(s.tool) ?? 0) + 1);
  const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity" };
  out(`Reading sessions${since ? ` since ${new Date(since).toDateString() === new Date().toDateString() ? t.clock(new Date(since)) : new Date(since).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}…  ${t.c.dim(fresh.length ? [...byTool].map(([k, n]) => `${n} in ${NAMES[k] ?? k}`).join(", ") : "nothing new")}`);
  const notes: string[] = [];
  console.log = (...a: unknown[]) => { const line = a.map(String).join(" "); if (/^(Couldn't (store|write)|.*: you've used )/.test(line)) notes.push(line); };
  let waiting = 0;
  try { waiting = await learnInner({ ...opts, review: false }, here, notes); }
  finally { console.log = out; }
  const db = await openDb();
  const where = here ? "AND repo_id=?" : ""; const args = here ? [here] : [];
  const made = (await db.execute({ sql: `SELECT coalesce(plain,text) t, sessions FROM lessons WHERE status='proposed' AND created_at>=? ${where} ORDER BY sessions DESC LIMIT 5`, args: [started, ...args] })).rows;
  const madeN = Number((await db.execute({ sql: `SELECT count(*) n FROM lessons WHERE status='proposed' AND created_at>=? ${where}`, args: [started, ...args] })).rows[0]?.n ?? 0);
  const again = since ? (await db.execute({ sql: `SELECT DISTINCT coalesce(l.plain,l.text) t FROM evidence e JOIN lessons l ON l.id=e.lesson_id WHERE l.status='live' AND e.seen_at>? AND e.seen_at>=coalesce(l.reviewed_at,l.created_at) ${here ? "AND l.repo_id=?" : ""} LIMIT 3`, args: [since, ...args] })).rows.map((r) => String(r.t)) : [];
  const cut = (s: string, n = 50) => (s.length > n ? `${s.slice(0, s.lastIndexOf(" ", n - 1) > n / 2 ? s.lastIndexOf(" ", n - 1) : n - 1)}…` : s);
  out("");
  if (madeN) { out(`${t.mark.ok()} ${t.plural(madeN, "new lesson")} to review`); for (const r of made) out(t.c.dim(`    ${t.pad(cut(String(r.t).replace(/\s+/g, " ")), 52)}${Number(r.sessions) > 1 ? `in ${r.sessions} sessions` : ""}`)); }
  else out(`${t.mark.ok()} No new lessons this time.`);
  if (again.length) out(`${t.mark.need()} ${again.length === 1 ? "A kept lesson's problem came up again" : `${again.length} kept lessons' problems came up again`}: ${t.c.dim(again.map((x) => cut(x, 40)).join("; "))}`);
  for (const n of notes) out(`${/^Couldn't/.test(n) ? t.mark.fail() : /may be out of date/.test(n) ? t.mark.need() : t.mark.ok()} ${n}`);
  out("");
  if (waiting) out(t.next("muninn ui", madeN ? "to keep or skip them" : `· ${waiting} wait for you`));
  if (opts.review) await review(db, here);
  return waiting;
}

async function learnInner(opts: { allRepos?: boolean; auto?: boolean; noReview?: boolean; verbose?: boolean; review?: boolean }, here: string | null, summaryNotes?: string[]): Promise<number> {
  const cfg = settings();

  const scan = scanLogs();
  const { ignoredRepos } = await import("../store/ignore.js");
  const ignored = await ignoredRepos(await openDb());
  const repos = (here ? (scan.byRepo.has(here) ? [here] : []) : [...scan.byRepo.keys()]).filter((r) => !ignored.has(r));
  const count = repos.reduce((n, r) => n + scan.byRepo.get(r)!.length, 0);
  if (!opts.auto) {
    for (const line of scanSummary(scan, here, ignored)) console.log(line);
  }
  if (!count) { if (!opts.auto) console.log("Nothing to learn from yet. Work with Claude Code, Codex, Cursor or Antigravity as usual: muninn reads each session on its own soon after it ends, and suggestions appear in muninn ui."); return 0; }

  const writer = pickWriter();
  if (!opts.auto) console.log(writer ? `Redacted excerpts will go to your ${writer.name === "claude" ? "Claude Code" : "Codex"} to write lessons.` : "No Claude Code or Codex client found, so only repeated instructions can become lessons.");

  if (!modelCached()) {
    if (opts.auto) return 0;
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`muninn needs a one-time download of a local embedding model, ${MODEL_SIZE}, from ${MODEL_SOURCE}. It runs on this machine and spots instructions that mean the same thing. Download it (y/n)? `);
      rl.close();
      if (!a.trim().toLowerCase().startsWith("y")) { console.log("Stopped. The model is needed to compare what you typed."); return 0; }
    }
  }
  const embed = await loadEmbedder();
  const db = await openDb();
  for (const repo of repos) {
    const sessions = scan.byRepo.get(repo)!;
    await adoptRepo(db, repo, sessions[0]!.cwd);
    await ensureRepo(db, repo, sessions[0]!.cwd);
    // Marks the repo as scanned, so a session ending in a brand-new repo can trigger its first scan straight away.
    await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [`scanned:${repo}`, new Date().toISOString()] });
    // What this repo's scan finds is gathered here and printed as one block at the end, so lines don't interleave.
    const notes: string[] = [];
    let review: RepoReport["review"] = null;
    // Lines in the repo's CLAUDE.md that may be out of date. Cheap: no model calls.
    try {
      const { checkAndSave } = await import("../memory/stale.js");
      const n = await checkAndSave(db, repo, sessions);
      if (n) notes.push(`${n} line(s) in CLAUDE.md may be out of date. See them in muninn ui, or run "muninn memory".`);
    } catch { /* a repo muninn can't read shouldn't stop the scan */ }
    // Lessons a teammate shared in the repo's .muninn/lessons.md: kept here too, so they're told and measured.
    try {
      const n = await (await import("../deliver/team.js")).importTeam(db, repo);
      if (n) notes.push(`Kept ${n} lesson(s) a teammate shared in .muninn/lessons.md.`);
    } catch { /* a repo muninn can't read shouldn't stop the scan */ }
    const folded = await foldDuplicates(db, repo);
    // Workflow runs: sessions that worked together, with their subagents and roles. Agents sending each other's work back become moments.
    let extra: import("../learn/signals.js").Moment[] = [];
    try {
      const w = await import("../workflow/runs.js"); w.applyTeam(sessions, await w.teamFacts(db));
      const runs = w.buildRuns(repo, sessions); await w.saveRuns(db, runs);
      extra = (await import("../workflow/feedback.js")).feedbackMoments(repo, sessions, runs);
    } catch { /* runs are a view, not needed to learn */ }
    // Subagents learn too: their failed commands, loops and wrong paths. They never typed anything, so your-words signals skip them.
    const withSubs = [...sessions, ...sessions.flatMap((s) => s.subagents ?? [])];
    const r = await learnRepo(db, repo, withSubs, { embed, writer, cutoff: cfg.similarityCutoff, minSessions: cfg.minSessions, notesPerRun: cfg.notesPerRun, extra: [...extra, ...(await (await import("../learn/unanswered.js")).unansweredMoments(db, repo, embed).catch(() => []))] });
    await saveUsage(db, writer?.runner ?? null, "lesson writing");
    // Long sessions read in chunks by your Claude: what you steered toward, and what the session showed.
    if (writer) {
      try {
        const { reviewSessions } = await import("../learn/session-review.js");
        const reviewer = pickRunner("background");
        if (reviewer) {
          review = await reviewSessions(db, repo, sessions, reviewer, embed, { cutoff: cfg.similarityCutoff });
          await saveUsage(db, reviewer, "session review");
        }
      } catch (e) { notes.push(`Couldn't read long sessions this time: ${e instanceof Error ? e.message : String(e)}`); }
    }
    // Changes to propose: "ask first" rules from commands you keep stopping, and skills from steps that repeat.
    try {
      const p = await import("../propose/index.js");
      const { repoRoot } = await import("../deliver/local-file.js");
      let guards = 0;
      for (const g of p.guardProposals(repo, sessions, await repoRoot(db, repo))) if (await p.propose(db, g)) guards++;
      let trims = 0;
      for (const t of p.trimProposals(repo, sessions)) if (await p.propose(db, t)) trims++;
      const skillRunner = writer ? pickRunner("background") : null;
      const skills = await p.proposeSkills(db, repo, sessions, skillRunner);
      await saveUsage(db, skillRunner, "skill drafts");
      if (guards || skills || trims) notes.push(`Proposed ${[guards ? `${guards} "ask first" rule(s)` : "", skills ? `${skills} skill(s)` : "", trims ? `${trims} output trim(s)` : ""].filter(Boolean).join(" and ")}. Apply or dismiss them in muninn ui or with "muninn changes".`);
    } catch (e) { notes.push(`Couldn't look for changes to propose: ${e instanceof Error ? e.message : String(e)}`); }
    if (!opts.auto) {
      if (folded) notes.push(`Folded ${folded} duplicate suggestion(s) into the lesson they repeat.`);
      // Two kept lessons built from the same quotes: name them by their words, since ids mean nothing to read.
      for (const [a, b] of await overlappingLive(db, repo)) {
        const text = async (id: string) => { const t = String((await db.execute({ sql: "SELECT coalesce(plain,text) t FROM lessons WHERE id=?", args: [id] })).rows[0]?.t ?? id); return t.length > 70 ? `${t.slice(0, 69)}…` : t; };
        notes.push(`Two kept lessons come from the same quotes: "${await text(a)}" and "${await text(b)}". Switch one off in muninn ui, or run "muninn retire ${b.slice(0, 8)}".`);
      }
      if (summaryNotes) summaryNotes.push(...notes.map((n) => (opts.allRepos ? `${repoLabel(repo)}: ${n}` : n)));
      for (const line of repoBlock({ repo, sessions: sessions.length, minSessions: cfg.minSessions, moments: Object.values(r.moments).reduce((a, b) => a + b, 0), known: r.known, newLessons: r.newLessons, noise: r.discarded, review, notes })) console.log(line);
    }
    for (const s of sessions) if (s.unknown) { await db.execute({ sql: "INSERT OR REPLACE INTO scan_counts (repo_id,tool,client_version,scanned_at,unknown_records) VALUES (?,?,?,?,?)", args: [repo, s.tool, s.clientVersion, new Date().toISOString(), s.unknown] }); }
  }
  // Cursor and Antigravity only hear lessons through rules files: turned on where you've used them, unless you turned them off.
  try {
    const { autoTurnOn, TOOL_NAME } = await import("../deliver/auto-rules.js");
    for (const t of await autoTurnOn(db, new Map(repos.map((r) => [r, scan.byRepo.get(r)!]))))
      if (!opts.auto) console.log(`${repoLabel(t.repo)}: you've used ${TOOL_NAME[t.tool]} here, so its agent now gets your lessons as rules files (${t.files.join(", ")}). Turn this off with "muninn ${t.tool} off" or on the page.`);
  } catch { /* rules files are a convenience */ }
  // Every session kept as searchable exchanges, and the raw logs copied before the tool deletes them.
  try {
    const st = await import("../store/sessions.js");
    const archived = await st.archiveLogs(db);
    await st.indexPlan(db, embed);
    const all = repos.flatMap((r) => scan.byRepo.get(r)!);
    let shown = -1;
    const r = await st.indexSessions(db, all, embed, { ignored, onProgress: opts.auto || !opts.verbose ? undefined : (done, total) => { const pct = Math.floor((done / total) * 10); if (process.stdout.isTTY && pct !== shown) { shown = pct; process.stdout.write(`\rStoring sessions for search: ${done}/${total}`); } } });
    if (!opts.auto && process.stdout.isTTY && shown >= 0) process.stdout.write("\r\x1b[K");
    if (!opts.auto && (r.added || archived)) console.log(`Stored ${r.added} exchange(s) from ${r.sessions} session(s) for "muninn recall"${archived ? `, and kept a compressed copy of ${archived} log(s)` : ""}.`);
  } catch (e) { if (!opts.auto) console.log(`Couldn't store sessions this time: ${e instanceof Error ? e.message : String(e)}`); }
  const runner = writer ? pickRunner("background") : null;
  // A plain-English line and likely questions for each lesson, for the person and for search.
  if (runner) {
    try { const n = await fillExplanations(db, runner, embed); if (n && !opts.auto) console.log(`Wrote plain-English summaries for ${n} lesson(s).`); }
    catch (e) { if (!opts.auto) console.log(`Couldn't write summaries this time: ${e instanceof Error ? e.message : String(e)}`); }
    await saveUsage(db, runner, "plain lines");
    // A why for lessons kept before muninn wrote one with each lesson.
    try { const { explainWhy } = await import("../learn/why.js"); for (let i = 0; i < 4; i++) if (!(await explainWhy(db, runner))) break; }
    catch { /* asked again next time */ }
    await saveUsage(db, runner, "lesson reasons");
  }
  // Handoffs for recent sessions that ended without the SessionEnd hook, such as Cursor's.
  if (runner && !isPaused()) {
    const have = new Map((await db.execute("SELECT session, max(created_at) at FROM handoffs GROUP BY session")).rows.map((r) => [String(r.session), String(r.at)] as [string, string]));
    let made = 0;
    for (const repo of repos) for (const s of needsHandoff(scan.byRepo.get(repo)!, have, 2)) {
      if (made >= cfg.handoffsPerRun) break;
      const branch = s.branch ?? null;
      const newer = branch ? await latestHandoff(db, repo, branch, cfg.handoffDays) : null;
      if (newer && newer.created_at >= (s.events.at(-1)?.ts ?? "")) continue;
      try { if (await makeHandoff(db, s, runner)) made++; } catch { /* a failed handoff shouldn't stop learning */ }
    }
    await saveUsage(db, runner, "handoff");
    // Fold any handoffs not yet in a plan (older ones, or ones whose update failed), then rewrite PLAN.md where it's on.
    const { applyPending, writePlanFile } = await import("../plan/plan.js");
    const folded = await applyPending(db, runner);
    await saveUsage(db, runner, "plan");
    // Group newly finished steps into outcomes, and give decisions their area and reason, for the page's history.
    try {
      const { branchesToGroup, groupHistory } = await import("../plan/history.js");
      let branches = 0;
      for (const repo of repos) for (const b of await branchesToGroup(db, repo)) { if (branches++ >= 6) break; await groupHistory(db, repo, b, runner).catch(() => 0); }
      await saveUsage(db, runner, "plan history");
    } catch { /* the history is a convenience */ }
    // How things relate: decisions to the outcomes they led to, outcomes to sessions and commits, sessions to files.
    try {
      const { buildLinks } = await import("../links/links.js");
      await buildLinks(db, repos.flatMap((r) => scan.byRepo.get(r)!));
      // Your Claude checks the links muninn can only guess at, a few batches per scan.
      const { confirmLinks } = await import("../links/confirm.js");
      for (let i = 0; i < 3; i++) { const c = await confirmLinks(db, runner); if (!c.motivates && !c.supersedes && !c.outside) break; }
      await saveUsage(db, runner, "link checks");
    } catch { /* links are a convenience */ }
    // Questions worth asking muninn, written from each repo's recent work, for the page's Ask box.
    try {
      const { refreshSuggestions } = await import("./suggestions.js");
      for (const repo of [...repos, null]) await refreshSuggestions(db, repo, runner).catch(() => []);
      await saveUsage(db, runner, "question suggestions");
    } catch { /* suggestions are a convenience */ }
    if (folded) for (const repo of repos) await writePlanFile(db, repo).catch(() => null);
    if (made && !opts.auto) console.log(`Wrote ${made} handoff(s) for recent sessions. See them with "muninn handoff --list".`);
  }
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES ('last_learn',?)", args: [new Date().toISOString()] });
  if (!opts.auto) {
    const unknown = scan.sessions.reduce((n, s) => n + s.unknown, 0);
    if (unknown) console.log(`${unknown} log record(s) had a structure muninn doesn't recognise, so a format may have changed.`);
    if (opts.review && !opts.noReview) await review(db, here);
  }
  const waiting = await db.execute({ sql: `SELECT count(*) n FROM lessons WHERE status='proposed' ${here ? "AND repo_id=?" : ""}`, args: here ? [here] : [] });
  return Number(waiting.rows[0]?.n ?? 0);
}
