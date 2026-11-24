import { beforeEach, describe, expect, it } from "vitest";
import { insightsData, insightsText } from "../src/commands/insights.js";
import { openDb } from "../src/store/db.js";
import { ANSWER_KEPT, lessonFinds, listQueries, recordQuery, toolFromClient, whoIsAsking } from "../src/store/queries.js";
import { useHome } from "./helpers.js";

const repo = "github.com/me/app";
const ask = (o: Partial<Parameters<typeof recordQuery>[1]> = {}) => ({ repo, branch: "main", session: null, tool: "claude-code", surface: "search_history", query: "how do we deploy", results: 0, result_ids: [], ms: 12, ...o });

beforeEach(() => { useHome(); });

describe("the log of what agents ask", () => {
  it("keeps each question newest first, for its repo and those asked with no repo, and cuts long ones", async () => {
    const db = await openDb();
    await recordQuery(db, ask({ query: "x".repeat(400) }));
    await recordQuery(db, ask({ repo: null, surface: "ask", query: "where did we leave off" }));
    await recordQuery(db, ask({ repo: "github.com/me/other", query: "not this repo" }));
    const rows = await listQueries(db, { repo, days: 7 });
    expect(rows.map((r) => r.query.slice(0, 22))).toEqual(["where did we leave off", "x".repeat(22)]);
    expect(rows[1]!.query.length).toBe(300);
  });
  it("counts how often agents found each lesson, leaving out questions typed in a terminal", async () => {
    const db = await openDb();
    await recordQuery(db, ask({ results: 2, result_ids: [{ kind: "lesson", id: "L1" }, { kind: "lesson", id: "L1" }, { kind: "session", id: "S1" }] }));
    await recordQuery(db, ask({ results: 1, result_ids: [{ kind: "note", id: "L2" }] }));
    await recordQuery(db, ask({ tool: "terminal", results: 1, result_ids: [{ kind: "lesson", id: "L1" }] }));
    expect(await lessonFinds(db)).toEqual({ L1: 1, L2: 1 });
  });
  it("keeps the answer the agent got back, with private details hidden, so the page can show it", async () => {
    const db = await openDb();
    await recordQuery(db, ask({ query: "deploy key", answer: "Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 to deploy.\n" + "y".repeat(60000) }));
    await recordQuery(db, ask({ query: "older" }));
    const rows = await listQueries(db, { repo });
    const none = rows.find((r) => r.query === "older"), got = rows.find((r) => r.query === "deploy key");
    expect(none!.answer).toBeNull();
    expect(got!.answer!.startsWith("Use the key")).toBe(true);
    expect(got!.answer).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(got!.answer!.length).toBe(ANSWER_KEPT);
  });
  it("names who is asking from their environment or MCP client", () => {
    expect(whoIsAsking({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }, false)).toEqual({ tool: "claude-code", session: "s1" });
    expect(whoIsAsking({ CODEX_HOME: "/x" }, false).tool).toBe("codex");
    expect(whoIsAsking({}, true).tool).toBe("terminal");
    expect(whoIsAsking({}, false).tool).toBe("agent");
    expect(toolFromClient("Claude Desktop")).toBe("claude-desktop");
    expect(toolFromClient("antigravity")).toBe("antigravity");
  });
});

describe("what agents asked, in your week", () => {
  it("says how many questions found something, the tools used most, and what found nothing", async () => {
    const db = await openDb();
    await recordQuery(db, ask({ results: 3 }));
    await recordQuery(db, ask({ surface: "get_plan", results: 1 }));
    await recordQuery(db, ask({ query: "what is the bid-ask formula", results: 0 }));
    await recordQuery(db, ask({ tool: "terminal", query: "typed by a person", results: 0 }));
    const text = insightsText(await insightsData(db, repo, 7, [], []));
    expect(text).toContain("What agents asked");
    expect(text).toContain("3 question(s), 2 found something (67%). Most often they searched past sessions (2), read the branch plan (1).");
    expect(text).toContain('Found nothing: "what is the bid-ask formula"');
    expect(text).not.toContain("typed by a person");
  });
});
