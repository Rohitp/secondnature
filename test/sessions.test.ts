import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recallData } from "../src/commands/recall.js";
import { readClaude } from "../src/logs/claude-code.js";
import { scanLogs } from "../src/logs/discover.js";
import type { LogEvent, Session } from "../src/logs/types.js";
import { openDb } from "../src/store/db.js";
import { archivedOnly, archiveLogs, exchanges, indexSessions, keepEnds } from "../src/store/sessions.js";
import { fakeEmbed, tmp, useHome, write } from "./helpers.js";

beforeEach(() => { useHome(); });
afterEach(() => { delete process.env.MUNINN_LOG_ROOT; });
const ts = (m: number) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();
const typed = (text: string, m: number): LogEvent => ({ k: "typed", text, ts: ts(m) });
// A made-up key in a real key's shape, built at run time so secret scanners don't mistake the test file for a leak.
const FAKE_KEY = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

describe("sessions as exchanges", () => {
  it("groups what was typed with what the agent said and ran, redacted", () => {
    const s: Session = { id: "s", tool: "claude-code", cwd: "/r", clientVersion: "1", unknown: 0, events: [
      { k: "agent", text: "before anything was typed", ts: ts(0) },
      typed(`the stripe webhook returns 400, key ${FAKE_KEY}`, 1),
      { k: "agent", text: "The signing secret is wrong.", ts: ts(2) },
      { k: "cmd", cmd: "stripe listen", failed: true, output: "Error: invalid signature", ts: ts(3) },
      { k: "file", tool: "edit", path: "/r/src/webhook.ts", failed: false, output: "", ts: ts(4) },
      typed("thanks", 5),
    ] };
    const ex = exchanges(s);
    expect(ex).toHaveLength(2);
    expect(ex[0]!.text).toContain("ENGINEER: the stripe webhook returns 400");
    expect(ex[0]!.text).not.toContain(FAKE_KEY);
    expect(ex[0]!.text).toContain("`stripe listen` failed: Error: invalid signature");
    expect(ex[0]!.text).toContain("FILES: edit src/webhook.ts");
    expect(ex[0]!.text).not.toContain("before anything was typed");
  });
  it("keeps a long agent reply whole, and says how much was left out of one too long to keep", () => {
    const reply = Array.from({ length: 60 }, (_, i) => `Point ${i}: the agent explains its reasoning here.`).join("\n"); // ~3,000 characters
    const s: Session = { id: "s", tool: "claude-code", cwd: "/r", clientVersion: "1", unknown: 0, events: [typed("how should we build it?", 1), { k: "agent", text: reply, ts: ts(2) }] };
    const text = exchanges(s)[0]!.text;
    expect(text).toContain("Point 30: the agent explains"); // the middle, which used to be dropped
    expect(text).not.toContain("left out");
    const cut = keepEnds("a".repeat(5000), 3000);
    expect(cut).toMatch(/^a{1000}\n\[… 2,000 characters left out …\]\na{2000}$/);
  });
  it("never keeps <private> text, from where the logs are read onwards", () => {
    const f = join(tmp(), "s.jsonl");
    write(f, [{ type: "user", cwd: "/r", timestamp: "t1", message: { content: "deploy with <private>password hunter2</private> please" } }]);
    const s = readClaude(f);
    expect((s.events[0] as { text: string }).text).toBe("deploy with [private] please");
    expect(exchanges(s)[0]!.text).not.toContain("hunter2");
  });
});

describe("storing and recalling sessions", () => {
  const session = (file: string, events: LogEvent[]): Session => ({ id: "sess-1", tool: "claude-code", cwd: "", clientVersion: "1", unknown: 0, events, file });
  it("stores each exchange once, adds only what's new as a log grows, and finds them by words and meaning", async () => {
    const db = await openDb();
    const file = join(tmp(), "log.jsonl");
    writeFileSync(file, "x");
    const first = [typed("the stripe webhook returns 400", 1), { k: "agent" as const, text: "Fixed the signing secret.", ts: ts(2) }];
    expect(await indexSessions(db, [session(file, first)], fakeEmbed)).toEqual({ sessions: 1, added: 1, removed: 0 });
    expect(await indexSessions(db, [session(file, first)], fakeEmbed)).toEqual({ sessions: 0, added: 0, removed: 0 });
    writeFileSync(file, "xx");
    const r = await indexSessions(db, [session(file, [...first, typed("now add retries to the email sender", 3)])], fakeEmbed);
    expect(r).toEqual({ sessions: 1, added: 1, removed: 0 });
    const byWords = await recallData(db, "stripe webhook", null, { embed: fakeEmbed });
    expect(byWords[0]!.text).toContain("stripe webhook");
    expect(byWords[0]!.by).toContain("words");
    const byMeaning = await recallData(db, "add retries to the email sender", null, { embed: fakeEmbed });
    expect(byMeaning[0]!.text).toContain("retries");
    expect(byMeaning[0]!.by).toContain("meaning");
  });
});

describe("keeping logs the tool deletes", () => {
  it("copies logs compressed, and reads the copy once the original is gone", async () => {
    const root = tmp(); process.env.MUNINN_LOG_ROOT = root;
    const repo = join(tmp(), "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    const log = join(root, "claude", "projects", "p", "abc.jsonl");
    write(log, [{ type: "user", cwd: repo, timestamp: ts(1), message: { content: "how do the benchmarks run?" } }]);
    const db = await openDb();
    expect(await archiveLogs(db)).toBe(1);
    expect(await archiveLogs(db)).toBe(0);
    rmSync(log);
    expect(existsSync(log)).toBe(false);
    const only = archivedOnly();
    expect(only).toHaveLength(1);
    const s = readClaude(only[0]!.file);
    expect(s.id).toBe("abc");
    expect(scanLogs().sessions.map((x) => x.id)).toEqual(["abc"]);
  });
});

describe("the vector index", () => {
  it("finds the nearest exchanges through the index, and still finds a repo's own when others crowd it out", async () => {
    const { nearest } = await import("../src/commands/recall.js");
    const db = await openDb();
    const file = join(tmp(), "log.jsonl"); writeFileSync(file, "x");
    const many: Session = { id: "busy", tool: "claude-code", cwd: "", clientVersion: "1", unknown: 0, file, events: Array.from({ length: 40 }, (_, i) => typed(`deploy the billing service step ${i}`, i % 50)) };
    await indexSessions(db, [many], fakeEmbed);
    await db.execute("UPDATE chunks SET repo_id='busy'");
    const file2 = join(tmp(), "log2.jsonl"); writeFileSync(file2, "x");
    await indexSessions(db, [{ ...many, id: "quiet", file: file2, events: [typed("deploy the billing service from main", 1)] }], fakeEmbed);
    await db.execute("UPDATE chunks SET repo_id='quiet' WHERE session='quiet'");
    expect(Number((await db.execute("SELECT count(*) n FROM vector_top_k('chunks_vec', (SELECT embedding FROM chunks LIMIT 1), 5)")).rows[0]!.n)).toBe(5);
    const v = (await fakeEmbed(["deploy the billing service"])).get("deploy the billing service")!;
    expect((await nearest(db, v, "1 AND 1", [])).length).toBeGreaterThan(10);
    const mine = await nearest(db, v, "c.repo_id=? AND 1", ["quiet"]);
    expect(mine).toHaveLength(1);
  });
});
