import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { answerData, gatherSources } from "../src/commands/answer.js";
import { callTool, cutClean, resolveRepo, TOOLS } from "../src/mcp/server.js";
import { installMcp, uninstallMcp } from "../src/mcp/install.js";
import { addItem } from "../src/plan/plan.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { ensureRepo, listLessons } from "../src/store/lessons.js";
import { indexSessions } from "../src/store/sessions.js";
import { fakeEmbed, tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "shop"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
const embed = async () => fakeEmbed;
async function seed() {
  const db = await openDb();
  await addItem(db, repo, "main", "decision", "Publish the package as secondnature, since muninn was taken on npm", { person: true });
  const file = join(tmp(), "log.jsonl"); writeFileSync(file, "x");
  await indexSessions(db, [{ id: "s1", tool: "claude-code", cwd: root, clientVersion: "1", unknown: 0, file, events: [
    { k: "typed", text: "the npm publish failed with EOTP", ts: "2026-11-20T13:55:00.000Z" },
    { k: "agent", text: "npm needs a one-time code from your authenticator app.", ts: "2026-11-20T13:55:10.000Z" },
  ] }], fakeEmbed);
  return db;
}

describe("answers from everything muninn keeps", () => {
  it("draws on plan decisions and past sessions, with dates, and passes earlier turns along", async () => {
    const db = await seed();
    const found = await gatherSources(db, "publish package secondnature npm", repo, fakeEmbed);
    expect(found.map((s) => s.kind)).toEqual(expect.arrayContaining(["decision", "session"]));
    expect(found.find((s) => s.kind === "session")!.date).toBe("2026-11-20");
    let prompt = "";
    const a = await answerData(db, "and why that name?", repo, { name: "fake", run: (p) => { prompt = p; return "Because muninn was taken [1]."; } }, fakeEmbed, [{ q: "what did we publish?", a: "secondnature [1]" }]);
    expect(a.answer).toBe("Because muninn was taken [1].");
    expect(prompt).toContain("EARLIER IN THIS CONVERSATION");
  });
});

describe("the MCP tools", () => {
  it("lists its tools, each with a schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["search_history", "open_results", "where_left_off", "get_plan", "list_lessons", "get_related", "get_week", "get_runs", "list_repos", "suggest_lesson", "review_lesson"]);
    for (const t of TOOLS) expect(t.inputSchema.type).toBe("object");
  });
  it("says when to use each tool first, and marks which ones only read", () => {
    // An agent reaches for a tool when its description names the moment it's in, so each opens with when to use it.
    for (const t of TOOLS.filter((t) => t.name !== "review_lesson")) expect(t.description).toMatch(/^(Use this|Call this)/);
    for (const t of TOOLS) expect(t.title).toBeTruthy();
    const writes = TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(writes).toEqual(["suggest_lesson", "review_lesson"]);
  });
  it("finds a repo by its short name, and says which ones exist when it can't", async () => {
    const db = await openDb();
    expect(await resolveRepo(db, { repo: "SHOP" }, "/")).toBe(repo);
    await expect(resolveRepo(db, { repo: "nope" }, "/")).rejects.toThrow(/Known: shop/);
  });
  it("searches, shows the plan, and puts a suggested lesson in the review queue only", async () => {
    const db = await seed();
    const found = await callTool(db, "search_history", { query: "npm publish EOTP", repo: "shop" }, embed);
    expect(found).toContain("SESSION · shop");
    expect(found).toContain("one-time code");
    expect(await callTool(db, "get_plan", { repo: "shop", branch: "main" }, embed)).toContain("Publish the package as secondnature");
    expect(await callTool(db, "suggest_lesson", { text: "Run npm publish from a terminal so the code prompt works.", repo: "shop" }, embed)).toContain("Nothing reaches an agent until they keep it");
    expect((await listLessons(db, { repo, status: "proposed" })).map((l) => l.text)).toEqual(["Run npm publish from a terminal so the code prompt works."]);
    expect(await callTool(db, "list_repos", {}, embed)).toContain("shop");
  });
  it("answers a search with one short line per match, and opens only the matches asked for", async () => {
    const db = await seed();
    const long = "The release checklist: " + "run the tests, build, tag the version, ".repeat(30) + "then publish.";
    const file = join(tmp(), "log2.jsonl"); writeFileSync(file, "x");
    await indexSessions(db, [{ id: "s2", tool: "claude-code", cwd: root, clientVersion: "1", unknown: 0, file, events: [
      { k: "typed", text: "what is the release checklist", ts: "2026-11-21T10:00:00.000Z" },
      { k: "agent", text: long, ts: "2026-11-21T10:00:10.000Z" },
    ] }], fakeEmbed);
    const list = await callTool(db, "search_history", { query: "release checklist", repo: "shop" }, embed);
    expect(list).toContain("open the ones you need with open_results");
    expect(list).not.toContain("then publish.");
    // Every preview is one line, at most 200 characters.
    for (const l of list.split("\n").filter((l) => !l.startsWith("[") && !/match\(es\)/.test(l))) expect(l.length).toBeLessThanOrEqual(200);
    const id = list.match(/\[(\d+)\] SESSION[^\n]*· id (\S+)\n[^\n]*release checklist/i)!;
    const full = await callTool(db, "open_results", { ids: [id[2]!] }, embed);
    expect(full).toContain("then publish.");
    // The [n] number from the latest search works too, and an unknown id says what to do.
    expect(await callTool(db, "open_results", { ids: [id[1]!] }, embed)).toContain("then publish.");
    expect(await callTool(db, "open_results", { ids: ["nope"] }, embed)).toContain("Run search_history again");
  });
  it("speaks the protocol over stdin and stdout", async () => {
    const child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), [join(process.cwd(), "src/cli.ts"), "mcp"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const lines: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "tools/call", params: { name: "list_repos", arguments: {} } });
    await new Promise<void>((ok, fail) => { const t = setInterval(() => { if (lines.length >= 3) { clearInterval(t); ok(); } }, 50); setTimeout(() => { clearInterval(t); fail(new Error(`only ${lines.length} replies`)); }, 15000); });
    child.kill();
    expect(lines[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "muninn" } } });
    expect(lines[1].result.tools).toHaveLength(11);
    expect(lines[2].result.content[0].text).toContain("shop");
  }, 30000);
});

describe("adding the server to the Claude desktop app", () => {
  it("adds muninn beside the other servers, keeps a backup, and removes only its own", () => {
    const file = join(tmp(), "claude_desktop_config.json");
    process.env.MUNINN_DESKTOP_CONFIG = file;
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    try {
      expect(installMcp()).toEqual(["the Claude desktop app (restart it to pick this up)"]);
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      expect(Object.keys(cfg.mcpServers)).toEqual(["other", "muninn"]);
      expect(cfg.mcpServers.muninn.args.at(-1)).toBe("mcp");
      expect(cfg.theme).toBe("dark");
      expect(JSON.parse(readFileSync(`${file}.muninn-backup`, "utf8")).mcpServers.muninn).toBeUndefined();
      uninstallMcp();
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["other"]);
    } finally { delete process.env.MUNINN_DESKTOP_CONFIG; }
  });
});

describe("which repo a question is about", () => {
  it("follows a repo the question names, over the one it was asked from", async () => {
    const { repoForQuestion } = await import("../src/commands/answer.js");
    const db = await openDb();
    await ensureRepo(db, "github.com/me/servanda", "/x");
    expect(await repoForQuestion(db, "What did I do in servanda this week?", repo)).toBe("github.com/me/servanda");
    expect(await repoForQuestion(db, "servanda and shop: what changed?", repo)).toBeNull();
    expect(await repoForQuestion(db, "what did we decide about npm?", repo)).toBe(repo);
  });
});

describe("a branch's history as outcomes", () => {
  it("groups finished steps into outcomes with routine steps marked, and gives decisions a reason", async () => {
    const { groupHistory, getHistory, branchesToGroup, historyPrompt } = await import("../src/plan/history.js");
    const db = await openDb();
    const a = (await addItem(db, repo, "main", "done", "Stored sessions as searchable exchanges"))!;
    const b = (await addItem(db, repo, "main", "done", "Full suite passes, 165 tests"))!;
    const c = (await addItem(db, repo, "main", "done", "Read the npm staged publishing docs"))!;
    const d = (await addItem(db, repo, "main", "decision", "Publish as secondnature, since muninn was taken"))!;
    expect(await branchesToGroup(db, repo)).toEqual(["main"]);
    let prompt = "";
    const reply = JSON.stringify({
      outcomes: [
        { title: "Every session is searchable", result: "Sessions are kept and can be searched.", kind: "shipped", area: "Searching past sessions", ref: "ffbf07e", steps: [a.slice(0, 8), b.slice(0, 8)], routine: [b.slice(0, 8)] },
        { title: "How npm staging works", result: "Learned that a maintainer approves first releases.", kind: "explored", area: "Publishing on npm", steps: [c.slice(0, 8), "nonsense"] },
      ],
      decisions: [{ id: d.slice(0, 8), what: "Publish as secondnature", why: "muninn was taken on npm", area: "Publishing on npm" }],
    });
    expect(await groupHistory(db, repo, "main", { name: "fake", run: (p) => { prompt = p; return reply; } })).toBe(3);
    expect(prompt).toContain("Never jargon");
    const h = await getHistory(db, repo, "main");
    expect(h.ungrouped).toHaveLength(0);
    expect(h.outcomes.map((o) => [o.title, o.steps.length, o.ref])).toEqual(expect.arrayContaining([["Every session is searchable", 2, "ffbf07e"], ["How npm staging works", 1, null]]));
    expect(h.outcomes.find((o) => o.ref === "ffbf07e")!.steps.find((s) => s.routine)!.text).toBe("Full suite passes, 165 tests");
    expect(h.decisions[0]).toMatchObject({ what: "Publish as secondnature", why: "muninn was taken on npm", area: "Publishing on npm" });
    expect(h.areas).toEqual(expect.arrayContaining(["Searching past sessions", "Publishing on npm"]));
    expect(await branchesToGroup(db, repo)).toEqual([]);
    expect(historyPrompt({ steps: [], recent: [], decisions: [], areas: ["X"] })).toContain('AREAS: ["X"]');
  });
});

describe("question threads", () => {
  it("keeps each question and answer, and gives a follow-up the thread so far", async () => {
    const { askInThread, listThreads, getThread, deleteThread } = await import("../src/commands/answer.js");
    const db = await seed();
    const prompts: string[] = [];
    const runner = { name: "fake", run: (p: string) => { prompts.push(p); return `answer ${prompts.length} [1]`; } };
    const first = await askInThread(db, "what did we publish?", repo, runner, fakeEmbed);
    const second = await askInThread(db, "and why that name?", repo, runner, fakeEmbed, first.thread);
    expect(second.thread).toBe(first.thread);
    expect(prompts[1]).toContain("what did we publish?");
    expect(await listThreads(db, repo)).toEqual([expect.objectContaining({ title: "what did we publish?", turns: 2 })]);
    const t = (await getThread(db, first.thread))!;
    expect(t.turns.map((u) => [u.q, u.a])).toEqual([["what did we publish?", "answer 1 [1]"], ["and why that name?", "answer 2 [1]"]]);
    expect(t.turns[0]!.sources.length).toBeGreaterThan(0);
    await deleteThread(db, first.thread);
    expect(await listThreads(db, repo)).toEqual([]);
  });
});

describe("questions to try", () => {
  it("builds them from real items until your Claude writes better ones, then shows those", async () => {
    const { getSuggestions, refreshSuggestions } = await import("../src/commands/suggestions.js");
    const db = await openDb();
    await addItem(db, repo, "main", "decision", "Publish as secondnature", { person: true });
    await addItem(db, repo, "main", "open", "Release 0.1.1", { person: true });
    expect(await getSuggestions(db, repo)).toEqual(["Why did we decide to publish as secondnature?", "What's left before we can release 0.1.1?", "What did I work on in shop this week?"]);
    let prompt = "";
    await refreshSuggestions(db, repo, { name: "fake", run: (p) => { prompt = p; return '["Why secondnature?", "What blocks the 0.1.1 release?", "How did the npm publish go?", "What changed this week?"]'; } });
    expect(prompt).toContain("Publish as secondnature");
    expect(await getSuggestions(db, repo)).toHaveLength(4);
    expect((await getSuggestions(db, repo))[1]).toBe("What blocks the 0.1.1 release?");
  });
});

describe("autonomous work, lessons and handoffs, from a chat", () => {
  it("reports runs with each role's numbers and how role lessons are doing", async () => {
    const db = await openDb();
    const { saveRuns } = await import("../src/workflow/runs.js");
    const at = (m: number) => new Date(Date.UTC(2026, 10, 21, 10, m)).toISOString();
    const sess = (role: string, typed: number) => ({ id: role, tool: "antigravity", role, branch: null, worktree: role, parent_session: role === "main" ? null : "main", agent_type: null, started_at: at(0), ended_at: at(30), tokens_in: 1000, tokens_out: 200, cache_read: 0, model: null, commands: 3, failed_commands: 0, task: null, typed });
    await saveRuns(db, [{ id: "r1", repo_id: repo, started_at: at(0), ended_at: at(30), roles: ["main", "builder", "reviewer"], team: true, bounces: 0, wasted_tokens: 0, tokens_in: 3000, tokens_out: 600,
      sessions: [sess("main", 2), sess("builder", 0), sess("reviewer", 0)],
      handoffs: [{ from_role: "reviewer", to_role: "everyone", at: at(10), kind: "approved" }, { from_role: "builder", to_role: "everyone", at: at(20), kind: "rework", note: "fix: null guard (M1 #3 follow-up)" }] }]);
    const { createLesson } = await import("../src/store/lessons.js");
    await createLesson(db, { repo_id: repo, text: "Before approving, test null inputs", source: "inferred", signal: "missed", status: "live", by: "t", role: "reviewer", why: "Fixes were needed after approval." });
    const runs = await callTool(db, "get_runs", { repo: "shop" }, embed);
    expect(runs).toContain("roles: main, builder, reviewer · the engineer typed 2 message(s)");
    expect(runs).toContain("1 approval(s), 0 sent back, 1 fix(es) after approval");
    expect(runs).toContain("builder fixed later: fix: null guard (M1 #3 follow-up)");
    expect(runs).toContain("for the reviewer: Before approving, test null inputs");
    const lessons = await callTool(db, "list_lessons", { repo: "shop" }, embed);
    expect(lessons).toContain("(only when searched, for the reviewer only)");
    expect(lessons).toContain("Why: Fixes were needed after approval.");
    expect(lessons).toContain("How it's doing: No runs with the reviewer since you kept it");
  });
  it("says where the last session on a branch left off", async () => {
    const db = await openDb();
    expect(await callTool(db, "where_left_off", { repo: "shop", branch: "main" }, embed)).toMatch(/^No session on main in .* has left a note/);
    await db.execute({ sql: "INSERT INTO handoffs (id,repo_id,branch,session,tool,text,created_at) VALUES ('h1',?,?,?,?,?,?)", args: [repo, "main", "s1", "claude-code", "Goal: ship it. Next: run the release.", new Date().toISOString()] });
    expect(await callTool(db, "where_left_off", { repo: "shop", branch: "main" }, embed)).toContain("Next: run the release.");
  });
});

describe("MCP in Cursor and Codex", () => {
  it("adds muninn to Cursor's mcp.json and Codex's config.toml where they're installed, keeping what's there", async () => {
    const { codexConfig, cursorConfig, installMcp, uninstallMcp } = await import("../src/mcp/install.js");
    mkdirSync(join(cursorConfig(), ".."), { recursive: true }); mkdirSync(join(codexConfig(), ".."), { recursive: true });
    writeFileSync(codexConfig(), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const done = installMcp();
    expect(done).toEqual(expect.arrayContaining(["Cursor", "Codex"]));
    expect(JSON.parse(readFileSync(cursorConfig(), "utf8")).mcpServers.muninn.args.at(-1)).toBe("mcp");
    const toml = readFileSync(codexConfig(), "utf8");
    expect(toml).toContain('model = "gpt-5"'); expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toMatch(/\[mcp_servers\.muninn\]\ncommand = ".+"\nargs = \[".+cli\.js", "mcp"\]/);
    installMcp();
    expect(readFileSync(codexConfig(), "utf8").match(/\[mcp_servers\.muninn\]/g)).toHaveLength(1);
    uninstallMcp();
    expect(readFileSync(codexConfig(), "utf8")).not.toContain("muninn");
    expect(readFileSync(codexConfig(), "utf8")).toContain("[mcp_servers.other]");
  });
});

describe("reviewing a suggestion from a chat", () => {
  it("keeps or dismisses only a waiting lesson the engineer asked about, quoting them", async () => {
    const db = await openDb();
    const { createLesson, getLesson } = await import("../src/store/lessons.js");
    const a = await createLesson(db, { repo_id: repo, text: "From now on, put each feature on its own branch", source: "own_words", signal: "stated", status: "proposed", by: "t" });
    const b = await createLesson(db, { repo_id: repo, text: "Something not worth keeping", source: "inferred", status: "proposed", by: "t" });
    expect(await callTool(db, "list_lessons", { repo: "shop", waiting: true }, embed)).toContain(`[${a.slice(0, 8)}]`);
    await expect(callTool(db, "review_lesson", { id: a.slice(0, 8), action: "keep", engineer_said: "" }, embed)).rejects.toThrow(/Quote what the engineer said/);
    expect(await callTool(db, "review_lesson", { id: a.slice(0, 8), action: "keep", engineer_said: "yes keep the branch one" }, embed)).toMatch(/^Kept: .*every session/);
    expect(await getLesson(db, a)).toMatchObject({ status: "live", always_on: 1 });
    await expect(callTool(db, "review_lesson", { id: a, action: "keep", engineer_said: "keep it" }, embed)).rejects.toThrow(/already kept/);
    expect(await callTool(db, "review_lesson", { id: b, action: "dismiss", engineer_said: "drop that one" }, embed)).toMatch(/^Dismissed/);
    expect((await getLesson(db, b))?.status).toBe("rejected");
  });
});

describe("opening a match too long to send whole", () => {
  it("cuts at a sentence or line break, never mid-word, and says how much is left", () => {
    const t = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = cutClean(t, 300);
    const [kept, note] = out.split("\n[Cut here: ");
    expect(kept!.endsWith(".")).toBe(true);
    expect(note).toBe(`${(t.length - kept!.length).toLocaleString("en-GB")} more characters not shown.]`);
    expect(cutClean("short", 300)).toBe("short");
  });
});
