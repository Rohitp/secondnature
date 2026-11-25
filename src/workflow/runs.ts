import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { effortMoments } from "../learn/signals.js";
import { costOf } from "./prices.js";
import { spanOf, type Session } from "../logs/types.js";

/**
 * A workflow run: sessions in one repo that worked at the same time or one after another, with each one's role.
 * A software factory's builder, reviewer and qa worktrees make one run with three roles; so do a session and the
 * subagents it started. A plain session on its own is a run with one role, "main".
 */
export type RunSession = {
  id: string; tool: string; role: string; branch: string | null; worktree: string | null; parent_session: string | null; agent_type: string | null;
  /** A separate session another one started in the desktop app: the starting session's id. */
  launched_by?: string;
  started_at: string; ended_at: string; tokens_in: number; tokens_out: number; cache_read: number; model: string | null;
  /** Model calls, and the name the app gave the session, when known. */
  steps?: number; title?: string;
  commands: number; failed_commands: number; task: string | null;
  /** Messages the engineer typed: 0 for a session that ran on its own. */
  typed: number;
  /** Estimated dollars at list price, from tokens and the model; null when the model's price isn't known. */
  cost_usd: number | null;
  /** For a Claude Code workflow agent: the workflow run, its phase ("Check") and its label ("review:step-4:r1"). */
  workflow_id?: string; phase?: string; label?: string;
};
export type Handoff = {
  from_role: string; to_role: string; at: string; kind: "started" | "handoff" | "review_rejected" | "approved" | "rework"; note?: string;
  /** A short quote or file path showing what was handed over: the message, the task the next role was given, or the last file the previous role changed. */
  evidence?: string;
};
export type Run = {
  id: string; repo_id: string; started_at: string; ended_at: string; roles: string[]; team: boolean;
  sessions: RunSession[]; handoffs: Handoff[];
  /** Times work went back to a role it had already left (builder → reviewer → builder is one). */
  bounces: number;
  /** Output tokens spent on failed retries, loops and re-reads. */
  wasted_tokens: number;
  tokens_in: number; tokens_out: number;
  /** Claude Code workflow runs inside this run: name, phases, agents, tokens, and its own log lines ("Round 1: 3 blocking"). */
  workflows?: { id: string; name: string; status: string; agents: number; tokens: number; phases: string[]; logs: string[]; blocking_left: number }[];
  /** Estimated dollars for the sessions whose model price is known; `cost_unpriced` counts the others. */
  cost_usd?: number; cost_unpriced?: number;
};

/** Sessions this far apart in time are separate runs. */
export const RUN_GAP_MS = 30 * 60_000;

const worktrees = new Map<string, string | null>();
/** The linked git worktree a folder is in ("builder" for .worktrees/builder), or null for the repo's main folder. */
export function worktreeOf(cwd: string): string | null {
  if (!cwd) return null;
  if (worktrees.has(cwd)) return worktrees.get(cwd)!;
  let name: string | null = null;
  try {
    const [dir, common, top] = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim().split("\n");
    // In a linked worktree, its own git folder differs from the one all worktrees share.
    if (dir && common && dir !== common && !dir.endsWith(common)) name = basename(top ?? cwd);
  } catch {
    name = cwd.match(/\/(?:\.worktrees|\.claude\/worktrees|worktrees)\/([^/]+)/)?.[1] ?? null;
  }
  worktrees.set(cwd, name);
  return name;
}
/** A session's role: a subagent's type, else the worktree it ran in, else "main". */
/** Job words a task can open with, and the role each means. */
const JOBS: [RegExp, string][] = [
  [/^re-?review/, "reviewer"], [/^review/, "reviewer"], [/^build|^implement/, "builder"], [/^test/, "tester"], [/^fix/, "fixer"],
  [/^verif/, "verifier"], [/^qa\b/, "qa"], [/^research|^investigat|^explor/, "researcher"], [/^check/, "checker"], [/^plan/, "planner"], [/^design/, "designer"], [/^audit/, "auditor"],
];
/**
 * A general-purpose subagent's real job, from how its task opens: "Builder: …" is a builder, "Re-review the fix
 * wave" a reviewer, "Adversarial security review of mods" a reviewer. A short "Name:" prefix is taken as it is;
 * otherwise the first job word in the first six words. Null when the task doesn't say.
 */
export function roleFromTask(task: string | undefined): string | null {
  if (!task) return null;
  const head = task.trim().split("\n")[0]!;
  const named = head.match(/^([A-Za-z][A-Za-z -]{1,24}?)\s*:/)?.[1]?.trim().toLowerCase();
  if (named && named.split(" ").length <= 3) {
    for (const w of named.split(" ")) { const hit = JOBS.find(([re]) => re.test(w)); if (hit) return hit[1]; }
    // A name that is a role ("coder", "data migrator", "product"), not a description of the work ("write final report").
    const words = named.split(" ");
    if (words.length === 1 || (words.length === 2 && /(er|or|ist|ant|ian)$/.test(words[1]!))) return named;
  }
  for (const w of head.toLowerCase().split(/[^a-z-]+/).filter(Boolean).slice(0, 6)) { const hit = JOBS.find(([re]) => re.test(w)); if (hit) return hit[1]; }
  return null;
}
const GENERIC = new Set(["general-purpose", "subagent", "fork", "agent", "workflow-subagent"]);
/** A worktree name the desktop app made up ("mystifying-payne-2e557b"): it says nothing about the work. */
export const MADE_UP = /^[a-z]+-[a-z]+-[0-9a-f]{6}$/;
/**
 * A session that directed others: it started sessions in the desktop app, or sent instructions to two or more agents.
 * Its role is "coordinator" rather than "main".
 */
export const coordinates = (s: Session) => !!s.launches?.length || new Set((s.messages ?? []).filter((m) => m.dir === "out" && s.tool === "claude-code").flatMap((m) => m.to)).size >= 2;
/** A top-level session in a worktree: the name it was started with, else a readable worktree or branch name, else "side session". */
function topRole(s: Session): string | null {
  if (s.launchedAs) return s.launchedAs;
  const wt = worktreeOf(s.cwd);
  if (!wt) return null;
  if (!MADE_UP.test(wt)) return wt;
  const branch = s.branch?.replace(/^[\w-]+\//, "");
  if (branch && branch !== wt && !MADE_UP.test(branch)) return branch;
  return roleFromTask(s.events.find((e) => e.k === "typed")?.text) ?? "side session";
}
export const roleOf = (s: Session) => s.teammate ?? (s.parent
  ? ((!s.agentType || GENERIC.has(s.agentType) ? roleFromTask(s.workflow?.label ?? s.task) : null) ?? s.agentType ?? worktreeOf(s.cwd) ?? "subagent")
  : topRole(s) ?? ((s.coordinator ?? coordinates(s)) ? "coordinator" : "main"));

/**
 * Links each session started from the desktop app to the session that started it. The app doesn't log the new
 * session's own id, so the link is by time: a top-level session in another folder whose log begins within two
 * minutes after the start. Pure apart from setting launchedAs and launchedBy.
 */
export function linkLaunched(sessions: Session[]) {
  const tops = sessions.filter((s) => !s.parent);
  for (const s of tops) s.coordinator = coordinates(s);
  const first = new Map(tops.map((s) => [s.id, [...s.events.map((e) => e.ts), ...(s.turns ?? []).map((t) => t.ts)].filter(Boolean).sort()[0] ?? ""]));
  const launches = tops.flatMap((s) => (s.launches ?? []).map((l) => ({ ...l, by: s }))).sort((a, b) => a.ts.localeCompare(b.ts));
  for (const l of launches) {
    const t = Date.parse(l.ts);
    const hit = tops.filter((c) => c !== l.by && !c.launchedBy && c.cwd !== l.by.cwd && first.get(c.id))
      .map((c) => ({ c, d: Date.parse(first.get(c.id)!) - t })).filter((x) => x.d >= -5_000 && x.d <= 120_000).sort((a, b) => a.d - b.d)[0];
    if (hit) { hit.c.launchedBy = l.by.id; hit.c.launchedAs = l.name || l.title || undefined; }
  }
}

/** Claude Code agent teams: names teammates' sessions from muninn's team hooks, and adds the tasks they finished as handoffs. */
export async function teamFacts(db: Client): Promise<{ names: Map<string, string>; done: { session: string; teammate: string | null; subject: string; ts: string }[] }> {
  const rows = (await db.execute("SELECT session, event, teammate, agent_type, subject, ts FROM team_events WHERE session IS NOT NULL ORDER BY ts").catch(() => ({ rows: [] }))).rows;
  const names = new Map<string, string>();
  for (const r of rows) { const n = r.teammate ?? (r.agent_type && r.agent_type !== "team-lead" ? r.agent_type : null); if (n && r.event === "TeammateIdle") names.set(String(r.session), String(n)); }
  return { names, done: rows.filter((r) => r.event === "TaskCompleted" && r.subject).map((r) => ({ session: String(r.session), teammate: r.teammate ? String(r.teammate) : null, subject: String(r.subject), ts: String(r.ts) })) };
}
/** Applies team facts to sessions before runs are built. */
export function applyTeam(sessions: Session[], f: Awaited<ReturnType<typeof teamFacts>>) {
  for (const s of sessions) for (const x of [s, ...(s.subagents ?? [])]) {
    const n = f.names.get(x.id); if (n) { x.teammate = n; x.role = n; }
    // A finished task becomes a message from that teammate, so runs show it as a handoff with its subject.
    for (const d of f.done.filter((d) => d.session === x.id)) (x.messages ??= []).push({ ts: d.ts, dir: "out", from: null, to: [], text: `[done] ${d.subject}` });
  }
}

/** A reviewer, checker or qa role sending work back. Read from what that role's agent said. */
export const REJECTS = /\b(changes requested|request(ed|ing)? changes|--request-changes|REQUEST_CHANGES|not ready to merge|(do not|don'?t) merge|(cannot|can'?t|won'?t) approve|\[reject(ed)?\]|\[blocked\]|\bI reject\b|reject(ed|ing)? (this|the|your) (pr|pull request|change|diff|patch|work|build)|blocking (issue|problem)s? (found|remain)|fails? (the )?(acceptance|review)|send(ing)? (it|this|the pr) back)/i;
export const REVIEWER = /review|check|qa|test|verif|audit|critic/i;
/** The sentence around a position in some text, for quoting why work went back. */
export function sentenceAround(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf(".", at - 1), text.lastIndexOf("\n", at - 1)) + 1;
  const ends = [".", "\n"].map((c) => text.indexOf(c, at)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, Math.min(end, start + 240)).replace(/\s+/g, " ").trim();
}

/** A slice of a session: what it did between two times. A session left open for days is several slices. */
type Slice = { s: Session; start: string; end: string };
const inSlice = (ts: string, from: string, to: string) => ts >= from && ts <= to;
/** A session cut into bursts of activity: a quiet gap longer than RUN_GAP_MS ends a burst. */
function bursts(s: Session): Slice[] {
  const ts = s.events.map((e) => e.ts).concat((s.turns ?? []).map((t) => t.ts), (s.messages ?? []).map((m) => m.ts), (s.launches ?? []).map((l) => l.ts)).filter(Boolean).sort();
  const out: Slice[] = [];
  for (const t of ts) {
    const cur = out.at(-1);
    if (cur && Date.parse(t) - Date.parse(cur.end) <= RUN_GAP_MS) cur.end = t; else out.push({ s, start: t, end: t });
  }
  return out;
}
/** A session limited to a slice of time. */
const sliceOf = (s: Session, from: string, to: string): Session => ({
  ...s, events: s.events.filter((e) => inSlice(e.ts, from, to)), turns: (s.turns ?? []).filter((t) => inSlice(t.ts, from, to)),
  // A message belongs to the run it was sent in, not to every run its session took part in.
  ...(s.messages ? { messages: s.messages.filter((m) => inSlice(m.ts, from, to)) } : {}),
  ...(s.launches ? { launches: s.launches.filter((l) => inSlice(l.ts, from, to)) } : {}),
});

function toRunSession(s: Session): RunSession {
  const { start, end } = spanOf(s);
  const cmds = s.events.filter((e) => e.k === "cmd");
  const turns = s.turns ?? [];
  const t0 = [start, turns[0]?.ts].filter(Boolean).sort()[0] ?? "";
  const t1 = [end, turns.at(-1)?.ts].filter(Boolean).sort().at(-1) ?? "";
  return {
    id: s.id, tool: s.tool, role: roleOf(s), branch: s.branch ?? null, worktree: s.parent ? null : worktreeOf(s.cwd), parent_session: s.parent ?? null, agent_type: s.agentType ?? null,
    ...(s.launchedBy ? { launched_by: s.launchedBy } : {}),
    started_at: t0, ended_at: t1, tokens_in: turns.reduce((n, t) => n + t.input, 0), tokens_out: turns.reduce((n, t) => n + t.output, 0), cache_read: turns.reduce((n, t) => n + (t.cacheRead ?? 0), 0), model: s.model ?? null, steps: turns.length, ...(s.title ? { title: s.title } : {}),
    commands: cmds.length, failed_commands: cmds.filter((e) => e.k === "cmd" && e.failed).length, task: s.task?.slice(0, 300) ?? null,
    typed: s.events.filter((e) => e.k === "typed").length,
    ...(s.workflow ? { workflow_id: s.workflow.id, ...(s.workflow.phase ? { phase: s.workflow.phase } : {}), ...(s.workflow.label ? { label: s.workflow.label } : {}) } : {}),
    cost_usd: costOf(s.model, { input: turns.reduce((n, t) => n + t.input, 0), output: turns.reduce((n, t) => n + t.output, 0), cacheRead: turns.reduce((n, t) => n + (t.cacheRead ?? 0), 0) }),
  };
}

/**
 * Groups a repo's sessions into runs. Each session is cut into bursts of activity; bursts in different sessions that
 * overlap or follow within RUN_GAP_MS make one run, and a subagent joins the run its parent was in when it started.
 * Pure: no database.
 */
export function buildRuns(repo: string, sessions: Session[]): Run[] {
  linkLaunched(sessions);
  // Every session and subagent in the repo, so a message to an agent working in another run still names its role.
  const everyone = sessions.flatMap((s) => [s, ...(s.subagents ?? [])]);
  const byId = new Map(everyone.map((s) => [s.id, s]));
  const byLocal = new Map(sessions.flatMap((s) => (s.launches ?? []).filter((l) => l.localId).map((l) => [l.localId!, sessions.find((x) => x.launchedBy === s.id && x.launchedAs === (l.name || l.title))] as const)).filter((x): x is [string, Session] => !!x[1]));
  // Subagents' own activity keeps a run going: a session that waits while a workflow or its subagents work is still in that run.
  const slices = sessions.flatMap((s) => [s, ...(s.subagents ?? [])]).flatMap(bursts).sort((a, b) => a.start.localeCompare(b.start));
  const groups: Slice[][] = [];
  let end = 0;
  for (const x of slices) {
    if (!groups.length || Date.parse(x.start) - end > RUN_GAP_MS) { groups.push([]); end = 0; }
    groups.at(-1)!.push(x);
    end = Math.max(end, Date.parse(x.end));
  }
  // Each workflow belongs to one run: the one it started in, else the first one holding one of its agents.
  const allWorkflows = sessions.flatMap((x) => x.workflowRuns ?? []).filter((w, i, arr) => arr.findIndex((v) => v.id === w.id) === i);
  const windows = groups.map((g) => ({ from: g[0]!.start, to: g.map((x) => x.end).sort().at(-1)!, ids: new Set(g.map((x) => x.s.workflow?.id).filter(Boolean)) }));
  const home = new Map<string, number>();
  for (const w of allWorkflows) {
    const i = windows.findIndex((x) => w.started >= x.from && w.started <= x.to);
    const j = i >= 0 ? i : windows.findIndex((x) => x.ids.has(w.id));
    if (j >= 0) home.set(w.id, j);
  }
  return groups.map((g, gi) => {
    const from = g[0]!.start, to = g.map((x) => x.end).sort().at(-1)!;
    const all: Session[] = [];
    for (const x of g) all.push(sliceOf(x.s, x.start, x.end));
    const rs = all.map(toRunSession).filter((r) => r.started_at && (r.tokens_out || r.commands || r.parent_session || r.ended_at > r.started_at)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const roles = [...new Set(rs.map((r) => r.role))];
    // Edges between roles, only from real signals:
    //   a subagent was started by its parent session ("started"), never by the sibling that started before it;
    //   a worktree role started work after another worktree role had finished ("handoff");
    //   swarm board posts, below. A return to a role already left is a bounce.
    const handoffs: Handoff[] = []; let bounces = 0;
    const roleById = new Map(rs.map((r) => [r.id, r.role]));
    for (const r of rs) if (r.parent_session) handoffs.push({ from_role: roleById.get(r.parent_session) ?? "main", to_role: r.role, at: r.started_at, kind: "started", evidence: r.task?.replace(/\s+/g, " ").slice(0, 200) || undefined });
    for (const r of rs) if (r.launched_by) {
      const by = byId.get(r.launched_by), l = by?.launches?.find((x) => (x.name || x.title) === r.role);
      // Only in the run it was started in: a session that keeps working into later runs wasn't started again.
      if (l && !inSlice(l.ts, from, to)) continue;
      handoffs.push({ from_role: roleById.get(r.launched_by) ?? (by ? roleOf(by) : "coordinator"), to_role: r.role, at: r.started_at, kind: "started", evidence: l?.title || undefined });
    }
    const order = (list: RunSession[]) => { const seen: string[] = []; for (const r of list) { if (seen.length && seen.at(-1) !== r.role && seen.includes(r.role)) bounces++; if (seen.at(-1) !== r.role) seen.push(r.role); } };
    order(rs.filter((r) => r.parent_session));
    const swarm = all.some((x) => x.messages?.some((m) => m.dir === "out"));
    if (!swarm) {
      const tops = rs.filter((r) => !r.parent_session && r.role !== "main");
      for (let i = 1; i < tops.length; i++) {
        const r = tops[i]!;
        const prev = tops.slice(0, i).filter((p) => p.role !== r.role && p.ended_at <= r.started_at).sort((a, b) => a.ended_at.localeCompare(b.ended_at)).at(-1);
        if (!prev) continue;
        const before = all.find((x) => x.id === prev.id);
        const lastFile = before ? [...before.events].reverse().find((e) => e.k === "file" && e.tool !== "read") as { path: string } | undefined : undefined;
        handoffs.push({ from_role: prev.role, to_role: r.role, at: r.started_at, kind: "handoff", evidence: (r.task ?? lastFile?.path ?? "").replace(/\s+/g, " ").slice(0, 200) || undefined });
      }
      order(tops);
    }
    // A reviewing role that said the work isn't ready sent it back.
    for (const s of all) {
      const role = roleOf(s);
      if (!REVIEWER.test(role)) continue;
      const said = s.events.find((e) => e.k === "agent" && REJECTS.test(e.text)) as { text: string; ts: string } | undefined;
      if (said) {
        const at = said.text.search(REJECTS);
        handoffs.push({ from_role: role, to_role: roles.find((x) => x !== role && x !== "main" && !REVIEWER.test(x)) ?? "main", at: said.ts, kind: "review_rejected", note: sentenceAround(said.text, at), evidence: said.text.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, " ") });
      }
    }
    // Swarm agents say who they're handing to: a board message mentioning @roles. Approvals, send-backs and follow-up fixes are read from it.
    for (const x of all) for (const m of x.messages ?? []) {
      if (m.dir !== "out") continue;
      const from = roleOf(x);
      // A recipient named by agent id (a subagent the session resumes) is shown by that agent's role.
      const to = m.to.map((r) => {
        const hit = all.find((y) => y.id === r || y.id === `agent-${r}`) ?? byId.get(r) ?? byId.get(`agent-${r}`) ?? byLocal.get(r);
        return hit ? roleOf(hit) : r.startsWith("local_") ? "another session" : /^a?[0-9a-f]{16,}$/.test(r) ? "a subagent" : r;
      }).filter((r) => r !== from && r !== "coordinator");
      let kind: Handoff["kind"] = /\bAPPROVE[D]?\b|LGTM|\[approved?\]|\b(QA|CHECK|ACCEPTANCE|TESTS?) PASS(ED)?\b/i.test(m.text) && !/\bnot approved?\b/i.test(m.text) ? "approved" : REJECTS.test(m.text) || /\[blocked\]/i.test(m.text) ? "review_rejected" : /follow-?up/i.test(m.text) ? "rework" : "handoff";
      // A coordinator telling an agent to hold or not merge is an instruction, not a review sending work back.
      if (from === "coordinator" && kind === "review_rejected") kind = "handoff";
      handoffs.push({ from_role: from, to_role: to.length > 2 ? "everyone" : to.join(", ") || "board", at: m.ts, kind, note: (kind === "rework" ? m.text.split("\n").find((l) => /follow-?up/i.test(l)) ?? m.text : m.text).replace(/^["\s]+/, "").replace(/(@[\w-]+\s*)+/, "").replace(/\s+/g, " ").slice(0, 160), evidence: m.text.replace(/^["\s]+/, "").replace(/(@[\w-]+\s*)+/, "").replace(/\s+/g, " ").slice(0, 200) });
    }
    // A workflow's own log lines say when a check round sent work back ("Round 1: 3 blocking").
    const workflows = allWorkflows.filter((w) => home.get(w.id) === gi);
    for (const w of workflows) {
      const agents = all.filter((x) => x.workflow?.id === w.id);
      const checker = agents.map(roleOf).find((r) => /review/.test(r)) ?? agents.map(roleOf).find((r) => REVIEWER.test(r)) ?? "reviewer";
      const maker = agents.map(roleOf).find((r) => /build|cod|fix|implement/.test(r)) ?? "main";
      for (const line of w.logs) {
        const n = Number(line.match(/(\d+)\s+blocking/i)?.[1] ?? 0);
        if (n > 0 || /changes requested|sent back|rejected/i.test(line)) handoffs.push({ from_role: checker, to_role: maker, at: w.started, kind: "review_rejected", note: `${w.name}: ${line}`, evidence: line });
      }
    }
    handoffs.sort((a, b) => a.at.localeCompare(b.at));
    const wasted = effortMoments(all).reduce((n, m) => n + (m.wasted ?? 0), 0);
    return {
      id: createHash("sha1").update(`${repo}\u0000${from}`).digest("hex").slice(0, 16), repo_id: repo,
      started_at: from, ended_at: [to, ...rs.map((r) => r.ended_at)].sort().at(-1)!, roles, team: roles.length > 1, sessions: rs, handoffs, bounces,
      wasted_tokens: wasted, tokens_in: rs.reduce((n, r) => n + r.tokens_in, 0), tokens_out: rs.reduce((n, r) => n + r.tokens_out, 0),
      ...(workflows.length ? { workflows: workflows.map(({ id, name, status, agents, tokens, phases, logs }) => ({ id, name, status, agents, tokens, phases, logs, blocking_left: blockingLeft(logs) })) } : {}),
      cost_usd: rs.reduce((n, r) => n + (r.cost_usd ?? 0), 0), cost_unpriced: rs.filter((r) => r.cost_usd === null && (r.tokens_in || r.tokens_out)).length,
    };
  });
}

/** Blocking issues a workflow's last check round left open ("Round 3: 4 blocking", "Fix round 2: 0 blocking left"). */
export function blockingLeft(logs: string[]): number {
  const last = [...logs].reverse().find((l) => /\d+\s+blocking/i.test(l));
  return Number(last?.match(/(\d+)\s+blocking/i)?.[1] ?? 0);
}

/** Stores a repo's runs, replacing earlier versions of the same runs. */
export async function saveRuns(db: Client, runs: Run[]) {
  // Runs are rebuilt from every session each scan: an earlier version of a regrouped run is replaced, not kept beside it.
  const byRepo = new Map<string, Run[]>();
  for (const r of runs) byRepo.set(r.repo_id, [...(byRepo.get(r.repo_id) ?? []), r]);
  for (const [repo, rs] of byRepo) {
    const since = rs.map((r) => r.started_at).sort()[0]!;
    const keep = new Set(rs.map((r) => r.id));
    const old = (await db.execute({ sql: "SELECT id FROM runs WHERE repo_id=? AND started_at>=?", args: [repo, since] })).rows.map((x) => String(x.id)).filter((id) => !keep.has(id));
    for (const id of old) await db.execute({ sql: "DELETE FROM runs WHERE id=?", args: [id] });
  }
  for (const r of runs) await db.execute({ sql: "INSERT OR REPLACE INTO runs (id,repo_id,started_at,ended_at,team,data) VALUES (?,?,?,?,?,?)", args: [r.id, r.repo_id, r.started_at, r.ended_at, r.team ? 1 : 0, JSON.stringify(r)] });
}
/** Recent runs, newest first. Takes a repo (null for all repos) or options. */
export async function listRuns(db: Client, o: { repo?: string | null; teamOnly?: boolean; limit?: number } | string | null = {}): Promise<Run[]> {
  const opts = typeof o === "string" || o === null ? { repo: o } : o;
  const where = [opts.repo ? "repo_id=?" : "1", opts.teamOnly ? "team=1" : "1"].join(" AND ");
  const rows = (await db.execute({ sql: `SELECT data FROM runs WHERE ${where} ORDER BY started_at DESC LIMIT ?`, args: [...(opts.repo ? [opts.repo] : []), opts.limit ?? 50] })).rows;
  return rows.map((r) => JSON.parse(String(r.data)) as Run);
}

/** muninn runs: recent workflow runs in this repo (or all repos), most recent first. */
/** "about $4.20", or "price unknown" for roles whose model muninn has no price for. */
export function dollars(ss: { cost_usd: number | null; tokens_in: number; tokens_out: number }[]): string {
  const priced = ss.filter((s) => s.cost_usd !== null), sum = priced.reduce((n, s) => n + (s.cost_usd ?? 0), 0);
  const unknown = ss.some((s) => s.cost_usd === null && (s.tokens_in || s.tokens_out));
  if (!priced.length) return unknown ? "price unknown" : "";
  return `about $${sum < 10 ? sum.toFixed(2) : Math.round(sum)}${unknown ? " plus some at an unknown price" : ""}`;
}
export async function runsCmd(db: Client, repo: string | null, opts: { all?: boolean } = {}) {
  const runs = await listRuns(db, { repo, teamOnly: !opts.all, limit: 15 });
  if (!runs.length) { console.log(opts.all ? "No runs yet. muninn groups sessions into runs when it scans." : "No runs with more than one role yet: a run needs subagents, or sessions in different worktrees. \"muninn runs --all\" shows single sessions too."); return; }
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  for (const r of runs) {
    const mins = Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000);
    console.log(`\n${r.started_at.slice(0, 16).replace("T", " ")}  ${repo ? "" : r.repo_id + "  "}${mins} min, ${r.sessions.length} session(s), roles: ${r.roles.join(", ")}`);
    const total = dollars(r.sessions.map((x) => ({ ...x, cost_usd: x.cost_usd ?? null })));
    console.log(`  tokens: ${k(r.tokens_in)} in, ${k(r.tokens_out)} out${total ? `, ${total}${total.startsWith("about") ? " at list price" : ""}` : ""}${r.wasted_tokens ? `, ${k(r.wasted_tokens)} on failed retries and re-reads` : ""}${r.bounces ? `, ${r.bounces} bounce(s) back to an earlier role` : ""}`);
    const byRole = new Map<string, RunSession[]>();
    for (const s of r.sessions) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
    for (const [role, ss] of byRole) {
      const out = ss.reduce((n, s) => n + s.tokens_out, 0), cmds = ss.reduce((n, s) => n + s.commands, 0), failed = ss.reduce((n, s) => n + s.failed_commands, 0);
      const cost = dollars(ss);
      console.log(`  ${role.padEnd(18)} ${ss.length} session(s), ${k(out)} tokens out, ${cmds} command(s)${failed ? `, ${failed} failed` : ""}${cost ? `, ${cost}` : ""}`);
    }
    const n = (k: Handoff["kind"]) => r.handoffs.filter((h) => h.kind === k).length;
    if (r.handoffs.length) console.log(`  between roles: ${n("handoff")} handoff(s), ${n("approved")} approval(s), ${n("review_rejected")} sent back, ${n("rework")} follow-up fix(es)`);
    for (const w of r.workflows ?? []) if (w.blocking_left) console.log(`  workflow ${w.name} ${w.status === "completed" ? "completed" : `ended (${w.status})`} with ${w.blocking_left} blocking issue(s) still open after its last check round`);
    for (const h of r.handoffs.filter((h) => h.kind === "review_rejected" || h.kind === "rework"))
      console.log(`  ${h.at.slice(11, 16)} ${h.from_role} ${h.kind === "rework" ? "fixed something raised earlier" : `sent work back to ${h.to_role}`}${h.note ? `: "${h.note.slice(0, 110)}"` : ""}`);
  }
}
