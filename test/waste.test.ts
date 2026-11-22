import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIG_OUTPUT, effortMoments, findMoments, STEP_MIN } from "../src/learn/signals.js";
import { readClaude } from "../src/logs/claude-code.js";
import type { LogEvent, Session } from "../src/logs/types.js";
import { fakeEmbed, tmp, write } from "./helpers.js";

const at = (d: number, s = 0) => new Date(Date.UTC(2026, 10, d, 10, 0, s)).toISOString();
const sess = (id: string, events: LogEvent[]): Session => ({ id, tool: "claude-code", cwd: "/r", clientVersion: "1", unknown: 0, events });
const find = (sessions: Session[]) => findMoments(sessions, fakeEmbed, { cutoff: 0.9, minSessions: 2 });
const read = (path: string, size = 2000, d = 1, part = false): LogEvent => ({ k: "file", tool: "read", path, failed: false, output: "x", ts: at(d), size, ...(part ? { part } : {}) });
const edit = (path: string, d = 1): LogEvent => ({ k: "file", tool: "edit", path, failed: false, output: "", ts: at(d) });
const cmd = (c: string, size = 100, d = 1, failed = false): LogEvent => ({ k: "cmd", cmd: c, failed, output: "ok", ts: at(d), size });
const of = (m: { signal: string }[], s: string) => m.filter((x) => x.signal === s);

describe("Claude Code reader: how much output the agent was shown", () => {
  it("records the full size of a command's result and a read, and marks a read of only some lines", () => {
    const f = join(tmp(), "s.jsonl");
    const huge = "line of test output\n".repeat(3000);
    write(f, [
      { type: "user", cwd: "/r", timestamp: "t1", message: { content: "run the tests" } },
      { type: "assistant", timestamp: "t2", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "b", name: "Read", input: { file_path: "/r/a.ts", offset: 10, limit: 20 } }] } },
      { type: "user", timestamp: "t3", toolUseResult: { stdout: huge, stderr: "" }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: huge }] } },
      { type: "user", timestamp: "t4", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "some lines" }] } },
    ]);
    const s = readClaude(f);
    // stdout repeats the tool result, so it isn't counted twice; the saved output stays cut short.
    expect(s.events[1]).toMatchObject({ k: "cmd", size: huge.length });
    expect((s.events[1] as { output: string }).output.length).toBeLessThanOrEqual(2000);
    expect(s.events[2]).toMatchObject({ k: "file", size: 10, part: true });
  });
});

describe("token waste", () => {
  it("finds a command that keeps printing far more than needed, and counts only the excess", async () => {
    const big = BIG_OUTPUT + 20_000;
    const m = of(await find([sess("a", [cmd("npm test", big, 1)]), sess("b", [cmd("npm test", big, 2)])]), "big_output");
    expect(m.map((x) => x.text)).toEqual(["`npm test` showed the agent more than 10k tokens of output 2 times, in 2 session(s)"]);
    expect(m[0]!.wasted).toBe(2 * Math.ceil((big - 8000) / 4));
    // Once is not a habit, and normal output never counts.
    expect(of(await find([sess("a", [cmd("npm test", big), cmd("npm test", 500)])]), "big_output")).toHaveLength(0);
  });
  it("finds a file read again without changing, but not after an edit or a command that touches it", async () => {
    const m = of(await find([sess("a", [read("/r/src/db.ts"), cmd("make"), read("/r/src/db.ts"), read("/r/src/db.ts")])]), "reread");
    expect(m.map((x) => x.text)).toEqual(["`src/db.ts` was read again without changing, 2 times in 1 session(s)"]);
    expect(m[0]!.wasted).toBe(1000);
    const edited = [read("/r/src/db.ts"), edit("/r/src/db.ts"), read("/r/src/db.ts"), cmd("sed -i s/a/b/ src/db.ts"), read("/r/src/db.ts")];
    expect(of(await find([sess("a", edited)]), "reread")).toHaveLength(0);
    // Reading separate parts of a file reads each part once; one re-read in one session is ordinary.
    expect(of(await find([sess("a", [read("/r/a.ts", 100, 1, true), read("/r/a.ts", 100, 1, true), read("/r/a.ts", 100, 1, true)])]), "reread")).toHaveLength(0);
    expect(of(await find([sess("a", [read("/r/a.ts"), read("/r/a.ts")])]), "reread")).toHaveLength(0);
    // The same one re-read in two sessions is a habit.
    expect(of(await find([sess("a", [read("/r/a.ts"), read("/r/a.ts")]), sess("b", [read("/r/a.ts", 2000, 2), read("/r/a.ts", 2000, 2)])]), "reread")).toHaveLength(1);
  });
  it("finds the same step run on one thing after another, which a script would do at once", async () => {
    const steps = Array.from({ length: STEP_MIN }, (_, i) => cmd(`npx prettier --write src/file${i}.ts`));
    const m = of(await find([sess("a", steps)]), "one_by_one");
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toContain("a script or loop would do them in one step");
    expect(m[0]!.quotes[0]!.quote).toContain(`${STEP_MIN} runs in a row`);
    // Fewer steps, the very same command again, a failure in the middle, or plain look-ups: not this.
    expect(of(await find([sess("a", steps.slice(1))]), "one_by_one")).toHaveLength(0);
    expect(of(await find([sess("a", Array.from({ length: 8 }, () => cmd("npm test")))]), "one_by_one")).toHaveLength(0);
    expect(of(await find([sess("a", [...steps.slice(0, 3), cmd("npx prettier --write src/bad.ts", 100, 1, true), ...steps.slice(3)])]), "one_by_one")).toHaveLength(0);
    expect(of(await find([sess("a", Array.from({ length: 8 }, (_, i) => cmd(`cat src/f${i}.ts`)))]), "one_by_one")).toHaveLength(0);
  });
  it("counts in the week's wasted effort", () => {
    const big = BIG_OUTPUT + 20_000;
    const kinds = effortMoments([sess("a", [cmd("npm test", big, 1)]), sess("b", [cmd("npm test", big, 2)])]).map((m) => m.signal);
    expect(kinds).toContain("big_output");
  });
});
