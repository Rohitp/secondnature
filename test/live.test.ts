import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askedWords, callTool } from "../src/mcp/server.js";
import { slugOf, workingNow, workingLines } from "../src/plan/live.js";
import { addItem, applyNotes, getPlan, planMarkdown } from "../src/plan/plan.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { ensureRepo } from "../src/store/lessons.js";
import { tmp, useHome, write } from "./helpers.js";

let root = ""; let repo = ""; let logs = "";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
beforeEach(async () => {
  useHome(); root = join(tmp(), "wb"); mkdirSync(root); execFileSync("git", ["init", "-q", "-b", "main", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
  logs = tmp(); process.env.MUNINN_LOG_ROOT = logs;
});
afterEach(() => { delete process.env.MUNINN_LOG_ROOT; });
const dirFor = (cwd: string) => join(logs, "claude", "projects", slugOf(cwd));

/** A coordinator on main that started "m12-ui-library" 30 minutes ago, which is still working on its own branch. */
function seedRun(opts: { coordQuietMin?: number } = {}) {
  const wt = join(root, ".claude", "worktrees", "clever-hertz-d53fb1"); mkdirSync(wt, { recursive: true });
  const coord = join(dirFor(root), "coord.jsonl");
  write(coord, [
    { type: "user", cwd: root, gitBranch: "main", timestamp: at(31), message: { role: "user", content: "Build milestone 12 with a session per part." } },
    { type: "assistant", cwd: root, gitBranch: "main", timestamp: at(30), message: { id: "m1", content: [{ type: "tool_use", id: "s1", name: "mcp__ccd_session__start_session", input: { title: "UI library", name: "m12-ui-library" } }] } },
    { type: "user", cwd: root, gitBranch: "main", timestamp: at(30), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "text", text: "Started session \"UI library\" (session_id: local_ui, name: m12-ui-library). It runs on its own." }] }] } },
  ]);
  const quiet = (opts.coordQuietMin ?? 30) * 60_000;
  utimesSync(coord, new Date(Date.now() - quiet), new Date(Date.now() - quiet));
  const child = join(dirFor(wt), "child.jsonl");
  write(child, [
    { type: "user", cwd: wt, gitBranch: "claude/clever-hertz-d53fb1", timestamp: at(29.5), message: { role: "user", content: "Build the UI component library." } },
    { type: "assistant", cwd: wt, gitBranch: "claude/clever-hertz-d53fb1", timestamp: at(1), message: { id: "m2", content: [{ type: "text", text: "Re-running the checks so 12.7 can merge, then the Overview screen. More detail follows here." }] } },
  ]);
  // One of its subagents, writing right now.
  write(join(dirFor(wt), "child", "subagents", "agent-a1.jsonl"), [
    { type: "user", cwd: wt, isSidechain: true, sessionId: "child", agentId: "a1", timestamp: at(0.5), message: { role: "user", content: "Reviewer: check PR #78 against the brief" } },
  ]);
  return { wt };
}

describe("working now", () => {
  it("lists the sessions a coordinator started, by their names, on the coordinator's plan, while the coordinator is quiet", async () => {
    seedRun();
    const rows = await workingNow(await openDb(), repo, "main");
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["coordinator", "m12-ui-library"]));
    const ui = rows.find((r) => r.name === "m12-ui-library")!;
    expect(ui).toMatchObject({ branch: "claude/clever-hertz-d53fb1", from: "log", doing: "Re-running the checks so 12.7 can merge, then the Overview screen." });
    expect(rows.find((r) => r.name === "coordinator")!.doing).toMatch(/Waiting on the sessions it started/);
    expect(rows.some((r) => r.kind === "subagent" && r.parent === "m12-ui-library")).toBe(true);
    // Another branch's plan doesn't list them.
    expect(await workingNow(await openDb(), repo, "feat/other")).toEqual([]);
  });

  it("uses the agent's own note over muninn's guess, wherever the note was written", async () => {
    seedRun();
    const db = await openDb();
    const out = await callTool(db, "plan_note", { repo, branch: "claude/clever-hertz-d53fb1", who: "m12-ui-library", text: "Waiting for 12.7 checks; the Overview screen is next.", state: "blocked" }, async () => null);
    expect(out).toMatch(/Noted under Working now/);
    const ui = (await workingNow(db, repo, "main")).find((r) => r.name === "m12-ui-library")!;
    expect(ui).toMatchObject({ from: "note", state: "blocked", doing: "Waiting for 12.7 checks; the Overview screen is next." });
    expect(workingLines([ui]).join("\n")).toMatch(/BLOCKED: Waiting for 12.7/);
  });

  it("shows notes for agents muninn can't see running, and drops old ones", async () => {
    const db = await openDb();
    await callTool(db, "plan_note", { repo, branch: "main", who: "coordinator", text: "Milestone 12 needs your Stripe test key before Budget can start.", state: "waiting" }, async () => null);
    await db.execute({ sql: "INSERT INTO plan_notes (repo_id,branch,who,state,text,at) VALUES (?,?,?,?,?,?)", args: [repo, "main", "old", "working", "Something from two days ago.", at(48 * 60)] });
    const rows = await workingNow(db, repo, "main");
    expect(rows.map((r) => [r.name, r.state])).toEqual([["coordinator", "waiting"]]);
  });

  it("is in get_plan and get_runs, and the plan only shows recent done items", async () => {
    seedRun();
    const db = await openDb();
    for (let i = 0; i < 14; i++) await addItem(db, repo, "main", "done", `Finished part ${i}`);
    const plan = await callTool(db, "get_plan", { repo, branch: "main" }, async () => null);
    expect(plan).toMatch(/## Working now\n\n- coordinator/);
    expect(plan).toMatch(/m12-ui-library on claude\/clever-hertz-d53fb1/);
    expect(plan).toMatch(/4 older done item\(s\) not shown/);
    const runs = await callTool(db, "get_runs", { repo }, async () => null);
    expect(runs).toMatch(/^RUNNING NOW/);
    // PLAN.md, written into the repo, leaves Working now out: it's stale as soon as it's committed.
    expect(planMarkdown(await getPlan(db, repo, "main"), "wb", "main")).not.toMatch(/Working now/);
  });

  it("folds agents' notes into the plan once one says a step is done, and only once", async () => {
    const db = await openDb();
    const open = await addItem(db, repo, "main", "open", "Build the Budget screen");
    let prompt = "", calls = 0;
    const runner = { name: "fake", run: (p: string) => { prompt = p; calls++; return JSON.stringify({ goal: "Ship the money screens", status: "The Budget screen is built; Overview is next.", next: [{ text: "Build the Overview screen" }], decisions: [], finished: [open!.slice(0, 8)], done: ["Built the Budget screen"] }); } };
    await callTool(db, "plan_note", { repo, branch: "main", who: "builder", text: "Building the Budget screen from the design." }, async () => null);
    // Only working notes: nothing to fold yet, and no AI call.
    expect(await applyNotes(db, repo, "main", runner)).toBe(false);
    const out = await callTool(db, "plan_note", { repo, branch: "main", who: "builder", text: "Finished the Budget screen; starting Overview next.", state: "done" }, async () => null);
    expect(out).toMatch(/folding it into the plan/);
    expect(await applyNotes(db, repo, "main", runner)).toBe(true);
    expect(prompt).toMatch(/builder \(done\): Finished the Budget screen/);
    const plan = await getPlan(db, repo, "main");
    expect(plan.open.map((o) => o.text)).toEqual(["Build the Overview screen"]);
    expect(plan.status?.text).toMatch(/Overview is next/);
    expect(plan.done.map((d) => d.text)).toContain("Build the Budget screen");
    // The same notes aren't folded in twice.
    expect(await applyNotes(db, repo, "main", runner)).toBe(false);
    expect(calls).toBe(1);
  });

  it("tells agents in get_plan to keep the plan current with plan_note", async () => {
    await addItem(await openDb(), repo, "main", "goal", "Ship it");
    const plan = await callTool(await openDb(), "get_plan", { repo, branch: "main" }, async () => null);
    expect(plan).toMatch(/call plan_note when you start a step/);
    expect(plan).not.toMatch(/Changes made here are overwritten/);
  });

  it("shows finished work in get_plan as grouped outcomes, with steps not grouped yet as they are", async () => {
    const db = await openDb();
    const a = await addItem(db, repo, "main", "done", "Added the Working now card");
    await addItem(db, repo, "main", "done", "Merged PR #83; its content is not logged");
    const plan = await getPlan(db, repo, "main");
    const md = planMarkdown(plan, "wb", "main", null, Date.now(), [{ title: "Shipped Working now", result: "The Plan page shows what each agent is doing.", ref: "PR #82", at: new Date().toISOString(), stepIds: [a!] }]);
    expect(md).toMatch(/- \[x\] Shipped Working now \(PR #82\): The Plan page shows what each agent is doing\./);
    expect(md).not.toMatch(/Added the Working now card/);
    expect(md).toMatch(/Merged PR #83/);
  });

  it("logs what agents asked in plain words, not ids", () => {
    expect(askedWords("open_results", { ids: ["1", "2"] })).toBe("Opened 2 search matches in full");
    expect(askedWords("review_lesson", { id: "a4f91c02", action: "keep", engineer_said: "keep that one" })).toBe('Keep a suggested lesson, because the engineer said "keep that one"');
    expect(askedWords("get_plan", {})).toBe("");
    expect(askedWords("search_history", { query: "why libsql" })).toBe("why libsql");
  });

  it("refuses a note without a sentence", async () => {
    await expect(callTool(await openDb(), "plan_note", { repo, who: "x", text: "ok" }, async () => null)).rejects.toThrow(/one plain sentence/);
  });
});
