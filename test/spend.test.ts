import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spendLines } from "../src/commands/insights.js";
import { spendBreakdown, spendOf } from "../src/learn/spend.js";
import { scanLogs } from "../src/logs/discover.js";
import type { Session } from "../src/logs/types.js";
import { tmp, useHome, write } from "./helpers.js";

afterEach(() => { delete process.env.MUNINN_LOG_ROOT; });
const ts = (m: number) => new Date(Date.UTC(2026, 10, 24, 10, m)).toISOString();
/** A session that took `steps` model calls, each re-reading about `context` tokens. */
function sess(id: string, steps: number, context: number, extra: Partial<Session> = {}): Session {
  const turns = Array.from({ length: steps }, (_, i) => ({ ts: ts(i % 600), input: 2_000, output: 300, cacheRead: context - 2_000 }));
  return { id, tool: "claude-code", cwd: "/r", clientVersion: "1", unknown: 0, events: [], turns, model: "claude-opus-5-5", ...extra };
}

describe("sessions nobody typed in", () => {
  it("are counted when their model did work, marked as run by an agent, with the name the app gave them", () => {
    useHome();
    const root = tmp(); process.env.MUNINN_LOG_ROOT = root;
    const repo = join(tmp(), "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    const dir = join(root, "claude", "projects", "p");
    // Started by another session: the brief arrives wrapped in a system tag, so nothing counts as typed.
    write(join(dir, "worker.jsonl"), [
      { type: "user", cwd: repo, timestamp: ts(1), message: { content: "<system-reminder>Linked sessions now</system-reminder> Build milestone 14." } },
      { type: "assistant", timestamp: ts(2), message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "Building." }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 400_000 } } },
      { type: "custom-title", customTitle: "Milestone 14: privacy and integrity", sessionId: "worker" },
    ]);
    // A log with neither typing nor model calls is still skipped.
    write(join(dir, "empty.jsonl"), [{ type: "user", cwd: repo, timestamp: ts(1), message: { content: "<system-reminder>x</system-reminder>" } }]);
    write(join(dir, "mine.jsonl"), [{ type: "user", cwd: repo, timestamp: ts(1), message: { content: "fix the build" } }]);
    const s = scanLogs().sessions;
    expect(s.map((x) => x.id).sort()).toEqual(["mine", "worker"]);
    const w = s.find((x) => x.id === "worker")!;
    expect(w).toMatchObject({ unattended: true, title: "Milestone 14: privacy and integrity" });
    expect(s.find((x) => x.id === "mine")!.unattended).toBeUndefined();
  });
});

describe("where the spend went", () => {
  it("counts every step's context, not just what was written", () => {
    const sp = spendOf(sess("a", 100, 400_000).turns, "claude-opus-5-5");
    expect(sp).toMatchObject({ steps: 100, contextAvg: 400_000, heavySteps: 100, priced: true });
    expect(sp.reRead / sp.read).toBeGreaterThan(0.99);
    // 100 steps re-reading 398k at $0.20 a million, plus 2k fresh input at $4 and 300 written at $20.
    expect(sp.costUsd).toBeCloseTo((100 * 398_000 * 0.2 + 100 * 2_000 * 4 + 100 * 300 * 20) / 1e6, 4);
  });

  // The 24–25 Nov workbench run, by shape: builders and milestone sessions with 400–560k contexts did most of the spend,
  // while the coordinator, woken often, stayed small. muninn reported "Nothing stood out" for it. It mustn't again.
  it("ranks the long-lived agent sessions first and says their context was re-read on every step", () => {
    const sessions = [
      sess("design", 900, 460_000, { title: "Design catch-up", unattended: true }),
      sess("m17", 355, 540_000, { title: "Milestone 17: MCP server", unattended: true }),
      sess("m13", 60, 800_000, { title: "Milestone 13: logs", unattended: true }),
      sess("coord", 120, 108_000, { title: "Workbench coordinator", launches: [{ ts: ts(1), name: "m17", title: "Milestone 17" }] }),
    ];
    const c = spendBreakdown(sessions);
    expect(c.rows.map((r) => r.id)).toEqual(["design", "m17", "m13", "coord"]);
    expect(c.rows[0]!.share).toBeGreaterThan(0.5);
    expect(c.rows.at(-1)!.share).toBeLessThan(0.05);
    expect(c.reReadShare).toBeGreaterThan(0.99);
    const text = spendLines(c).join("\n");
    expect(text).toContain("Design catch-up (run by an agent): 900 steps, about 460k context per step");
    expect(text).toContain("Workbench coordinator (coordinator)");
    expect(text).toContain("of the context taken in was the same context re-read on the next step");
    expect(text).toContain("3 session(s) carried over 300k of context per step");
  });

  it("counts subagents with the session that started them, and by type", () => {
    const sub = { ...sess("x", 50, 200_000), agentType: "qa" };
    const c = spendBreakdown([sess("main", 10, 50_000, { subagents: [sub] })]);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]!.subagents.steps).toBe(50);
    expect(c.subagentTypes[0]).toMatchObject({ type: "qa" });
  });

  it("only counts steps in the window", () => {
    const s = sess("a", 10, 100_000);
    s.turns = [...s.turns!.map((t) => ({ ...t, ts: "2026-11-01T00:00:00Z" })), { ts: ts(5), input: 1, output: 1, cacheRead: 99 }];
    expect(spendOf(s.turns, s.model, "2026-11-20").steps).toBe(1);
  });
});
