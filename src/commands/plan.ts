import { pickRunner, saveUsage } from "../learn/writer.js";
import { tidyPlan } from "../plan/plan.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";

/**
 * muninn plan                        where this branch stands: goal, where it stands, next steps, recent decisions
 * muninn plan tidy [--all-repos]     rewrites each branch's plan as a short summary, checked against git
 * muninn plan history [--all-repos]  groups finished steps into outcomes and fills in decisions' reasons, for the page
 */
export async function planCmd(args: string[]) {
  if (args[0] === "history") return historyCmd(args);
  if (!args[0]) return showPlan();
  if (args[0] !== "tidy") { console.log('Usage: muninn plan [tidy|history] [--all-repos]'); return; }
  const runner = pickRunner();
  if (!runner) { console.error("No Claude Code or Codex client found to tidy with."); process.exitCode = 1; return; }
  const db = await openDb();
  const here = args.includes("--all-repos") ? null : repoIdentity(process.cwd());
  if (!args.includes("--all-repos") && !here) { console.error("This folder is not in a git repo. Run it inside one, or use --all-repos."); process.exitCode = 1; return; }
  const rows = (await db.execute({ sql: `SELECT DISTINCT repo_id, branch FROM plan_items WHERE status='active' AND kind IN ('open','decision')${here ? " AND repo_id=?" : ""}`, args: here ? [here] : [] })).rows;
  for (const r of rows) {
    const repo = String(r.repo_id), branch = String(r.branch);
    try {
      const t = await tidyPlan(db, repo, branch, runner);
      if (t) console.log(`${repo.split("/").pop()} @ ${branch}: next steps ${t.before.next} → ${t.after.next}, decisions ${t.before.decisions} → ${t.after.decisions}, ${t.closed} closed as finished, ${t.done} added to done, ${t.repeats} repeats removed.`);
    } catch (e) { console.log(`${repo.split("/").pop()} @ ${branch}: couldn't tidy (${e instanceof Error ? e.message : String(e)}).`); }
    await saveUsage(db, runner, "plan tidy");
  }
}

async function historyCmd(args: string[]) {
  const runner = pickRunner("background");
  if (!runner) { console.error("No Claude Code or Codex client found to group with."); process.exitCode = 1; return; }
  const db = await openDb();
  const here = args.includes("--all-repos") ? null : repoIdentity(process.cwd());
  if (!args.includes("--all-repos") && !here) { console.error("This folder is not in a git repo. Run it inside one, or use --all-repos."); process.exitCode = 1; return; }
  const { branchesToGroup, groupHistory, getHistory } = await import("../plan/history.js");
  const repos = here ? [here] : (await db.execute("SELECT id FROM repos")).rows.map((r) => String(r.id));
  for (const repo of repos) for (const branch of await branchesToGroup(db, repo)) {
    try {
      // Keep going until the branch is done, a few batches per call to groupHistory.
      let n = 0, last = -1;
      while (n !== last) { last = n; n += await groupHistory(db, repo, branch, runner); }
      const h = await getHistory(db, repo, branch);
      console.log(`${repo.split("/").pop()} @ ${branch}: ${h.outcomes.length} outcome(s) from ${n} step(s), ${h.ungrouped.length} left ungrouped, ${h.decisions.filter((d) => d.why).length} decision(s) with reasons.`);
    } catch (e) { console.log(`${repo.split("/").pop()} @ ${branch}: couldn't group (${e instanceof Error ? e.message : String(e)}).`); }
    await saveUsage(db, runner, "plan history");
  }
}

/** `muninn plan`: this branch's plan, short, then where to change it. */
async function showPlan() {
  const { c, mark, next } = await import("../term.js");
  const { getPlan } = await import("../plan/plan.js");
  const { currentBranch } = await import("../handoff/handoff.js");
  const repo = repoIdentity(process.cwd());
  if (!repo) { console.log(`${mark.need()} This folder isn't in a git repo, and plans are kept per branch.\n${next("cd", "into a repo, then run muninn plan again")}`); return; }
  const branch = currentBranch(process.cwd()) ?? "main";
  const p = await getPlan(await openDb(), repo, branch);
  const out = [`${c.bold(`Plan for ${branch}`)}${c.dim(` · ${repo.split("/").pop()}`)}`, ""];
  if (!p.goal && !p.status && !p.open.length && !p.decisions.length) {
    out.push("No plan for this branch yet. secondnature builds one from your sessions here as you work.");
    console.log(out.join("\n")); return;
  }
  const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (p.goal) out.push(`${c.bold("Goal:")} ${p.goal.text}`);
  if (p.status) out.push(`${p.status.text} ${c.dim(`(${date(p.status.at)})`)}`);
  if (p.open.length) out.push("", c.bold(`Next · ${p.open.length}`), ...p.open.slice(0, 6).map((o, i) => `  ${i + 1}  ${o.text}`));
  if (p.decisions.length) out.push("", c.bold("Decided"), ...p.decisions.slice(0, 3).map((d) => `  ${c.dim(date(d.created_at))}  ${d.text}`));
  out.push("", c.dim("Agents get this when a session starts on this branch."), next("muninn ui", "to edit it"));
  console.log(out.join("\n"));
}
