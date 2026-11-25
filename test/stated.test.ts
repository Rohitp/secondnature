import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { originOf } from "../src/commands/ask.js";
import { defaultRoute } from "../src/commands/review.js";
import { deliver } from "../src/deliver/hook.js";
import { findMoments, isStanding } from "../src/learn/signals.js";
import { readClaude } from "../src/logs/claude-code.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { addEvidence, createLesson, decide, ensureRepo, listLessons } from "../src/store/lessons.js";
import { fakeEmbed, tmp, useHome, write } from "./helpers.js";

let cwd = ""; let repo = "";
beforeEach(async () => { useHome(); cwd = join(tmp(), "shop"); mkdirSync(cwd); execFileSync("git", ["init", "-q", cwd]); repo = repoIdentity(cwd)!; await ensureRepo(await openDb(), repo, cwd); });

describe("standing instructions", () => {
  it("are told apart from one-off requests and questions", () => {
    expect(isStanding("lets branch and merge for features now with prs.")).toBe(true);
    expect(isStanding("From now on, run the tests before you commit.")).toBe(true);
    expect(isStanding("Please always explain new terms in plain words.")).toBe(true);
    expect(isStanding("lets merge it")).toBe(false);
    expect(isStanding("should we always use branches for features?")).toBe(false);
    expect(isStanding("I always forget where this lives")).toBe(false);
    expect(isStanding("From now on I delete a branch only after checking the merge actually happened. - is this a lesson.")).toBe(false);
    expect(isStanding("From now on I want every feature on its own branch.")).toBe(true);
  });
  it("are read from messages sent while the agent was working", () => {
    const f = join(tmp(), "s.jsonl");
    write(f, [{ type: "attachment", cwd: "/r", timestamp: "t1", attachment: { type: "queued_command", prompt: "from now on, put each feature on its own branch" } }]);
    expect(readClaude(f).events).toEqual([{ k: "typed", text: "from now on, put each feature on its own branch", ts: "t1" }]);
  });
  it("become a moment in scans, said once", async () => {
    const m = await findMoments([{ id: "a", tool: "claude-code", cwd, clientVersion: "1", unknown: 0, events: [{ k: "typed", text: "Going forward, use pnpm for every install.", ts: "2026-11-21T10:00:00.000Z" }] }], fakeEmbed, { cutoff: 0.9, minSessions: 2 });
    expect(m.filter((x) => x.signal === "stated").map((x) => x.text)).toEqual(["Going forward, use pnpm for every install."]);
  });
});

describe("catching one as you type it", () => {
  it("adds it to the suggestions once, in your words, with a said-once badge and a this-repo default", async () => {
    const db = await openDb();
    const prompt = (text: string, session = "s1") => deliver(db, "claude-code", { hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt: text });
    await prompt("thanks. from now on, put each feature on its own branch and open a PR. now fix the header");
    await prompt("from now on, put each feature on its own branch and open a PR.");
    const waiting = await listLessons(db, { repo, status: "proposed" });
    expect(waiting.map((l) => [l.text, l.signal])).toEqual([["From now on, put each feature on its own branch and open a PR.", "stated"]]);
    expect(await originOf(db, waiting[0]!)).toMatch(/^You stated this as a rule, said once, in Claude Code/);
    expect(defaultRoute(waiting[0]!)).toEqual({ route: "always", keywords: [], global: false });
    await addEvidence(db, waiting[0]!.id, [{ tool: "claude-code", session: "s2", ts: "t", quote: "from now on, feature branches" }]);
    expect(await originOf(db, waiting[0]!)).toMatch(/said in 2 sessions/);
  });

  it("ignores messages another session sent in, which arrive as prompts too", async () => {
    const db = await openDb();
    const prompt = (text: string) => deliver(db, "claude-code", { hook_event_name: "UserPromptSubmit", session_id: "coord", cwd, prompt: text });
    await prompt('Another Claude session sent a message:\n<cross-session-message from="local_1" from-name="Milestone 17">\nFrom now on wrap the gate like this: lockf -k /tmp/ci.lock make ci-local\n</cross-session-message>');
    await prompt('<task-notification>From now on, run the gate one session at a time.</task-notification>');
    expect(await listLessons(db, { repo, status: "proposed" })).toEqual([]);
  });
});

describe("messages from other sessions in the logs", () => {
  it("are the sender's messages, not the engineer's typing, whether queued or not", () => {
    const f = join(tmp(), "coord.jsonl");
    const body = "From now on wrap the gate like this: lockf make ci-local";
    write(f, [
      { type: "user", cwd, timestamp: "2026-11-24T10:00:00Z", message: { content: "build milestone 17" } },
      { type: "attachment", timestamp: "2026-11-24T10:01:00Z", attachment: { type: "queued_command", origin: { kind: "peer", name: "Milestone 17", body }, prompt: `Another Claude session sent a message:\n<cross-session-message from="local_1" from-name="Milestone 17">\n${body}\n</cross-session-message>` } },
      { type: "user", timestamp: "2026-11-24T10:02:00Z", message: { content: `Another Claude session sent a message:\n<cross-session-message from="local_2" from-name="Design">\nScreens are done.\n</cross-session-message>` } },
    ]);
    const s = readClaude(f);
    expect(s.events.filter((e) => e.k === "typed").map((e) => (e as { text: string }).text)).toEqual(["build milestone 17"]);
    expect(s.messages?.map((m) => [m.from, m.text])).toEqual([["Milestone 17", body], ["Design", "Screens are done."]]);
  });
});

describe("lessons kept while a session runs", () => {
  it("reach that session on its next message, once", async () => {
    const db = await openDb();
    await deliver(db, "claude-code", { hook_event_name: "SessionStart", source: "startup", session_id: "run", cwd });
    await new Promise((r) => setTimeout(r, 5));
    const id = await createLesson(db, { repo_id: repo, text: "Put each feature on its own branch", source: "manual", status: "live", by: "person" });
    await decide(db, id, { alwaysOn: true });
    const next = (p: string) => deliver(db, "claude-code", { hook_event_name: "UserPromptSubmit", session_id: "run", cwd, prompt: p });
    expect(await next("carry on")).toContain("Put each feature on its own branch");
    expect(await next("and the footer") ?? "").not.toContain("Put each feature on its own branch");
  });
});
