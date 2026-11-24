import { existsSync } from "node:fs";
import { isPaused, settings } from "../config.js";
import { syncCursor } from "../deliver/cursor.js";
import { age, currentBranch, latestHandoff, makeHandoff } from "../handoff/handoff.js";
import { aiOut, pickRunner, saveUsage } from "../learn/writer.js";
import { readAny } from "../logs/discover.js";
import { eventLine, isOwnRun } from "../logs/types.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";

/** `muninn handoff` shows where the last session on this branch left off. With --transcript, writes one (used by the SessionEnd hook). */
export async function handoff(args: string[]) {
  const i = args.indexOf("--transcript");
  if (i >= 0) {
    const file = args[i + 1] ?? "";
    if (isPaused() || !existsSync(file)) return;
    const s = readAny(file);
    if (isOwnRun(s)) return;
    const runner = pickRunner("background");
    // Out of AI usage: no handoff now. The next scan after it's back writes handoffs for sessions that ended without one.
    if (!runner || aiOut()?.provider === runner.name) return;
    const db = await openDb();
    try {
      // A long session (or one already checkpointed) first gets its uncovered part folded in, piece by piece,
      // so early work isn't lost to a handoff that only reads the end.
      const { checkpoint } = await import("../handoff/checkpoint.js");
      const covered = (await db.execute({ sql: "SELECT 1 FROM checkpoints WHERE session=? LIMIT 1", args: [s.id] })).rows.length > 0;
      const size = s.events.reduce((n, e) => n + eventLine(e).length, 0);
      if (covered || size > 14_000) await checkpoint(db, s, runner, { file }).catch(() => 0);
      const h = await makeHandoff(db, s, runner);
      if (h) {
        // Fold the session into the repo's running plan, then refresh the files that carry it.
        const { applyHandoff, writePlanFile } = await import("../plan/plan.js");
        try { await applyHandoff(db, h, runner); await writePlanFile(db, h.repo_id); } catch { /* the next learn catches up */ }
        await syncCursor(db);
      }
    }
    finally { await saveUsage(db, runner, "handoff"); }
    return;
  }
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  if (!repo) { console.error("Run this inside a git repo."); process.exitCode = 1; return; }
  if (args.includes("--list")) {
    const rows = (await db.execute({ sql: "SELECT branch,tool,created_at,text FROM handoffs WHERE repo_id=? ORDER BY created_at DESC LIMIT 10", args: [repo] })).rows;
    if (!rows.length) { console.log("No handoffs for this repo yet."); return; }
    for (const r of rows) console.log(`\n${r.branch} · ${r.tool} · ${age(String(r.created_at))}\n${r.text}`);
    return;
  }
  const branch = currentBranch(process.cwd()) ?? "unknown";
  const h = await latestHandoff(db, repo, branch, settings().handoffDays);
  if (!h) { console.log(`No handoff on ${branch} yet. One is written when a session on this branch ends.`); return; }
  console.log(`${h.branch} · ${h.tool} · ${age(h.created_at)}\n${h.text}`);
}

/** `muninn checkpoint --transcript <file>`: the plan update during a session (run by the Stop and PreCompact hooks). */
export async function checkpointCmd(args: string[]) {
  const i = args.indexOf("--transcript");
  const file = i >= 0 ? args[i + 1] ?? "" : "";
  if (isPaused() || !existsSync(file)) return;
  const s = readAny(file);
  if (isOwnRun(s)) return;
  const runner = pickRunner("background");
  if (!runner) return;
  const db = await openDb();
  const { checkpoint } = await import("../handoff/checkpoint.js");
  const { writePlanFile } = await import("../plan/plan.js");
  try {
    if (await checkpoint(db, s, runner, { file })) {
      const { repoIdentity: id } = await import("../repo/identity.js");
      const repo = s.cwd ? id(s.cwd) : null;
      if (repo) await writePlanFile(db, repo).catch(() => null);
      await syncCursor(db);
    }
  } finally { await saveUsage(db, runner, "plan update"); }
}
