import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { reportData } from "../src/commands/report.js";
import { fixSavings, wrapped } from "../src/learn/savings.js";
import type { LogEvent, Session } from "../src/logs/types.js";
import { apply, listProposals, propose, trimProposals } from "../src/propose/index.js";
import { TRIM_PATH } from "../src/propose/trim.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { ensureRepo } from "../src/store/lessons.js";
import { tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "repo"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
const at = (d: number) => new Date(Date.UTC(2026, 10, d, 10)).toISOString();
const run = (cmd: string, ts: string, size: number): LogEvent => ({ k: "cmd", cmd, failed: false, output: "  ✓ case passes\n".repeat(120), ts, size });
const sess = (id: string, events: LogEvent[]): Session => ({ id, tool: "claude-code", cwd: root, clientVersion: "1", unknown: 0, events, model: "claude-sonnet-5-5" });
const trimmed = `sh ${TRIM_PATH} test -- npm test`;

async function applyTrim(before: Session[]) {
  const db = await openDb();
  await propose(db, trimProposals(repo, before)[0]!);
  await apply(db, (await listProposals(db, repo))[0]!.id);
  // Pretend it was applied on the 5th, between the "before" and "after" sessions.
  await db.execute({ sql: "UPDATE proposals SET decided_at=? WHERE kind='trim'", args: [at(5)] });
  return db;
}
const before = () => [sess("a", [run("npm test", at(1), 40_000), run("npm test", at(1), 40_000)])];

describe("what an applied trim saved", () => {
  it("reads the wrapped command back out of a trimmed run", () => {
    expect(wrapped(trimmed)).toBe("npm test");
    expect(wrapped("npm test")).toBeNull();
  });
  it("compares output per run before and after, in tokens and money", async () => {
    const db = await applyTrim(before());
    const after = [sess("b", [run(trimmed, at(6), 800), run(trimmed, at(6), 800), run(trimmed, at(7), 800)])];
    const [f] = await fixSavings(db, repo, [...before(), ...after]);
    expect(f).toMatchObject({ cmd: "npm test", enough: true, before: { runs: 2, avgTokens: 10_000 }, after: { runs: 3, trimmed: 3, raw: 0, avgTokens: 200 } });
    expect(f!.savedTokens).toBe(3 * 9800);
    expect(f!.savedUsd).toBeCloseTo((3 * 9800 * 2) / 1e6, 8);
    expect(f!.verdict).toContain("Saved about 29k tokens");
    // The report carries it.
    expect((await reportData(db, repo, [...before(), ...after])).fixes).toHaveLength(1);
  });
  it("says so when there aren't enough runs, when agents skip the script, or keep opening the full output", async () => {
    const db = await applyTrim(before());
    expect((await fixSavings(db, repo, [...before(), sess("b", [run(trimmed, at(6), 800)])]))[0]!.verdict).toContain("Not enough runs");
    const skipped = sess("b", [run("npm test", at(6), 40_000), run("npm test", at(6), 40_000), run(trimmed, at(6), 800)]);
    expect((await fixSavings(db, repo, [...before(), skipped]))[0]!.verdict).toContain("still ran it without the script 2 of 3");
    const readBack: LogEvent = { k: "file", tool: "read", path: join(root, ".muninn/out/1.log"), failed: false, output: "", ts: at(6) };
    const needed = sess("b", [run(trimmed, at(6), 800), readBack, run(trimmed, at(6), 800), readBack, run(trimmed, at(6), 800)]);
    expect((await fixSavings(db, repo, [...before(), needed]))[0]!.verdict).toContain("Consider undoing it");
  });
});
