import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readAntigravity } from "../src/logs/antigravity.js";
import { readClaude } from "../src/logs/claude-code.js";
import type { Session } from "../src/logs/types.js";
import { buildRuns, roleOf } from "../src/workflow/runs.js";
import { tmp, useHome, write } from "./helpers.js";

beforeEach(() => useHome());
const T = (m: number) => new Date(Date.UTC(2026, 10, 21, 10, m)).toISOString();

describe("subagent logs", () => {
  it("are read with their type and task, never as something you typed, with tokens per reply", () => {
    const dir = join(tmp(), "proj", "parent-1", "subagents");
    write(join(dir, "agent-a1.jsonl"), [
      { isSidechain: true, type: "user", cwd: "/r", timestamp: T(0), message: { role: "user", content: "Review the diff for bugs" } },
      { isSidechain: true, type: "assistant", timestamp: T(1), message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "Found one." }], usage: { input_tokens: 100, output_tokens: 20 } } },
      { isSidechain: true, type: "assistant", timestamp: T(1), message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }], usage: { input_tokens: 100, output_tokens: 20 } } },
    ]);
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "Review" }));
    const s = readClaude(join(dir, "agent-a1.jsonl"));
    expect(s).toMatchObject({ parent: "parent-1", agentType: "reviewer", task: "Review: Review the diff for bugs", usage: { input: 100, output: 20 } });
    expect(s.events.some((e) => e.k === "typed")).toBe(false);
    expect(s.events.map((e) => e.k)).toEqual(["agent"]);
  });
});

describe("Antigravity swarms", () => {
  it("read who started an agent, its assignment, and the board messages it posted", () => {
    const f = join(tmp(), "antigravity", "brain", "agent-b", ".system_generated", "logs", "transcript.jsonl");
    write(f, [
      { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", created_at: T(0), content: "<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=11111111-aaaa priority=HIGH content=[swarm] new board message #2 </SYSTEM_MESSAGE>" },
      { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", created_at: T(0), content: "<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=22222222-bbbb priority=HIGH content=You have just started. You are the Builder.</SYSTEM_MESSAGE>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: T(5), input_tokens: 50, output_tokens: 7, tool_calls: [{ name: "post_message", args: { text: JSON.stringify("@reviewer @qa [done] PR #2 opened\n- fix: guard null (M1 #4 follow-up)") } }] },
    ]);
    const s = readAntigravity(f);
    expect(s).toMatchObject({ parent: "22222222-bbbb", task: "You have just started. You are the Builder." });
    expect(s.messages?.filter((m) => m.dir === "out")).toEqual([{ ts: T(5), dir: "out", from: null, to: ["reviewer", "qa"], text: "@reviewer @qa [done] PR #2 opened\n- fix: guard null (M1 #4 follow-up)" }]);
  });
});

const session = (id: string, cwd: string, mins: number[], extra: Partial<Session> = {}): Session => ({
  id, tool: "claude-code", cwd, clientVersion: "1", unknown: 0,
  events: mins.map((m) => ({ k: "cmd", cmd: "ls", failed: false, output: "", ts: T(m) })), turns: mins.map((m) => ({ ts: T(m), input: 10, output: 5 })), ...extra,
});

describe("workflow runs", () => {
  let root = "";
  beforeEach(() => { root = join(tmp(), "shop"); mkdirSync(root); execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "x"]); });
  it("give worktree sessions their worktree's name as their role", () => {
    execFileSync("git", ["-C", root, "worktree", "add", "-q", join(root, ".worktrees", "builder")]);
    expect(roleOf(session("a", join(root, ".worktrees", "builder"), [0]))).toBe("builder");
    expect(roleOf(session("b", root, [0]))).toBe("main");
  });
  it("cut a session left open into bursts, and put a subagent in its parent's burst", () => {
    const sub = session("sub", root, [3, 4], { parent: "p", agentType: "reviewer" });
    const runs = buildRuns("r", [session("p", root, [0, 5, 200, 210], { subagents: [sub] })]);
    expect(runs.map((r) => r.roles)).toEqual([["main", "reviewer"], ["main"]]);
    expect(runs[0]!.team).toBe(true);
    expect(runs[0]!.tokens_out).toBe(5 * 2 + 5 * 2);
  });
  it("count approvals, send-backs and follow-up fixes from board messages", () => {
    const msg = (m: number, text: string) => ({ ts: T(m), dir: "out" as const, from: null, to: [...text.matchAll(/@([\w-]+)/g)].map((x) => x[1]!), text });
    const builder = session("b", root, [1, 2], { parent: "p", agentType: "builder", messages: [msg(2, "@reviewer [done] PR #2 opened\n- fix: null guard (M1 #4 follow-up)")] });
    const reviewer = session("v", root, [3], { parent: "p", agentType: "reviewer", messages: [msg(3, "@builder changes requested: missing tests")] });
    const qa = session("q", root, [4], { parent: "p", agentType: "qa", messages: [msg(4, "@builder [done] QA PASS on PR #2")] });
    const [run] = buildRuns("r", [session("p", root, [0, 5], { subagents: [builder, reviewer, qa] })]);
    expect(run!.handoffs.filter((h) => h.kind !== "started").map((h) => [h.from_role, h.kind])).toEqual([["builder", "rework"], ["reviewer", "review_rejected"], ["qa", "approved"]]);
    expect(run!.handoffs.find((h) => h.kind === "rework")!.note).toBe("- fix: null guard (M1 #4 follow-up)");
  });
});

describe("Claude Code agent teams", () => {
  it("read messages sent to teammates and received from them, whatever the undocumented field names", () => {
    const f = join(tmp(), "proj", "lead.jsonl");
    write(f, [
      { type: "user", cwd: "/r", timestamp: T(0), message: { role: "user", content: "build the app with a team" } },
      { type: "assistant", timestamp: T(1), message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "SendMessage", input: { to: "reviewer", message: "Please review PR #2", summary: "review PR 2" } }] } },
      { type: "user", timestamp: T(2), message: { role: "user", content: '<teammate-message teammate_id="reviewer">Changes requested: missing tests</teammate-message>' } },
    ]);
    const s = readClaude(f);
    expect(s.messages).toEqual([
      { ts: T(1), dir: "out", from: null, to: ["reviewer"], text: "Please review PR #2" },
      { ts: T(2), dir: "in", from: "reviewer", to: [], text: "Changes requested: missing tests" },
    ]);
    expect(s.events.filter((e) => e.k === "typed").map((e) => e.k === "typed" && e.text)).toEqual(["build the app with a team"]);
  });
  it("name teammates' sessions from muninn's team hooks, and show finished tasks as handoffs", async () => {
    const { openDb } = await import("../src/store/db.js");
    const { applyTeam, buildRuns, teamFacts } = await import("../src/workflow/runs.js");
    const db = await openDb();
    const ev = (session: string, event: string, teammate: string | null, subject: string | null) =>
      db.execute({ sql: "INSERT INTO team_events (ts,session,event,team,teammate,agent_type,task_id,subject) VALUES (?,?,?,?,?,?,?,?)", args: [T(3), session, event, "session-abc", teammate, null, subject ? "1" : null, subject] });
    await ev("mate-1", "TeammateIdle", "researcher", null);
    await ev("mate-1", "TaskCompleted", "researcher", "Compare three price feeds");
    const lead = session("lead", "/nowhere", [0, 5]); const mate = session("mate-1", "/nowhere", [2, 3]);
    applyTeam([lead, mate], await teamFacts(db));
    expect(mate.role).toBe("researcher");
    const [run] = buildRuns("r", [lead, mate]);
    expect(run!.roles).toEqual(["main", "researcher"]);
    expect(run!.handoffs.find((h) => h.from_role === "researcher")).toMatchObject({ evidence: "[done] Compare three price feeds" });
  });
});

describe("edges and roles in a run", () => {
  it("link each subagent to the session that started it, never to the sibling before it", () => {
    const subs = ["a", "b", "c"].map((id, i) => session(id, "/nowhere", [1 + i, 2 + i], { parent: "lead", agentType: ["explorer", "designer", "explorer"][i] }));
    const [run] = buildRuns("r", [session("lead", "/nowhere", [0, 9], { subagents: subs })]);
    expect(run!.handoffs.map((h) => `${h.from_role}→${h.to_role}:${h.kind}`)).toEqual(["main→explorer:started", "main→designer:started", "main→explorer:started"]);
    expect(run!.bounces).toBe(1);
  });
  it("read a general-purpose subagent's job from how its task opens", async () => {
    const { roleFromTask } = await import("../src/workflow/runs.js");
    expect(roleFromTask("Builder: implement the cart")).toBe("builder");
    expect(roleFromTask("Re-review the fix wave")).toBe("reviewer");
    expect(roleFromTask("Adversarial security review of mods: You are…")).toBe("reviewer");
    expect(roleFromTask("Verify Meta Marketing API: check the token")).toBe("verifier");
    expect(roleFromTask("Data migrator: move rows")).toBe("data migrator");
    expect(roleFromTask("Summarise the thread")).toBeNull();
    expect(roleOf(session("x", "/nowhere", [0], { parent: "p", agentType: "general-purpose", task: "Tester: run the suite" }))).toBe("tester");
    expect(roleOf(session("y", "/nowhere", [0], { parent: "p", agentType: "Explore", task: "Builder: x" }))).toBe("Explore");
  });
});

describe("Claude Code workflows", () => {
  it("read each workflow agent with its role, and the run's summary, and count its blocking rounds as send-backs", async () => {
    const { scanLogs } = await import("../src/logs/discover.js");
    const logs = tmp(); process.env.MUNINN_LOG_ROOT = logs;
    const repoDir = join(tmp(), "factory"); mkdirSync(repoDir); execFileSync("git", ["init", "-q", repoDir]);
    const proj = join(logs, "claude", "projects", "-factory");
    write(join(proj, "lead.jsonl"), [
      { type: "user", cwd: repoDir, timestamp: T(0), message: { role: "user", content: "run the factory for step 4" } },
      { type: "assistant", timestamp: T(1), message: { id: "m1", content: [{ type: "text", text: "Starting the workflow." }] } },
    ]);
    const agent = (id: string, label: string, m: number) => {
      const dir = join(proj, "lead", "subagents", "workflows", "wf_1");
      write(join(dir, `agent-${id}.jsonl`), [
        { isSidechain: true, type: "user", cwd: repoDir, timestamp: T(m), message: { role: "user", content: "You are part of a software factory." } },
        { isSidechain: true, type: "assistant", timestamp: T(m + 1), message: { id: `x${id}`, model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ]);
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: label, workflowPhase: label.startsWith("coder") ? "Build" : "Check", inWorkflowRun: true }));
    };
    agent("c1", "coder:step-4", 2); agent("r1", "review:step-4:r1", 5); agent("q1", "qa:step-4:r1", 5);
    mkdirSync(join(proj, "lead", "workflows"), { recursive: true });
    writeFileSync(join(proj, "lead", "workflows", "wf_1.json"), JSON.stringify({ runId: "wf_1", workflowName: "factory-step", status: "completed", startTime: Date.parse(T(1)), durationMs: 600000, agentCount: 3, totalTokens: 45, phases: [{ title: "Build" }, { title: "Check" }], logs: ["Round 1: 2 blocking", "Round 2: 0 blocking"] }));
    const scan = scanLogs();
    const lead = scan.sessions.find((s) => s.id === "lead")!;
    expect(lead.subagents?.map((s) => [s.role, s.workflow?.phase]).sort()).toEqual([["coder", "Build"], ["qa", "Check"], ["reviewer", "Check"]]);
    const runs = buildRuns("r", [lead]);
    const run = runs.find((r) => r.workflows?.length)!;
    expect(run.roles).toEqual(expect.arrayContaining(["main", "coder", "reviewer", "qa"]));
    expect(run.workflows![0]).toMatchObject({ name: "factory-step", agents: 3, logs: ["Round 1: 2 blocking", "Round 2: 0 blocking"], blocking_left: 0 });
    expect(run.sessions.find((x) => x.role === "reviewer")).toMatchObject({ workflow_id: "wf_1", phase: "Check", label: "review:step-4:r1" });
    const { blockingLeft } = await import("../src/workflow/runs.js");
    expect(blockingLeft(["Round 1: 7 blocking", "Round 3: 4 blocking"])).toBe(4);
    expect(blockingLeft(["Fix round 1: 2 blocking left", "Fix round 2: 0 blocking left"])).toBe(0);
    expect(run.handoffs.filter((h) => h.kind === "review_rejected")).toEqual([expect.objectContaining({ from_role: "reviewer", to_role: "coder", note: "factory-step: Round 1: 2 blocking" })]);
    delete process.env.MUNINN_LOG_ROOT;
  });
});

describe("role names from tasks", () => {
  it("take a name that is a role, not a description of the work", async () => {
    const { roleFromTask } = await import("../src/workflow/runs.js");
    expect(roleFromTask("Write final report: combine the findings")).toBeNull();
    expect(roleFromTask("Ledgerup deep dive: what they do")).toBeNull();
    expect(roleFromTask("product:step-4")).toBe("product");
    expect(roleFromTask("coder-fix:step-4:r2")).toBe("coder-fix");
  });
});

describe("sessions one session started and directed", () => {
  const root = "/no-git/wb";
  it("reads a desktop session start from the log, only when one started", () => {
    const f = join(tmp(), "proj", "coord.jsonl");
    write(f, [
      { type: "assistant", cwd: root, timestamp: T(0), message: { id: "m1", content: [
        { type: "tool_use", id: "s1", name: "mcp__ccd_session__start_session", input: { title: "Milestone 10", name: "m10-foundations" } },
        { type: "tool_use", id: "s2", name: "mcp__ccd_session__start_session", input: { title: "Just an idea", initiation: "own_initiative" } },
      ] } },
      { type: "user", timestamp: T(0), message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "s1", content: [{ type: "text", text: "Started session \"Milestone 10\" (session_id: local_abc-1, name: m10-foundations). It runs on its own." }] },
        { type: "tool_result", tool_use_id: "s2", content: [{ type: "text", text: "Proposed \"Just an idea\" (task_id: task_1)." }] },
      ] } },
    ]);
    expect(readClaude(f).launches).toEqual([{ ts: T(0), name: "m10-foundations", title: "Milestone 10", localId: "local_abc-1" }]);
  });

  it("names the starter coordinator and the started session by its name, with a started edge in that run only", () => {
    const coord = session("c", root, [0, 5, 100], { launches: [{ ts: T(1), name: "m10-foundations", title: "Milestone 10", localId: "local_x" }] });
    const child = session("k", `${root}/.claude/worktrees/mystifying-payne-2e557b`, [2, 20, 100]);
    const runs = buildRuns("r", [coord, child]);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.roles.sort()).toEqual(["coordinator", "m10-foundations"]);
    expect(runs[0]!.handoffs).toContainEqual(expect.objectContaining({ kind: "started", from_role: "coordinator", to_role: "m10-foundations", evidence: "Milestone 10" }));
    expect(runs[1]!.handoffs.filter((h) => h.kind === "started")).toEqual([]);
  });

  it("never shows a made-up worktree name as a role", () => {
    expect(roleOf(session("x", `${root}/.claude/worktrees/vibrant-dubinsky-9459df`, [0], { branch: "claude/vibrant-dubinsky-9459df" }))).toBe("side session");
    expect(roleOf(session("y", `${root}/.claude/worktrees/vibrant-dubinsky-9459df`, [0], { branch: "feat/fast-ingest" }))).toBe("fast-ingest");
    expect(roleOf(session("z", `${root}/.worktrees/builder`, [0]))).toBe("builder");
  });

  it("counts a message only in the run it was sent in, and a coordinator's hold is not a send-back", () => {
    const msg = { ts: T(200), dir: "out" as const, from: null, to: ["a12c31e9995aefda6", "a0810ed35d033c62b"], text: "Coordinator: please don't merge any more UI PRs until #39 lands" };
    const coord = session("c", root, [0, 5, 200], { messages: [msg] });
    const sub = session("agent-a12c31e9995aefda6", root, [1, 3], { parent: "c", agentType: "general-purpose", task: "Builder: UI pass" });
    coord.subagents = [sub];
    const runs = buildRuns("r", [coord]);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.handoffs.filter((h) => h.kind !== "started")).toEqual([]);
    const sent = runs[1]!.handoffs.filter((h) => h.kind !== "started");
    expect(sent).toEqual([expect.objectContaining({ kind: "handoff", from_role: "coordinator", to_role: "builder, a subagent" })]);
  });
});
