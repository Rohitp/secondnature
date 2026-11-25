import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seenIn, warningsFor, watchSession, WATCH } from "../src/deliver/watch.js";
import { recentNotes } from "../src/plan/live.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { tmp, useHome, write } from "./helpers.js";

const step = (context: number, cmd?: string) => ({
  type: "assistant", gitBranch: "m17", message: { id: Math.random().toString(), usage: { input_tokens: 1000, cache_read_input_tokens: context - 1000, output_tokens: 50 },
    content: cmd ? [{ type: "tool_use", id: "t", name: "Bash", input: { command: cmd } }] : [{ type: "text", text: "ok" }] },
});
const wait = "end=$((SECONDS+170)); until grep -q '^exit' /tmp/ci.log; do sleep 10; done";
/** Pads a transcript past the size where muninn starts reading it. */
const padding = Array.from({ length: 300 }, () => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(2500) }] } }));

describe("watching a session while it runs", () => {
  it("reads the latest context, recent waits, and the session's name from the end of its transcript", () => {
    const s = seenIn([{ type: "custom-title", customTitle: "Milestone 17" }, step(100_000, "make check"), step(420_000, wait), step(430_000, wait), step(440_000, "ls"), step(450_000, wait)]);
    expect(s).toEqual({ context: 450_000, waits: 3, title: "Milestone 17", branch: "m17" });
  });

  it("warns once per level of context, and once about waiting", () => {
    const w = warningsFor({ context: 450_000, waits: 3, title: null, branch: null }, new Set());
    expect(w.map((x) => x.key)).toEqual(["heavy:300000", "wait"]);
    expect(w[0]!.agent).toContain("re-reads about 450k tokens of context on every step");
    expect(warningsFor({ context: 450_000, waits: 3, title: null, branch: null }, new Set(["heavy:300000", "wait"]))).toEqual([]);
    expect(warningsFor({ context: 650_000, waits: 0, title: null, branch: null }, new Set(["heavy:300000"])).map((x) => x.key)).toEqual(["heavy:600000"]);
    expect(warningsFor({ context: 200_000, waits: 2, title: null, branch: null }, new Set())).toEqual([]);
  });

  it("tells the agent once, and puts a note on the plan for the engineer", async () => {
    useHome();
    const repoDir = join(tmp(), "repo"); mkdirSync(repoDir); execFileSync("git", ["init", "-q", repoDir]);
    const file = join(tmp(), "s.jsonl");
    write(file, [{ type: "custom-title", customTitle: "Milestone 17" }, ...padding, step(420_000, wait), step(430_000, wait), step(440_000, wait)]);
    const input = { session_id: "s1", transcript_path: file, cwd: repoDir };
    const first = await watchSession(input, () => openDb());
    expect(first).toContain("re-reads about 440k tokens");
    expect(first).toContain("re-running a check 3 times");
    expect(await watchSession(input, () => openDb())).toBeNull();
    const notes = await recentNotes(await openDb(), repoIdentity(repoDir)!);
    expect(notes[0]).toMatchObject({ who: "muninn on Milestone 17", branch: "m17" });
    expect(notes[0]!.text).toContain("Carries about 440k of context on every step");
  });

  it("doesn't read small transcripts at all", async () => {
    const file = join(tmp(), "small.jsonl");
    write(file, [step(500_000, wait)]);
    expect(WATCH.minFile).toBeGreaterThan(1000);
    expect(await watchSession({ session_id: "x", transcript_path: file }, () => { throw new Error("opened the database"); })).toBeNull();
  });
});
