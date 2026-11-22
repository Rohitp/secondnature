#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, home } from "./config.js";

const [cmd, ...args] = process.argv.slice(2);
const USAGE = `muninn: lessons that carry across coding sessions

  muninn learn [--all-repos]    Find lessons in your logs and review them
  muninn review                 Review lessons that are waiting
  muninn add "text" [--always-on] [--trigger word] [--global]
  muninn list [--all] [--status proposed|live|rejected|retired]
  muninn show <id>
  muninn edit <id> [--text "..."] [--always-on|--not-always-on] [--trigger word] [--global|--repo-scope]
  muninn retire <id>
  muninn ask "question"         Search kept lessons and notes in every repo
  muninn links check            Rebuild links, and have your Claude check the ones muninn guessed
  muninn link|unlink "decision" "work"  Say a decision did (or didn't) lead to some finished work
  muninn related "what" [--all-repos]  What a decision or piece of work led to, and where it was done
  muninn recall "what" [--all-repos] [--days N] [--full]
                                Search your past sessions: what was asked, said and run
  muninn memory [--all-repos]   Lines in CLAUDE.md that may be out of date
  muninn plan tidy [--all-repos]  Rewrite branch plans, checked against git
  muninn plan history [--all-repos]  Group finished steps into outcomes, and give decisions their reasons
  muninn handoff [--list]       Where the last session on this branch left off
  muninn setup                  Set everything up and take a first look (start here)
  muninn connect                Connect (or re-check) hooks, plugin, MCP and the background job for every tool here
  muninn report [--all]         Did kept lessons work: delivered, and seen again since
  muninn report --page [file]   The same as one HTML page to send someone (worked, came back, stale, savings)
  muninn keep <id> | reject <id>  Keep a waiting lesson with muninn's suggested delivery, or reject it
  muninn dial [quiet|start|anytime]  When muninn speaks up to agents here: only when asked,
                                at session start, or whenever relevant
  muninn ui                     Open muninn in your browser
  muninn cursor on|off|sync     Kept lessons as Cursor rules in this repo (on by itself once you use Cursor here)
  muninn share [pull|off]       Put this repo's lessons in the repo for your team: CLAUDE.md, AGENTS.md, Copilot,
                                Cursor and Antigravity rules, and .muninn/lessons.md. pull keeps a teammate's
  muninn local-file on|off      Keep always-on lessons in this repo's CLAUDE.local.md (this machine only)
  muninn antigravity on|off     Kept lessons as Antigravity rules in this repo (on by itself once you use it here)
  muninn keywords               Keywords in use, and how many lessons each has
  muninn mcp install            Ask about your work from any chat with Claude (adds muninn's MCP server)
  muninn ignore-repo [name] [--undo]  Leave a repo alone: not listed, scanned or told
  muninn changes [check|apply <id>|dismiss <id>|undo <id>]
                                Changes muninn proposes: ask-first rules, skills, edits to CLAUDE.md
  muninn pr [--apply]           Write the "why" for this branch's pull request from your sessions
  muninn insights [--days 7] [--all-repos]  Your week with coding agents: what went well, what didn't
  muninn status                 What muninn has learned and sent, and any problems
  muninn runs [--all] [--all-repos]  Workflow runs: sessions, subagents and worktree roles that worked together
  muninn schedule [on|off]      A macOS background job that scans every few hours, for days without Claude Code
  muninn install [--learn]      Add Claude Code and Codex hooks (--learn: only automatic scans)
  muninn uninstall              Remove muninn's hooks
  muninn pause | resume         Stop or restart delivery and automatic scans
  muninn export [file]
  muninn purge --yes`;

const CHANGES = new Set(["learn", "review", "add", "edit", "retire", "keep", "reject", "share"]);

/**
 * muninn share [--only claude,agents,copilot,cursor,antigravity]   Write this repo's lessons into the repo, for the team
 * muninn share pull   Keep lessons a teammate shared in .muninn/lessons.md
 * muninn share off    Take muninn's team parts out of the repo's files again
 */
async function shareCmd(args: string[]) {
  const [{ openDb }, { repoIdentity }, t, { ensureRepo }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./deliver/team.js"), import("./store/lessons.js")]);
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  if (!repo) { console.error("Run this inside a git repo."); process.exitCode = 1; return; }
  await ensureRepo(db, repo, process.cwd());
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "";
  if (sub === "off") { const files = await t.unshare(db, repo); console.log(files.length ? `Took muninn's team lessons out of ${files.join(", ")}. ${t.TEAM_FILE} is left for you to remove in git.` : "Nothing to take out."); return; }
  if (sub === "pull") { const n = await t.importTeam(db, repo); console.log(n ? `Kept ${n} lesson(s) from ${t.TEAM_FILE}. They're told to your agents and measured like your own.` : `No new lessons in ${t.TEAM_FILE}.`); return; }
  if (sub) { console.error("Usage: muninn share [--only claude,agents,copilot,cursor,antigravity] | share pull | share off"); process.exitCode = 1; return; }
  const at = args.indexOf("--only");
  const only = at >= 0 ? String(args[at + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean) : null;
  const bad = only?.filter((x) => !(t.TARGETS as string[]).includes(x)) ?? [];
  if (bad.length) { console.error(`Unknown: ${bad.join(", ")}. Use any of ${t.TARGETS.join(", ")}.`); process.exitCode = 1; return; }
  const pulled = await t.importTeam(db, repo);
  const r = await t.share(db, repo, (only as typeof t.TARGETS | null) ?? t.TARGETS);
  if (pulled) console.log(`Kept ${pulled} lesson(s) a teammate added to ${t.TEAM_FILE} first.`);
  if (!r.lessons) { console.log("No lessons to share yet: only kept lessons for this repo that are told every session or on a keyword are shared."); return; }
  console.log(`Shared ${r.lessons} lesson(s). ${r.files.length ? `Changed ${r.files.join(", ")}.` : "The files were already up to date."}`);
  if (r.ignored) {
    const { relative } = await import("node:path");
    console.log(`\nGit ignores ${t.TEAM_FILE}, because of "${r.ignored.pattern}" on line ${r.ignored.line} of ${relative(r.root, r.ignored.file) || r.ignored.file}, so it won't be committed. Teammates' agents still read the other files, but their muninn can't keep these lessons. To commit it, put these lines in .gitignore${t.letThrough(r.ignored.pattern).length > 1 ? ` in place of "${r.ignored.pattern}"` : ""}:\n${t.letThrough(r.ignored.pattern).map((l) => `  ${l}`).join("\n")}`);
  }
  console.log(`\nSee the changed and new files with "git status", review them with "git diff" and by opening the new ones, then commit them. A teammate's agents read the lessons from these files; if they use muninn, "muninn share pull" keeps them so they're measured too.`);
}

async function cursorCmd(sub: string) {
  const [{ openDb }, { repoIdentity }, c] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./deliver/cursor.js")]);
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  if (sub === "sync") { await c.syncCursor(db); console.log("Cursor rules rewritten for every repo that has them on."); return; }
  if (!repo) { console.error("Run this inside a git repo."); process.exitCode = 1; return; }
  if (sub === "off") { await (await import("./deliver/auto-rules.js")).setRules(db, repo, "cursor", false); console.log("Removed muninn's Cursor rules from this repo. muninn won't turn them back on here."); return; }
  if (sub !== "on") { console.error("Usage: muninn cursor on|off|sync"); process.exitCode = 1; return; }
  const { ensureRepo } = await import("./store/lessons.js");
  await ensureRepo(db, repo, process.cwd());
  const r = await (await import("./deliver/auto-rules.js")).setRules(db, repo, "cursor", true);
  if (!r) { console.error("Couldn't find this repo's folder."); process.exitCode = 1; return; }
  console.log(`Wrote ${r.files.join(", ")} in ${r.root}/.cursor/rules. They're listed in .git/info/exclude, so git ignores them without changing any shared file. muninn rewrites them when lessons change.`);
}

async function localFileCmd(sub: string) {
  if (sub !== "on" && sub !== "off") { console.error("Usage: muninn local-file on|off"); process.exitCode = 1; return; }
  const [{ openDb }, { repoIdentity }, f, { ensureRepo }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./deliver/local-file.js"), import("./store/lessons.js")]);
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  if (!repo) { console.error("Run this inside a git repo."); process.exitCode = 1; return; }
  await ensureRepo(db, repo, process.cwd());
  const r = await f.setLessonFile(db, repo, sub === "on" ? "local" : "off");
  if (!r) { console.error("Couldn't find this repo's folder."); process.exitCode = 1; return; }
  console.log(sub === "on"
    ? `Wrote this repo's always-on lessons into ${r.file}, between muninn's two marker lines. Claude Code reads that file at the start of every session. git ignores it in this clone, and muninn rewrites its part when lessons change.`
    : `Took muninn's lessons out of ${r.file}. Anything else in the file is left as it was.`);
}

async function antigravityCmd(sub: string) {
  if (sub !== "on" && sub !== "off") { console.error("Usage: muninn antigravity on|off"); process.exitCode = 1; return; }
  const [{ openDb }, { repoIdentity }, a, { ensureRepo }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./deliver/antigravity.js"), import("./store/lessons.js")]);
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  if (!repo) { console.error("Run this inside a git repo."); process.exitCode = 1; return; }
  const { setRules } = await import("./deliver/auto-rules.js");
  if (sub === "off") { await setRules(db, repo, "antigravity", false); console.log("Removed muninn's Antigravity rules from this repo. muninn won't turn them back on here."); return; }
  await ensureRepo(db, repo, process.cwd());
  const r = await setRules(db, repo, "antigravity", true);
  if (!r) { console.error("Couldn't find this repo's folder."); process.exitCode = 1; return; }
  console.log(`Wrote ${r.files.join(", ")} in ${r.root}/.agents/rules. Antigravity's agent reads the always-on one every turn, and the others when they fit the task. git ignores them in this clone, and muninn rewrites them when lessons change.`);
}

/** muninn ignore-repo [repo] [--undo]: leave a repo alone (this one, or one named as the page lists it). */
async function ignoreRepoCmd(args: string[]) {
  const [{ openDb }, { repoIdentity }, ig] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./store/ignore.js")]);
  const db = await openDb();
  const named = args.find((a) => !a.startsWith("--"));
  const all = (await db.execute("SELECT id FROM repos")).rows.map((r) => String(r.id));
  const id = named ? all.find((r) => r === named || r.split("/").filter(Boolean).pop() === named) ?? named : repoIdentity(process.cwd());
  if (!id) { console.error("Run this inside the repo, or name it: muninn ignore-repo <name>"); process.exitCode = 1; return; }
  if (args.includes("--undo")) { await ig.unignoreRepo(db, id); console.log(`muninn will read ${id} again from its next scan.`); return; }
  const n = await ig.ignoreRepo(db, id);
  console.log(`muninn now leaves ${id} alone: it isn't listed or scanned, and agents there aren't told anything. Removed ${n} lesson(s) and its plan. Undo with "muninn ignore-repo ${named ?? ""} --undo".`.replace("  ", " "));
}

/** muninn uses Node 22 features (fs.globSync among them). On older Node, say so plainly instead of crashing on an import. */
function nodeTooOld(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return false;
  // `muninn` starts on whichever Node is first on the PATH, which for an app like Claude Code may be an older one.
  // Rerun on the Node that installed the hooks, if muninn recorded one.
  try {
    const node = readFileSync(join(home(), "node"), "utf8").trim();
    if (node && existsSync(node) && node !== process.execPath) {
      const r = spawnSync(node, [process.argv[1]!, ...process.argv.slice(2)], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return true;
    }
  } catch { /* nothing recorded: explain below */ }
  // A copy built from the source folder is reinstalled from there; one installed from npm, with npm.
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
  let again = "then run muninn again.";
  if (existsSync(join(pkg, "src"))) again = `then in ${pkg} run: pnpm install && pnpm build && npm link`;
  else { try { again = `then reinstall muninn with it: npm install -g ${JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).name}`; } catch { /* keep the plain line */ } }
  console.error(`muninn needs Node 22 or newer. This is Node ${process.versions.node}.
Install Node 22 (for example "fnm install 22", "nvm install 22" or "brew install node@22"), open a new terminal,
${again}`);
  process.exitCode = 1;
  return true;
}

async function main() {
  if (nodeTooOld() && cmd !== "hook") return;
  switch (cmd) {
    case "learn": {
      const auto = args.includes("--auto");
      const { learn } = await import("./commands/learn.js");
      if (!auto) return learn({ allRepos: args.includes("--all-repos") });
      const { takeLock, releaseLock, stamp, scanDue } = await import("./commands/auto.js");
      // --force is the page's "Check now": run even if a scan isn't due yet.
      if ((!args.includes("--force") && !scanDue()) || !takeLock()) return;
      // Without the local model the scan stops before reading anything, so it isn't stamped and is tried again next time.
      const { modelCached } = await import("./embed/model.js");
      // Quietly put back anything that dropped off (a hook removed, an MCP entry rewritten away). Files only, no prompts.
      try { await (await import("./commands/connect.js")).connectEverything({ quiet: true }); } catch { /* repair is best effort */ }
      try { await learn({ allRepos: true, auto: true }); if (modelCached()) stamp(); } finally { releaseLock(); }
      return;
    }
    case "review": {
      const [{ openDb }, { repoIdentity }, { review }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./commands/review.js")]);
      return review(await openDb(), args.includes("--all") ? null : repoIdentity(process.cwd()));
    }
    case "add": return (await import("./commands/lessons.js")).add(args);
    case "list": return (await import("./commands/lessons.js")).list(args);
    case "show": return (await import("./commands/lessons.js")).show(args);
    case "edit": return (await import("./commands/lessons.js")).edit(args);
    case "retire": return (await import("./commands/lessons.js")).retire(args);
    case "export": return (await import("./commands/lessons.js")).exportLessons(args);
    case "purge": return (await import("./commands/lessons.js")).purge(args);
    case "install": { const m = await import("./commands/install.js"); return args.includes("--learn") ? m.installLearnHook() : m.install(); }
    case "uninstall": { (await import("./commands/install.js")).uninstall(); (await import("./commands/connect.js")).markDisconnected(); console.log('Removed muninn\'s hooks. Lessons are kept. muninn won\'t add them back on its own; "muninn connect" does.'); return; }
    case "ask": return (await import("./commands/ask.js")).ask(args);
    case "mcp": return (await import("./mcp/install.js")).mcpCmd(args);
    case "related": {
      const about = args.filter((x) => !x.startsWith("--")).join(" ").trim();
      if (!about) { console.error('Usage: muninn related "a decision or piece of work" [--all-repos]'); process.exitCode = 1; return; }
      const [{ openDb }, { repoIdentity }, { loadEmbedder }, { relatedText }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./embed/model.js"), import("./links/links.js")]);
      const db = await openDb(); const repo = args.includes("--all-repos") ? null : repoIdentity(process.cwd()); const t0 = Date.now();
      const text = await relatedText(db, about, repo, await loadEmbedder());
      const [{ recordQuery, whoIsAsking }, { currentBranch }] = await Promise.all([import("./store/queries.js"), import("./handoff/handoff.js")]);
      const who = whoIsAsking(); const hit = !text.startsWith("Found no");
      await recordQuery(db, { repo, branch: repo ? currentBranch(process.cwd()) : null, session: who.session, tool: who.tool, surface: "related", query: about, results: hit ? 1 : 0, result_ids: hit ? [{ kind: "link", id: about.slice(0, 80) }] : [], ms: Date.now() - t0, answer: text });
      console.log(text);
      return;
    }
    case "links": {
      // muninn links check: rebuild links and have your Claude check every one it can only guess at, now.
      if (args[0] !== "check") { console.error("Usage: muninn links check"); process.exitCode = 1; return; }
      const [{ openDb }, { scanLogs }, { buildLinks }, { confirmLinks }, { pickRunner, saveUsage }] = await Promise.all([import("./store/db.js"), import("./logs/discover.js"), import("./links/links.js"), import("./links/confirm.js"), import("./learn/writer.js")]);
      const db = await openDb(); const runner = pickRunner("background");
      if (!runner) { console.error("This needs the claude (or codex) command, which muninn couldn't find."); process.exitCode = 1; return; }
      await buildLinks(db, scanLogs().sessions);
      const total = { motivates: 0, supersedes: 0, outside: 0 };
      for (let i = 0; i < 40; i++) { const c = await confirmLinks(db, runner); total.motivates += c.motivates; total.supersedes += c.supersedes; total.outside += c.outside; if (!c.motivates && !c.supersedes && !c.outside) break; }
      await saveUsage(db, runner, "link checks");
      const n = async (sql: string) => Number((await db.execute(sql)).rows[0]?.n ?? 0);
      console.log(`Checked ${total.motivates} led-to link(s): ${await n("SELECT count(*) n FROM links WHERE rel='motivates' AND how='confirmed'")} kept, ${await n("SELECT count(*) n FROM links WHERE rel='motivates' AND how='rejected'")} dropped as only similar.`);
      console.log(`Checked ${total.supersedes} pair(s) of decisions: ${await n("SELECT count(*) n FROM links WHERE rel='supersedes' AND how='confirmed'")} newer decision(s) replace an older one.`);
      console.log(`Checked ${total.outside} outcome(s) for changes outside the repo: ${await n("SELECT count(*) n FROM links WHERE rel='affects'")} found.`);
      console.log(`Lessons naming files no longer in their repo: ${await n("SELECT count(DISTINCT src_id) n FROM links WHERE rel='applies_to' AND how='missing'")}.`);
      return;
    }
    case "link": case "unlink": {
      const [decision, work] = args.filter((x) => !x.startsWith("--"));
      if (!decision || !work) { console.error(`Usage: muninn ${cmd} "a decision" "a piece of finished work"`); process.exitCode = 1; return; }
      const [{ openDb }, { repoIdentity }, { loadEmbedder }, { linkCmd }] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./embed/model.js"), import("./links/links.js")]);
      console.log(await linkCmd(await openDb(), cmd === "link", decision, work, args.includes("--all-repos") ? null : repoIdentity(process.cwd()), await loadEmbedder()));
      return;
    }
    case "recall": return (await import("./commands/recall.js")).recall(args);
    case "cursor": return cursorCmd(args[0] ?? "");
    case "share": return shareCmd(args);
    case "local-file": return localFileCmd(args[0] ?? "");
    case "antigravity": return antigravityCmd(args[0] ?? "");
    case "ignore-repo": return ignoreRepoCmd(args);
    case "changes": return (await import("./commands/changes.js")).changes(args);
    case "pr": return (await import("./commands/pr.js")).pr(args);
    case "insights": return (await import("./commands/insights.js")).insights(args);
    case "handoff": return (await import("./commands/handoff.js")).handoff(args);
    case "scan": {
      // Starts a lesson scan in the background and returns at once: the panel's "Check my sessions now".
      const { startAutoScan, scanRunning } = await import("./commands/auto.js");
      console.log(startAutoScan({ force: true }) ? "Checking your sessions for lessons. New ones show here when it's done." : scanRunning() ? "Already checking your sessions." : "Couldn't start a check: muninn may be paused.");
      return;
    }
    case "memory": {
      // Lines in CLAUDE.md that may be out of date, for this repo or all of them.
      const [{ openDb }, { openFlags }, { repoIdentity }] = await Promise.all([import("./store/db.js"), import("./memory/stale.js"), import("./repo/identity.js")]);
      const db = await openDb();
      const rows = (await openFlags(db, args.includes("--all-repos") ? null : repoIdentity(process.cwd()))).filter((r) => r.status === "open");
      if (!rows.length) { console.log("No lines in CLAUDE.md look out of date. muninn checks them on each scan."); return; }
      for (const r of rows) console.log(`${r.repo_id.split("/").pop()} ${r.file}:${r.line}  ${r.text}\n    ${r.detail}\n`);
      console.log('Remove or keep them in muninn ui.');
      return;
    }
    case "plan": return (await import("./commands/plan.js")).planCmd(args);
    case "checkpoint": return (await import("./commands/handoff.js")).checkpointCmd(args);
    case "report": return (await import("./commands/report.js")).report(args);
    case "setup": return (await import("./commands/setup.js")).setup(args);
    case "panel": return (await import("./commands/panel.js")).panel(args);
    case "keep": return (await import("./commands/panel.js")).keepWithDefaults(args);
    case "reject": return (await import("./commands/panel.js")).reject(args);
    case "dial": return (await import("./commands/panel.js")).dial(args);
    case "feedback": return (await import("./commands/panel.js")).feedback(args);
    case "ui": {
      if (!args.includes("--detach")) return (await import("./ui/server.js")).serve(args);
      console.log(await (await import("./ui/detach.js")).uiDetached({ open: !args.includes("--no-open") }));
      return;
    }
    case "status": return (await import("./commands/status.js")).status();
    case "runs": {
      const [{ openDb }, { repoIdentity }, w] = await Promise.all([import("./store/db.js"), import("./repo/identity.js"), import("./workflow/runs.js")]);
      return w.runsCmd(await openDb(), args.includes("--all-repos") ? null : repoIdentity(process.cwd()), { all: args.includes("--all") });
    }
    case "connect": { console.log("Connecting muninn to the coding tools on this machine:"); await (await import("./commands/connect.js")).connectEverything(); return; }
    case "schedule": return (await import("./commands/schedule.js")).schedule(args[0] ?? "");
    case "keywords": return (await import("./commands/status.js")).keywords();
    case "pause": writeFileSync(join(ensureHome(), "paused"), ""); console.log("Paused."); return;
    case "resume": rmSync(join(ensureHome(), "paused"), { force: true }); console.log("Resumed."); return;
    case "hook": return runHook(args[args.indexOf("--client") + 1] ?? "unknown", args.includes("--event") ? args[args.indexOf("--event") + 1] : undefined);
    default: console.log(USAGE); if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}
/** True when the session's folder is a git repo that no scan has looked at yet. */
async function neverScanned(cwd: unknown): Promise<boolean> {
  if (typeof cwd !== "string" || !existsSync(join(home(), "muninn.db"))) return false;
  const [{ repoIdentity }, { openDb }] = await Promise.all([import("./repo/identity.js"), import("./store/db.js")]);
  const repo = repoIdentity(cwd);
  if (!repo) return false;
  const db = await openDb({ lockWaitMs: 100 });
  // A repo with lessons was scanned before this mark existed.
  return !(await db.execute({ sql: "SELECT 1 FROM meta WHERE key=? UNION ALL SELECT 1 FROM lessons WHERE repo_id=? LIMIT 1", args: [`scanned:${repo}`, repo] })).rows.length;
}

/** Hook failures must never interrupt the agent, so every path exits 0, and the client's own timeout is the hard stop. */
async function runHook(client: string, agEvent?: string) {
  const errors = (e: unknown) => { try { appendFileSync(join(ensureHome(), "hook-errors.log"), `${new Date().toISOString()} ${client} ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing else to do */ } };
  if (process.env.MUNINN_INTERNAL) return;
  const timer = setTimeout(() => { errors(new Error("timed out")); process.exit(0); }, 500);
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    // Antigravity's hooks: camelCase input, and the event named in muninn's own command.
    if (client === "antigravity" && agEvent) {
      if (!existsSync(join(home(), "muninn.db"))) return;
      const [{ openDb }, { antigravityHook }] = await Promise.all([import("./store/db.js"), import("./deliver/antigravity-hook.js")]);
      const out = await antigravityHook(await openDb({ lockWaitMs: 100 }), agEvent, input);
      if (out) process.stdout.write(out);
      return;
    }
    const event = String(input.hook_event_name ?? "");
    if (event === "SessionEnd") {
      const auto = await import("./commands/auto.js");
      if (typeof input.transcript_path === "string") auto.startHandoff(input.transcript_path, client);
      // A repo muninn has never scanned is scanned now, rather than waiting for the daily scan.
      auto.startAutoScan({ force: await neverScanned(input.cwd) }); return;
    }
    if (!existsSync(join(home(), "muninn.db"))) return;
    // Agent teams: record who did what, for workflow runs. Nothing is told to the agent.
    if (event === "TaskCreated" || event === "TaskCompleted" || event === "TeammateIdle") {
      const { openDb } = await import("./store/db.js");
      const db = await openDb({ lockWaitMs: 100 });
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      await db.execute({ sql: "INSERT INTO team_events (ts,session,event,team,teammate,agent_type,task_id,subject) VALUES (?,?,?,?,?,?,?,?)", args: [new Date().toISOString(), str(input.session_id), event, str(input.team_name), str(input.teammate_name), str(input.agent_type), str(input.task_id), str(input.task_subject)?.slice(0, 300) ?? null] });
      return;
    }
    // Claude finished a reply, or is about to compact: if the session has grown enough, update the plan in the background.
    if (event === "Stop" || event === "PreCompact") {
      const t = typeof input.transcript_path === "string" ? input.transcript_path : "";
      if (!t || !existsSync(t) || typeof input.session_id !== "string") return;
      const [{ openDb }, cp, auto, { statSync }] = await Promise.all([import("./store/db.js"), import("./handoff/checkpoint.js"), import("./commands/auto.js"), import("node:fs")]);
      const db = await openDb({ lockWaitMs: 100 });
      const grown = statSync(t).size - (await cp.lastCheckpointSize(db, input.session_id));
      if (grown >= (event === "PreCompact" ? cp.GROWTH.compact : cp.GROWTH.working)) auto.startCheckpoint(t, client);
      // A long session may never end, so it gets a lesson scan every few hours instead of waiting for its end.
      if (event === "Stop" && auto.longScanDue(statSync(t).size)) auto.startAutoScan({ force: true });
      return;
    }
    const [{ openDb }, { deliver, hookOutput }] = await Promise.all([import("./store/db.js"), import("./deliver/hook.js")]);
    // Upgrades the database if muninn was updated since, so new code never meets an old schema (a no-op otherwise).
    const db = await openDb({ lockWaitMs: 100 });
    // Codex doesn't document the shape of a Bash result. Keep the first one's shape (types only) to check failure detection.
    if (client === "codex" && event === "PostToolUse") {
      const r = input.tool_response;
      const shape = r && typeof r === "object" ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v])) : typeof r;
      await db.execute({ sql: "INSERT OR IGNORE INTO meta (key,value) VALUES ('codex_tool_response_shape',?)", args: [JSON.stringify(shape)] });
    }
    const text = await deliver(db, client, input);
    if (text) process.stdout.write(hookOutput(event, text));
  } catch (e) { errors(e); }
  finally { clearTimeout(timer); }
}

main().then(async () => {
  if (!CHANGES.has(cmd ?? "") || process.exitCode) return;
  try { const [{ openDb }, { syncCursor }] = await Promise.all([import("./store/db.js"), import("./deliver/cursor.js")]); await syncCursor(await openDb()); } catch { /* Cursor files are a convenience */ }
}).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
