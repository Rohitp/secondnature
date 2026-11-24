import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gatherSources, type Source } from "../commands/answer.js";
import { insightsData, insightsText } from "../commands/insights.js";
import { loadEmbedder, modelCached, type Embed } from "../embed/model.js";
import { currentBranch } from "../handoff/handoff.js";
import { getPlan, planMarkdown } from "../plan/plan.js";
import { repoIdentity } from "../repo/identity.js";
import { openDb } from "../store/db.js";
import { createLesson } from "../store/lessons.js";
import { recordQuery, toolFromClient } from "../store/queries.js";

/**
 * muninn as an MCP server, so you can ask about your own work from any chat with Claude (the desktop app,
 * Claude Code, Cursor): what was decided, what was done, how something was solved before. It reads what muninn
 * keeps; the one thing it writes is a suggested lesson, which waits for your review like any other.
 */
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const repoArg = { type: "string", description: "A repo's name as muninn lists it (for example \"servanda\"). Leave out for the repo the chat is running in, if any, else all repos." };
// Each description opens with when to call it, in the moments an agent is in, because that's what makes an agent reach
// for a tool: "the engineer says 'last time'", not "searches the history". All are local and fast; only three write anything.
const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const TOOLS = [
  {
    name: "search_history",
    title: "Search past work",
    description: "Use this before answering or acting on anything that depends on earlier work in this repo: when the engineer says \"like last time\", \"we decided\", \"why did we…\", \"how did we fix…\", names something you don't see explained in the code, or when you're about to try a fix that may have been tried before. It searches what git and the code don't keep: past coding-agent conversations (what was asked, what the agent said and ran, what failed), the lessons the engineer kept, and the branch plan's decisions. Finds by meaning and by words, in under a second. Each match comes back as one short line; open the ones you need in full with open_results. Cite what you use, with its date.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for, in plain words, e.g. \"why we pinned the libsql version\"." }, repo: repoArg, all_repos: { type: "boolean", description: "Search every repo, for something done in another project." } }, required: ["query"] },
    annotations: READ,
  },
  {
    name: "open_results",
    title: "Open search results in full",
    description: "Use this after search_history, when a match's one-line preview looks relevant and you need the whole of it before relying on it: the full exchange, lesson, decision or note. Open only the matches you need, not all of them.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "The ids search_history showed (or the [n] numbers from the latest search), at most 5." } }, required: ["ids"] },
    annotations: READ,
  },
  {
    name: "where_left_off",
    title: "Where the last session left off",
    description: "Call this at the start of work on a branch, or after the conversation was compressed, before planning anything, then get_plan: it says what the last coding-agent session on the branch was doing, what it finished, what was left, and what it was about to do next. Also when the engineer asks \"where are we?\" or \"what's next?\". Once you pick the work up, say so with plan_note.",
    inputSchema: { type: "object", properties: { repo: repoArg, branch: { type: "string", description: "Branch name. Leave out for the branch checked out, else main." } } },
    annotations: READ,
  },
  {
    name: "get_plan",
    title: "The branch's plan",
    description: "Use this when deciding what to do next on a branch, or before changing direction: the branch's goal, where it stands, what's next, the decisions made along the way (with dates, so you don't undo one), and what's done. Kept by muninn from the engineer's sessions. As you work from it, call plan_note when you start a step, finish one, make a decision or get stuck, so the plan stays current.",
    inputSchema: { type: "object", properties: { repo: repoArg, branch: { type: "string", description: "Branch name. Leave out for the branch checked out, else main." } } },
    annotations: READ,
  },
  {
    name: "list_lessons",
    title: "Lessons the engineer kept",
    description: "Use this when you're unsure how the engineer wants something done here (conventions, workflow, how to explain things), or when they ask what agents are told. Lists the lessons the engineer kept for coding agents: the instruction, why it was kept, when agents are told it (every session, on a keyword, or only when searched, so some you were never told), the role it's for, and whether it has worked. Also the suggestions waiting for their review.",
    inputSchema: { type: "object", properties: { repo: repoArg, all_repos: { type: "boolean" }, waiting: { type: "boolean", description: "Only the suggestions waiting for review." } } },
    annotations: READ,
  },
  {
    name: "get_related",
    title: "What a decision connects to",
    description: "Use this before changing or reverting something that was decided on purpose, or when asked \"what did X affect?\" or \"why was Y built?\": the outcomes a decision led to, the decisions behind a piece of work, the sessions it was discussed and built in, its commits, and the files those sessions touched. Then check the code itself for what's affected today.",
    inputSchema: { type: "object", properties: { about: { type: "string", description: "The decision or work, in plain words." }, repo: repoArg, all_repos: { type: "boolean" } }, required: ["about"] },
    annotations: READ,
  },
  {
    name: "get_week",
    title: "The engineer's recent week",
    description: "Use this when the engineer asks how their week went, what they worked on, or where time was lost: recent sessions, effort wasted (loops, repeated failures, wrong paths), whether kept lessons helped, and what's waiting for their review.",
    inputSchema: { type: "object", properties: { repo: repoArg, all_repos: { type: "boolean" }, days: { type: "number", description: "How many days back; default 7." } } },
    annotations: READ,
  },
  {
    name: "get_runs",
    title: "How agent teams did",
    description: "Use this before starting or reviewing autonomous work with several agents (subagents, workflows, an agent swarm, builder/reviewer/qa worktrees), or when asked how such a run went. For each recent run: time, tokens and cost per role, failures, approvals, work sent back, fixes needed after approval, idle gaps, and muninn's findings. Also whether lessons kept for one role have worked since.",
    inputSchema: { type: "object", properties: { repo: repoArg, all_repos: { type: "boolean" }, limit: { type: "number", description: "How many recent runs; default 5." }, include_single: { type: "boolean", description: "Also runs with only one role (a plain session)." } } },
    annotations: READ,
  },
  {
    name: "list_repos",
    title: "Repos muninn knows",
    description: "Use this when the engineer mentions another project by name and you need muninn's name for it (for the repo argument of the other tools), or asks which repos muninn knows: each with its kept lessons, suggestions waiting and stored sessions.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
  {
    name: "suggest_lesson",
    title: "Suggest a lesson",
    description: "Use this when the engineer says something should be remembered for future agents (\"remember that…\", \"from now on…\", \"agents should always…\"), or corrects you on something a future agent would get wrong too. It goes into the engineer's review queue; nothing reaches an agent until they keep it. Write it as an instruction to an agent, in one or two plain sentences.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, repo: repoArg, everywhere: { type: "boolean", description: "True if it applies in every repo, like how to explain things." } }, required: ["text"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "plan_note",
    title: "Say what an agent is doing now",
    description: "Use this to keep the branch's plan current as you work, whether you work alone or run other agents (sessions you started, subagents, workflows, a builder/reviewer team). Call it when you start a step, finish one (state done), make a decision the engineer should know about, or get stuck or need the engineer; for other agents, when each starts, finishes, is blocked or changes what it's doing. One plain sentence, saying what is happening and why, as you'd tell a colleague who just walked in (\"Building the Budget screen; the Overview screen is merged.\"), not a log line, and without ids, hashes or tool names. Its newest note replaces its older one and shows under Working now in the branch's plan (get_plan, muninn ui). A done note also makes muninn rewrite the plan's next steps and where it stands from the notes, in the background.",
    inputSchema: { type: "object", properties: {
      who: { type: "string", description: "The agent: the name you gave the session or subagent when you started it (\"m12-ui-library\", \"reviewer\"), or your own role (\"coordinator\", or \"builder\" when you work alone)." },
      text: { type: "string", description: "One plain sentence, under 200 characters." },
      state: { type: "string", enum: ["working", "blocked", "waiting", "done"], description: "waiting: it needs the engineer. blocked: it's stuck on something else. Default working." },
      repo: repoArg, branch: { type: "string", description: "The plan to add it to. Leave out for the branch checked out here, which for a coordinator is the plan the engineer reads." },
    }, required: ["who", "text"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "review_lesson",
    title: "Keep, dismiss or fold in a suggested lesson",
    description: "Keep or dismiss a lesson waiting for the engineer's review, by the id list_lessons shows, or add it to the older lesson list_lessons says it is close to. Only when the engineer has said, in this chat, to do that to that specific lesson: never on your own judgement, and never for several lessons from one general instruction. Keeping makes agents be told it, with muninn's usual choice of when (every session, or on a keyword). add_to_older retires the suggestion and changes the older lesson, which keeps where it's told: if that lesson is told in every repo, the change reaches every repo, so say so and agree its new wording with the engineer first.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "The lesson's id or its first 8 characters, as list_lessons shows it." },
      action: { type: "string", enum: ["keep", "dismiss", "add_to_older"] },
      text: { type: "string", description: "For add_to_older: the older lesson's new wording, as agreed with the engineer. Leave out to keep its words and only add the suggestion's quotes." },
      engineer_said: { type: "string", description: "The engineer's own words in this chat asking for this, quoted." },
    }, required: ["id", "action", "engineer_said"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

/** Sent once when a chat connects; clients that show it put it in the agent's instructions. */
export const MCP_INSTRUCTIONS = [
  "muninn keeps the engineer's coding history that git and the code don't: past coding-agent conversations, the lessons they kept for agents, branch plans and their decisions, and runs where agents worked together. It's local and answers in under a second, so check it rather than guess.",
  "- Starting on a branch, or after the conversation was compressed: where_left_off, then get_plan.",
  "- The engineer refers to earlier work (\"last time\", \"we decided\", \"why did we\"), or you're about to retry a fix that may have failed before: search_history, then open_results for the matches you need.",
  "- Unsure how the engineer wants something done: list_lessons.",
  "- About to undo something decided on purpose: get_related.",
  "- They ask for something to be remembered: suggest_lesson (they review it first).",
  "- Working from the plan: plan_note when you start a step, finish one, make a decision or get stuck, one plain sentence each. Running other agents (sessions you started, subagents, workflows): also when each one starts, finishes, is blocked or needs the engineer. The engineer reads these in the plan, and done notes update its next steps.",
].join("\n");
type Args = Record<string, unknown>;
/** The installed package's version, for the server's own info. */
function packageVersion(): string {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version ?? "0"; } catch { return "0"; }
}
/** The repo a call means: one named (full id or the short name muninn shows), else the chat's own folder, else none. */
export async function resolveRepo(db: Client, a: Args, cwd = process.cwd()): Promise<string | null> {
  if (a.all_repos === true) return null;
  const named = typeof a.repo === "string" ? a.repo.trim() : "";
  if (named) {
    const ids = (await db.execute("SELECT id FROM repos")).rows.map((r) => String(r.id));
    const hit = ids.find((id) => id === named || id.split("/").filter(Boolean).pop()?.toLowerCase() === named.toLowerCase());
    if (!hit) throw new Error(`muninn doesn't know a repo called "${named}". Known: ${ids.map((i) => i.split("/").pop()).join(", ")}.`);
    return hit;
  }
  return repoIdentity(cwd);
}

/** What a tool call found, for the log of agents' questions. Handlers add to it. */
export type Found = import("../store/queries.js").ResultRef[];
const KIND: Record<string, Found[number]["kind"]> = { lesson: "lesson", note: "note", decision: "plan", done: "plan", goal: "plan", session: "session", handoff: "handoff" };

// Search answers with a short preview of each match, and the agent opens only the ones it needs, the way
// Anthropic's code-execution write-up loads detail on demand: ten full matches cost about 4,000 tokens, most unread.
/** Characters of a match's preview in search_history. */
export const PREVIEW = 200;
/** Characters of one match opened in full. Most stored exchanges fit; longer ones end with a note saying so. */
export const FULL = 8000;
/** Cuts at a line or sentence break, never mid-word, and says how much was left out so the agent doesn't take it as whole. */
export const cutClean = (t: string, max: number) => {
  if (t.length <= max) return t;
  const brk = Math.max(t.lastIndexOf("\n", max), t.lastIndexOf(". ", max) + 1);
  const space = t.lastIndexOf(" ", max);
  const at = brk > max * 0.6 ? brk : space > max * 0.6 ? space : max;
  return `${t.slice(0, at).trimEnd()}\n[Cut here: ${(t.length - at).toLocaleString("en-GB")} more characters not shown.]`;
};
export const preview = (t: string) => { const one = t.replace(/\s+/g, " ").trim(); return one.length > PREVIEW ? one.slice(0, PREVIEW - 1) + "…" : one; };
/** Matches from this server's searches, by id, so open_results gives back what the search found (with its links). */
const opened = new Map<string, Source>();
let lastSearch: Source[] = [];
function remember(hits: Source[]) {
  lastSearch = hits;
  for (const h of hits) { opened.delete(h.id); opened.set(h.id, h); }
  while (opened.size > 300) opened.delete(opened.keys().next().value!);
}
/** A match's text from the store, for an id from an earlier server (after a restart): a lesson or note, a stored exchange or plan item, or a handoff. */
async function lookUp(db: Client, id: string): Promise<string | null> {
  for (const sql of ["SELECT text FROM lessons WHERE id=?", "SELECT text FROM chunks WHERE id=?", "SELECT text FROM handoffs WHERE id=?"]) {
    try { const r = (await db.execute({ sql, args: [id] })).rows[0]; if (r) return String(r.text); } catch { /* an older store without the table */ }
  }
  return null;
}
export async function callTool(db: Client, name: string, a: Args, embed: () => Promise<Embed | null>, found: Found = []): Promise<string> {
  if (name === "list_repos") {
    const rows = (await db.execute("SELECT r.id, (SELECT count(*) FROM lessons l WHERE l.repo_id=r.id AND l.status='live') kept, (SELECT count(*) FROM lessons l WHERE l.repo_id=r.id AND l.status='proposed') waiting, (SELECT count(DISTINCT session) FROM chunks c WHERE c.repo_id=r.id AND c.tool!='plan') sessions FROM repos r ORDER BY r.id")).rows;
    for (const r of rows) found.push({ kind: "repo", id: String(r.id) });
    return rows.map((r) => `${String(r.id).split("/").pop()} (${r.id}): ${r.kept} kept lesson(s), ${r.waiting} waiting, ${r.sessions} stored session(s)`).join("\n") || "muninn doesn't know any repos yet.";
  }
  const repo = await resolveRepo(db, a);
  if (name === "search_history") {
    const q = String(a.query ?? "").trim();
    if (!q) throw new Error("Give a query.");
    const e = await embed();
    if (!e) throw new Error("muninn's local model isn't downloaded yet. Run \"muninn learn --all-repos\" once in a terminal.");
    const hits = await gatherSources(db, q, repo, e, { limit: 10 });
    for (const h of hits) found.push({ kind: KIND[h.kind] ?? "session", id: h.kind === "session" ? String(h.session ?? h.id) : h.id });
    if (!hits.length) return `Nothing muninn keeps${repo ? ` for ${repo.split("/").pop()}` : ""} matches "${q}".${repo ? " Try all_repos." : ""}`;
    remember(hits);
    return [`${hits.length} match(es), best first. Each shows its start; open the ones you need with open_results.`,
      ...hits.map((s) => `[${s.n}] ${s.kind.toUpperCase()} · ${s.where}${s.date ? ` · ${s.date}` : ""} · id ${s.id}\n${preview(s.text)}`)].join("\n");
  }
  if (name === "open_results") {
    const ids = (Array.isArray(a.ids) ? a.ids : [a.ids]).map((x) => String(x ?? "").trim().replace(/^\[(\d+)\]$/, "$1")).filter(Boolean).slice(0, 5);
    if (!ids.length) throw new Error("Give the ids search_history showed.");
    const out: string[] = [];
    for (const id of ids) {
      const s = /^\d+$/.test(id) ? lastSearch[Number(id) - 1] : opened.get(id);
      const text = s?.text ?? await lookUp(db, id);
      if (text === null) { out.push(`${id}: not found. Run search_history again and use the ids it shows.`); continue; }
      if (s) found.push({ kind: KIND[s.kind] ?? "session", id: s.kind === "session" ? String(s.session ?? s.id) : s.id });
      out.push(`${s ? `${s.kind.toUpperCase()} · ${s.where}${s.date ? ` · ${s.date}` : ""} · ` : ""}id ${s?.id ?? id}\n${cutClean(text, FULL)}`);
    }
    return out.join("\n\n");
  }
  if (name === "get_plan") {
    if (!repo) throw new Error("Say which repo: the chat isn't running inside one.");
    const branch = typeof a.branch === "string" && a.branch ? a.branch : (currentBranch(process.cwd()) && repoIdentity(process.cwd()) === repo ? currentBranch(process.cwd())! : "main");
    const plan = await getPlan(db, repo, branch);
    found.push({ kind: "plan", id: `${repo}#${branch}` });
    const { workingNow, workingLines } = await import("../plan/live.js");
    const working = await workingNow(db, repo, branch).then(workingLines).catch(() => []);
    const { getHistory } = await import("../plan/history.js");
    const outcomes = await getHistory(db, repo, branch).then((h) => h.outcomes.map((o) => ({ title: o.title, result: o.result, ref: o.ref, at: o.at, stepIds: o.steps.map((x) => x.id) }))).catch(() => null);
    return planMarkdown(plan, repo.split("/").pop() ?? repo, branch, working, Date.now(), outcomes);
  }
  if (name === "plan_note") {
    if (!repo) throw new Error("Say which repo: the chat isn't running inside one.");
    const { setNote, NOTE_STATES } = await import("../plan/live.js");
    const who = String(a.who ?? "").trim(); const text = String(a.text ?? "").trim();
    if (!who) throw new Error("Say who the note is about: the name you gave the session or subagent, or your own role.");
    if (text.length < 8) throw new Error("Write one plain sentence on what it is doing.");
    const state = NOTE_STATES.includes(a.state as never) ? (a.state as (typeof NOTE_STATES)[number]) : "working";
    const branch = typeof a.branch === "string" && a.branch ? a.branch : (currentBranch(process.cwd()) && repoIdentity(process.cwd()) === repo ? currentBranch(process.cwd())! : "main");
    await setNote(db, { repo_id: repo, branch, who, state, text });
    found.push({ kind: "plan", id: `${repo}#${branch}` });
    if (state === "done") { const { startNotesFold } = await import("../commands/auto.js"); startNotesFold(repo, branch); }
    return `Noted under Working now in the ${branch} plan: ${who}${state === "working" ? "" : ` (${state})`}: ${text.slice(0, 240)}${state === "done" ? "\nmuninn is folding it into the plan's next steps and where it stands now." : ""}`;
  }
  if (name === "get_related") {
    const e = await embed();
    if (!e) throw new Error("muninn's local model isn't downloaded yet. Run \"muninn learn --all-repos\" once in a terminal.");
    const { relatedText } = await import("../links/links.js");
    const text = await relatedText(db, String(a.about ?? ""), repo, e);
    if (!text.startsWith("Found no")) found.push({ kind: "link", id: String(a.about ?? "").slice(0, 80) });
    return text;
  }
  if (name === "get_week") return insightsText(await insightsData(db, repo, typeof a.days === "number" ? a.days : 7));
  if (name === "suggest_lesson") {
    const text = String(a.text ?? "").trim();
    if (text.length < 8) throw new Error("Write the lesson as a sentence or two.");
    const global = a.everywhere === true;
    if (!repo && !global) throw new Error("Say which repo it's for, or set everywhere.");
    const id = await createLesson(db, { repo_id: global ? null : repo, scope: global ? "global" : "repo", text: text.slice(0, 1000), source: "own_words", status: "proposed", suggestedScope: global ? "global" : "repo", by: "mcp" });
    found.push({ kind: "lesson", id });
    return `Added to the engineer's suggestions (${id.slice(0, 8)}). Nothing reaches an agent until they keep it in muninn ui or with "muninn review".`;
  }
  if (name === "review_lesson") {
    const said = String(a.engineer_said ?? "").trim();
    if (said.length < 2) throw new Error("Quote what the engineer said asking for this. muninn changes what agents are told only when they ask.");
    const { getLesson, decide } = await import("../store/lessons.js");
    const l = await getLesson(db, String(a.id ?? "").trim());
    if (!l) throw new Error("No lesson with that id. list_lessons shows the ids.");
    found.push({ kind: "lesson", id: l.id });
    if (l.status !== "proposed") throw new Error(`That lesson isn't waiting for review: it's ${l.status === "live" ? "already kept" : l.status}.`);
    if (a.action === "dismiss") { await decide(db, l.id, { status: "rejected" }); await db.execute({ sql: "INSERT INTO lesson_versions (id,lesson_id,snapshot,changed_by,changed_at) VALUES (lower(hex(randomblob(16))),?,?,?,?)", args: [l.id, JSON.stringify({ status: "rejected", said }), "mcp", new Date().toISOString()] }); return `Dismissed: "${l.text.slice(0, 120)}". muninn won't suggest it again.`; }
    if (a.action === "add_to_older") {
      const { similar } = await import("../commands/review.js");
      const sim = await similar(db, l);
      if (!sim) throw new Error("muninn doesn't see an older lesson close to this one. Keep or dismiss it instead.");
      const { addToOlder } = await import("../store/lessons.js");
      const text = typeof a.text === "string" && a.text.trim() ? a.text.trim().slice(0, 1000) : undefined;
      await addToOlder(db, l.id, sim.lesson.id, text);
      await db.execute({ sql: "INSERT INTO lesson_versions (id,lesson_id,snapshot,changed_by,changed_at) VALUES (lower(hex(randomblob(16))),?,?,?,?)", args: [l.id, JSON.stringify({ status: "retired", added_to: sim.lesson.id, said }), "mcp", new Date().toISOString()] });
      found.push({ kind: "lesson", id: sim.lesson.id });
      try { const { syncCursor } = await import("../deliver/cursor.js"); await syncCursor(db); } catch { /* rules files are a convenience */ }
      return `Added to the older lesson [${sim.lesson.id.slice(0, 8)}]${text ? `, which now says: "${text.slice(0, 300)}"` : ", with its words unchanged"}. It's still told in ${sim.lesson.scope === "global" ? "every repo" : short(String(sim.lesson.repo_id))}. The suggestion is gone from the review list.`;
    }
    if (a.action !== "keep") throw new Error("action is keep, dismiss or add_to_older.");
    const { defaultRoute } = await import("../commands/review.js");
    const d = defaultRoute(l);
    await decide(db, l.id, { status: "live", ...(d.route === "always" ? { alwaysOn: true } : {}), ...(d.route === "keyword" && d.keywords.length ? { triggers: d.keywords } : {}), ...(d.global ? { global: true } : {}) });
    await db.execute({ sql: "INSERT INTO lesson_versions (id,lesson_id,snapshot,changed_by,changed_at) VALUES (lower(hex(randomblob(16))),?,?,?,?)", args: [l.id, JSON.stringify({ status: "live", said }), "mcp", new Date().toISOString()] });
    try { const { syncCursor } = await import("../deliver/cursor.js"); await syncCursor(db); } catch { /* rules files are a convenience */ }
    const when = d.route === "always" ? "every session" : d.route === "keyword" && d.keywords.length ? `when "${d.keywords.join('", "')}" comes up` : "only when searched";
    return `Kept: "${l.text.slice(0, 120)}". Agents are told it ${when}${l.role ? `, the ${l.role} only` : ""}${d.global ? ", in every repo" : ""}. Change it in muninn ui.`;
  }
  if (name === "get_runs") {
    const past = await runsText(db, repo, { limit: typeof a.limit === "number" ? a.limit : 5, all: a.include_single === true }, found);
    if (!repo) return past;
    // Runs are put together when muninn reads the logs after sessions end, so one still going isn't in them yet.
    const { workingNow, workingLines } = await import("../plan/live.js");
    const now = await workingNow(db, repo, null).then(workingLines).catch(() => []);
    return now.length ? `RUNNING NOW (not in the runs below until it ends):\n${now.join("\n")}\n\n${past}` : past;
  }
  if (name === "list_lessons") return lessonsText(db, repo, a.waiting === true, found);
  if (name === "where_left_off") {
    if (!repo) throw new Error("Say which repo: the chat isn't running inside one.");
    const branch = typeof a.branch === "string" && a.branch ? a.branch : (currentBranch(process.cwd()) && repoIdentity(process.cwd()) === repo ? currentBranch(process.cwd())! : "main");
    const { latestHandoff, handoffText } = await import("../handoff/handoff.js");
    const { settings } = await import("../config.js");
    const h = await latestHandoff(db, repo, branch, 30);
    if (h) found.push({ kind: "handoff", id: h.id });
    return h ? handoffText(h, settings().handoffStaleDays) : `No session on ${branch} in ${repo.split("/").pop()} has left a note in the last 30 days. Try get_plan for the branch's plan.`;
  }
  throw new Error(`No tool called ${name}.`);
}

/** What an agent asked, as the Activity page shows it: its words for a search, plain words for a lookup, never a bare id. */
export function askedWords(name: string, a: Args): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (name === "open_results") { const n = Array.isArray(a.ids) ? a.ids.length : 1; return `Opened ${n} search match${n === 1 ? "" : "es"} in full`; }
  if (name === "review_lesson") return `${a.action === "keep" ? "Keep" : a.action === "dismiss" ? "Dismiss" : "Fold into an older lesson"} a suggested lesson${str(a.engineer_said) ? `, because the engineer said "${str(a.engineer_said).slice(0, 100)}"` : ""}`;
  if (name === "plan_note") return `${str(a.who) || "An agent"}${a.state && a.state !== "working" ? ` (${String(a.state)})` : ""}: ${str(a.text)}`;
  if (name === "get_plan" || name === "where_left_off") return str(a.branch) ? `The ${str(a.branch)} branch` : "";
  return str(a.query) || str(a.about) || str(a.text) || "";
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const short = (r: string) => r.split("/").pop() ?? r;

/** Recent runs with their numbers per role, saved findings, and how role lessons are doing. */
export async function runsText(db: Client, repo: string | null, o: { limit: number; all: boolean }, found: Found = []): Promise<string> {
  const { listRuns } = await import("../workflow/runs.js");
  const { runNumbers, savedFindings } = await import("../commands/run-findings.js");
  const { roleEffects } = await import("../workflow/effect.js");
  const runs = await listRuns(db, { repo, teamOnly: !o.all, limit: Math.max(1, Math.min(o.limit, 20)) });
  for (const r of runs) found.push({ kind: "run", id: r.id });
  const saved = await savedFindings(db, runs);
  const out: string[] = [];
  for (const r of runs) {
    const n = runNumbers(r);
    out.push(`RUN ${r.started_at.slice(0, 16).replace("T", " ")}${repo ? "" : ` · ${short(r.repo_id)}`} · ${n.minutes} min · ${k(n.tokens)} tokens · roles: ${r.roles.join(", ")}${n.typed ? ` · the engineer typed ${n.typed} message(s)` : " · ran on its own"}`);
    const { dollars } = await import("../workflow/runs.js");
    const costOfRole = (role: string) => dollars(r.sessions.filter((x) => x.role === role).map((x) => ({ ...x, cost_usd: x.cost_usd ?? null })));
    for (const x of n.roles) out.push(`- ${x.role}: ${x.sessions} session(s), ${Math.round(x.minutes)} min, ${k(x.tokens)} tokens (${Math.round(x.share * 100)}%)${costOfRole(x.role) ? `, ${costOfRole(x.role)}` : ""}, ${x.commands} command(s)${x.failed ? `, ${x.failed} failed` : ""}${x.approvals ? `, ${x.approvals} approval(s)` : ""}${x.sentBack ? `, work sent back to it ${x.sentBack} time(s)` : ""}`);
    out.push(`Between roles: ${n.approvals} approval(s), ${n.sentBack} sent back, ${n.rework} fix(es) after approval${n.stalls.length ? `, ${n.stalls.length} gap(s) of ${n.stalls.map((g) => `${g.minutes} min`).join(", ")} with no agent working` : ""}.`);
    for (const h of r.handoffs.filter((h) => h.kind === "review_rejected" || h.kind === "rework").slice(0, 6)) out.push(`  ${h.at.slice(11, 16)} ${h.kind === "rework" ? `${h.from_role} fixed later` : `${h.from_role} sent back to ${h.to_role}`}: ${h.note ?? h.evidence ?? ""}`);
    for (const w of r.workflows ?? []) out.push(`Workflow ${w.name} (${w.status}): ${w.agents} agents, phases ${w.phases.join(" → ")}${w.logs.length ? `; ${w.logs.slice(-3).join("; ")}` : ""}${w.blocking_left ? `. Finished with ${w.blocking_left} blocking issue(s) still open.` : ""}`);
    const f = saved[r.id];
    if (f?.items.length) { out.push("Findings:"); for (const i of f.items) out.push(`  - ${i.role ? `[${i.role}] ` : ""}${i.text}`); }
    out.push("");
  }
  const effects = await roleEffects(db, repo);
  for (const e of effects) found.push({ kind: "lesson", id: e.id });
  if (effects.length) { out.push("LESSONS FOR ONE ROLE, AND WHETHER THEY WORKED:"); for (const e of effects) out.push(`- for the ${e.role}${repo ? "" : ` (${short(e.repo)})`}: ${e.text.slice(0, 160)}\n  ${e.summary}`); }
  if (!runs.length && !effects.length) return `No workflow runs${repo ? ` in ${short(repo)}` : ""} yet${o.all ? "" : " with more than one role (subagents, or agents in different worktrees). Set include_single for plain sessions"}. muninn builds runs when it scans.`;
  return out.join("\n").trim();
}

/** Kept lessons and waiting suggestions, with how each is told, why it was kept, its role, and how it's doing. */
export async function lessonsText(db: Client, repo: string | null, waitingOnly: boolean, found: Found = []): Promise<string> {
  const { reportData } = await import("../commands/report.js");
  const { roleEffects } = await import("../workflow/effect.js");
  const where = repo ? "AND (l.repo_id=? OR l.scope='global')" : "";
  const rows = (await db.execute({ sql: `SELECT l.id,l.text,l.kind,l.status,l.always_on,l.role,l.why,l.scope,l.repo_id,(SELECT group_concat(pattern, ', ') FROM triggers t WHERE t.lesson_id=l.id) kw FROM lessons l WHERE l.off=0 AND l.status IN (${waitingOnly ? "'proposed'" : "'live','proposed'"}) ${where} ORDER BY l.status DESC, l.updated_at DESC LIMIT 60`, args: repo ? [repo] : [] })).rows;
  for (const r of rows) found.push({ kind: r.kind === "note" ? "note" : "lesson", id: String(r.id) });
  if (!rows.length) return waitingOnly ? "No suggestions are waiting." : `No lessons${repo ? ` for ${short(repo)}` : ""} yet.`;
  const verdict = new Map((await reportData(db, repo)).lessons.map((l) => [l.id, l.verdict]));
  for (const e of await roleEffects(db, repo)) verdict.set(e.id, e.summary);
  // A waiting suggestion close to an older lesson: name it, so the engineer can add one to the other instead of keeping both.
  const close = new Map<string, string>();
  const { similar } = await import("../commands/review.js");
  const { getLesson } = await import("../store/lessons.js");
  for (const r of rows) if (r.status === "proposed") {
    const l = await getLesson(db, String(r.id)); const sim = l ? await similar(db, l).catch(() => null) : null;
    if (sim) close.set(String(r.id), `Close to ${sim.lesson.status === "live" ? "kept" : "waiting"} lesson [${sim.lesson.id.slice(0, 8)}], told in ${sim.lesson.scope === "global" ? "every repo" : short(String(sim.lesson.repo_id))}. It can be added to that lesson instead of kept on its own (review_lesson add_to_older).`);
  }
  const line = (r: Record<string, unknown>) => {
    const when = r.status === "proposed" ? "waiting for review" : r.always_on ? "told every session" : r.kw ? `told when "${r.kw}" comes up` : "only when searched";
    const where = r.scope === "global" ? "every repo" : repo ? null : short(String(r.repo_id));
    return `- [${String(r.id).slice(0, 8)}] ${String(r.text).slice(0, 400)}\n  (${[when, r.role ? `for the ${r.role} only` : null, where].filter(Boolean).join(", ")})${r.why ? `\n  Why: ${r.why}` : ""}${verdict.get(String(r.id)) ? `\n  How it's doing: ${verdict.get(String(r.id))}` : ""}${close.get(String(r.id)) ? `\n  ${close.get(String(r.id))}` : ""}`;
  };
  const kept = rows.filter((r) => r.status === "live"), waiting = rows.filter((r) => r.status === "proposed");
  return [kept.length ? `KEPT (${kept.length}):\n${kept.map(line).join("\n")}` : "", waiting.length ? `WAITING FOR REVIEW (${waiting.length}):\n${waiting.map(line).join("\n")}` : ""].filter(Boolean).join("\n\n");
}

type Msg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };
/** Runs the server on stdin and stdout, one JSON-RPC message per line. Logs go to stderr only. */
export async function serveMcp() {
  const db = await openDb();
  let embedder: Promise<Embed | null> | null = null;
  const embed = () => (embedder ??= modelCached() ? loadEmbedder() : Promise.resolve(null));
  const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
  let client = "agent";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let m: Msg;
    try { m = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    if (m.id === undefined) continue; // a notification, such as notifications/initialized
    const reply = (result: object) => send({ jsonrpc: "2.0", id: m.id, result });
    try {
      if (m.method === "initialize") {
        client = toolFromClient(m.params?.clientInfo?.name);
        const asked = String(m.params?.protocolVersion ?? "");
        reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "muninn", title: "muninn (secondnature)", version: packageVersion() },
          instructions: MCP_INSTRUCTIONS });
      } else if (m.method === "ping") reply({});
      else if (m.method === "tools/list") reply({ tools: TOOLS });
      else if (m.method === "tools/call") {
        const name = String(m.params?.name), args = (m.params?.arguments ?? {}) as Args, found: Found = [], t0 = Date.now();
        let answer: string;
        try { answer = await callTool(db, name, args, embed, found); reply({ content: [{ type: "text", text: answer }] }); }
        catch (e) { answer = `Error: ${e instanceof Error ? e.message : String(e)}`; reply({ content: [{ type: "text", text: answer.slice(7) }], isError: true }); }
        // The log of agents' questions: what was asked, where, and what it found.
        const repo = await resolveRepo(db, args).catch(() => null);
        const here = repoIdentity(process.cwd());
        const asked = askedWords(name, args);
        await recordQuery(db, { repo, branch: repo && repo === here ? currentBranch(process.cwd()) : (typeof args.branch === "string" ? args.branch : null), session: process.env.CLAUDE_CODE_SESSION_ID ?? null, tool: client, surface: name, query: asked, results: found.length, result_ids: found, ms: Date.now() - t0, answer });
      } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
    } catch (e) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }); }
  }
}
