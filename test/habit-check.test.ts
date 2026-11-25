import { describe, expect, it } from "vitest";
import { defaultRoute } from "../src/commands/review.js";
import { ENOUGH_STEPS, habitChecks, habitNumbers, habitVerdict } from "../src/learn/habit-check.js";
import type { LogEvent, Session } from "../src/logs/types.js";
import { openDb } from "../src/store/db.js";
import { useHome } from "./helpers.js";

const day = (d: number, m = 0) => new Date(Date.UTC(2026, 10, d, 10, m)).toISOString();
function sess(id: string, d: number, steps: number, context: number, events: LogEvent[] = []): Session {
  return { id, tool: "claude-code", cwd: `/repos/${id}`, clientVersion: "1", unknown: 0, model: "claude-opus-5-5", events,
    turns: Array.from({ length: steps }, (_, i) => ({ ts: day(d, i % 600), input: 1000, output: 100, cacheRead: context - 1000 })) };
}
const merge = (d: number): LogEvent => ({ k: "cmd", cmd: "gh pr merge 12 --squash", failed: false, output: "", ts: day(d) });

describe("lessons about how agents are run", () => {
  it("are told in every session, in every repo", () => {
    for (const signal of ["heavy_context", "wait_loop", "big_session_ask"]) expect(defaultRoute({ text: "Hand each phase to a fresh agent", kind: "rule", signal, suggested_keywords: null, suggested_scope: null })).toMatchObject({ route: "always", global: true });
  });

  it("count steps, heavy context and merged pull requests across repos in a window", () => {
    const n = habitNumbers([sess("a", 10, 100, 450_000, [merge(10)]), sess("b", 11, 100, 100_000, [merge(11), { ...merge(11), failed: true }])], day(1), day(20));
    expect(n).toMatchObject({ sessions: 2, steps: 200, heavyShare: 0.5, merged: 2 });
  });

  it("say it's working when heavy steps fell, with dollars per merged pull request", () => {
    const before = habitNumbers([sess("a", 10, 300, 450_000, [merge(10), merge(10)])], day(1), day(15));
    const after = habitNumbers([sess("b", 16, 300, 90_000, [merge(16), merge(16)])], day(15), day(30));
    const v = habitVerdict("heavy_context", before, after);
    expect(v).toMatch(/^14 days before: 100% of steps re-read over 300k \(about 450k per step on average\)\. Since: 0% of steps/);
    expect(v).toContain("per merged pull request before");
    expect(v).toContain("It's working.");
    expect(habitVerdict("heavy_context", before, { ...after, steps: ENOUGH_STEPS - 1 })).toContain("Too early to tell");
    expect(habitVerdict("heavy_context", after, before)).toContain("It's worse since");
  });

  it("measure each kept lesson from the day it was kept", async () => {
    useHome();
    const db = await openDb();
    await db.execute({ sql: "INSERT INTO lessons (id,text,status,signal,created_at,updated_at,reviewed_at,kind,scope,source,always_on) VALUES ('h1','Hand each phase to a fresh agent','live','heavy_context',?,?,?,'rule','global','inferred',1)", args: [day(15), day(15), day(15)] });
    const checks = await habitChecks(db, [sess("a", 10, 300, 450_000), sess("b", 16, 300, 90_000)], day(30));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.before.steps).toBe(300);
    expect(checks[0]!.after.steps).toBe(300);
    expect(checks[0]!.verdict).toContain("It's working.");
  });
});
