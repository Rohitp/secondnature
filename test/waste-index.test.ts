import { describe, expect, it } from "vitest";
import { distinctive, short, wasteIndex } from "../src/learn/waste-index.js";
import type { LogEvent, Session } from "../src/logs/types.js";

const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();
const sess = (id: string, events: LogEvent[], extra: Partial<Session> = {}): Session => ({ id, tool: "claude-code", cwd: "/r", clientVersion: "1", unknown: 0, events, ...extra });
const big = (lines: string[]) => lines.join("\n") + "\n" + "padding line of output\n".repeat(200);

describe("waste index", () => {
  it("adds up output per command, counts repeats, and says whether the agent used it", () => {
    const out = big(["FAIL src/billing/invoiceTotals.spec.ts", "computeInvoiceTotals rounding mismatch"]);
    const events: LogEvent[] = [
      { k: "cmd", cmd: "npm test", failed: true, output: out, ts: at(1), size: out.length },
      { k: "agent", text: "computeInvoiceTotals rounds too early, fixing.", ts: at(2) },
      { k: "cmd", cmd: "npm test", failed: true, output: out, ts: at(3), size: out.length },
      { k: "agent", text: "Let me look at something else.", ts: at(4) },
      { k: "cmd", cmd: "ls", failed: false, output: "a b", ts: at(5), size: 3 },
    ];
    const [row, ...rest] = wasteIndex([sess("a", events, { model: "claude-sonnet-5-5", turns: [{ ts: at(2), input: 1, output: 1 }, { ts: at(4), input: 1, output: 1 }] })]);
    expect(rest).toEqual([]); // small outputs aren't indexed
    expect(row).toMatchObject({ key: "npm test", kind: "command", runs: 2, sessions: 1, repeated: 1, judged: 2, used: 1 });
    expect(row!.tokens).toBe(2 * Math.ceil(out.length / 4));
    // Fresh input once, then cache reads for each later turn: 2 turns after the first run, 1 after the second.
    const t = Math.ceil(out.length / 4);
    expect(row!.costUsd).toBeCloseTo((2 * t * 2 + (2 + 1) * t * 0.1) / 1e6, 8);
  });
  it("indexes big file reads, and leaves cost unknown for an unpriced model", () => {
    const s = sess("a", [{ k: "file", tool: "read", path: "/r/src/big.ts", failed: false, output: "x", ts: at(1), size: 40_000 }], { model: "mystery-1" });
    expect(wasteIndex([s])[0]).toMatchObject({ key: "read src/big.ts", kind: "read", tokens: 10_000, costUsd: null, used: null });
  });
  it("picks specific words from output, not common ones or the command's own", () => {
    expect(distinctive("FAIL tests passed computeTotals src/app/thing.ts", "jest computeTotals")).toEqual(["src/app/thing.ts"]);
  });
  it("names things plainly: the shortest real command without a leading cd, and Claude Code's saved outputs", () => {
    const out = "x".repeat(8000);
    const run = (cmd: string): LogEvent => ({ k: "cmd", cmd, failed: false, output: out, ts: at(1), size: out.length });
    const [row] = wasteIndex([sess("a", [run("cd /tmp/work && cat src/a.ts src/b.ts"), run("cat src/c.ts src/d.ts")])]);
    expect(row!.example).toBe("cat src/a.ts src/b.ts");
    expect(short("/r", "/Users/me/.claude/projects/-r/abc-123/tool-results/x.txt")).toBe("a long tool output Claude Code saved to a file");
    expect(short("/r", "/r/src/a.ts")).toBe("src/a.ts");
  });
});
