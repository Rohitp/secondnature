import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { longScanDue, releaseLock, scanDue, stamp, takeLock } from "../src/commands/auto.js";
import { install, installLearnHook, installed, removeLearnHook } from "../src/commands/install.js";
import { tmp, useHome, write } from "./helpers.js";

beforeEach(() => { useHome(); process.env.MUNINN_LOG_ROOT = tmp(); delete process.env.MUNINN_INTERNAL; });
const H = 3_600_000;
describe("automatic scans", () => {
  it("runs first, waits a day, and also runs after 5 new sessions", () => {
    const now = Date.now();
    expect(scanDue(now)).toBe(true);
    stamp(now);
    expect(scanDue(now + H)).toBe(false);
    expect(scanDue(now + 25 * H)).toBe(true);
    for (let i = 0; i < 5; i++) write(join(process.env.MUNINN_LOG_ROOT!, `claude/projects/p/${i}.jsonl`), [{}]);
    expect(scanDue(now + H)).toBe(true);
  });
  it("scans a long session every 6 hours while it runs, but not a short one", () => {
    const now = Date.now();
    stamp(now);
    expect(longScanDue(2_000_000, now + H)).toBe(false);
    expect(longScanDue(2_000_000, now + 7 * H)).toBe(true);
    expect(longScanDue(50_000, now + 7 * H)).toBe(false);
  });
  it("muninn's own runs and pause do not trigger a scan", () => {
    process.env.MUNINN_INTERNAL = "1";
    expect(scanDue()).toBe(false);
    delete process.env.MUNINN_INTERNAL;
    writeFileSync(join(process.env.MUNINN_HOME!, "paused"), "");
    expect(scanDue()).toBe(false);
  });
  it("can be turned off", () => {
    writeFileSync(join(process.env.MUNINN_HOME!, "config.json"), '{"autoLearn":false}');
    expect(scanDue()).toBe(false);
  });
  it("allows one scan at a time", () => {
    expect(takeLock()).toBe(true);
    expect(takeLock()).toBe(false);
    releaseLock();
    expect(takeLock()).toBe(true);
    releaseLock();
  });
});
describe("install", () => {
  const f = () => process.env.MUNINN_CLAUDE_SETTINGS!;
  it("keeps another tool's hook on the same event, and doesn't add itself twice", () => {
    const other = { hooks: [{ type: "command", command: "other-tool" }] };
    writeFileSync(f(), JSON.stringify({ model: "x", hooks: { SessionEnd: [other] } }));
    installLearnHook(); installLearnHook();
    const c = JSON.parse(readFileSync(f(), "utf8"));
    expect(c.hooks.SessionEnd).toHaveLength(2);
    expect(c.hooks.SessionEnd[0]).toEqual(other);
  });
  it("uninstall removes only muninn and keeps later edits", () => {
    writeFileSync(f(), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "other-tool" }] }] } }));
    installLearnHook();
    const c = JSON.parse(readFileSync(f(), "utf8")); c.later = true; writeFileSync(f(), JSON.stringify(c));
    removeLearnHook();
    const after = JSON.parse(readFileSync(f(), "utf8"));
    expect(after.later).toBe(true);
    expect(after.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: "other-tool" }] }]);
  });
  it("refuses to touch a malformed settings file", () => {
    writeFileSync(f(), "{ not json");
    expect(() => installLearnHook()).toThrow(/left it alone/);
    expect(readFileSync(f(), "utf8")).toBe("{ not json");
  });
  it("widens the failure matcher an older muninn installed, and leaves other people's hooks alone", () => {
    const f = process.env.MUNINN_CLAUDE_SETTINGS!;
    install();
    const c = JSON.parse(readFileSync(f, "utf8"));
    c.hooks.PostToolUseFailure[0].matcher = "Bash";
    c.hooks.PostToolUseFailure.push({ matcher: "Read", hooks: [{ type: "command", command: "my-own-hook" }] });
    writeFileSync(f, JSON.stringify(c));
    install();
    const after = JSON.parse(readFileSync(f, "utf8")).hooks.PostToolUseFailure;
    expect(after.map((g: any) => g.matcher)).toEqual(["Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob", "Read"]);
  });
  it("installs every hook once, with a Bash matcher on failures, and uninstall removes them all", () => {
    install(); install();
    const c = JSON.parse(readFileSync(f(), "utf8"));
    expect(installed()).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUseFailure", "PostToolUse", "SubagentStart", "Stop", "PreCompact", "SessionEnd", "TaskCreated", "TaskCompleted", "TeammateIdle"]);
    expect(c.hooks.PostToolUseFailure).toEqual([expect.objectContaining({ matcher: "Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob" })]);
    const codex = JSON.parse(readFileSync(process.env.MUNINN_CODEX_HOOKS!, "utf8"));
    expect(installed("codex")).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "Stop", "PreCompact", "SessionEnd"]);
    expect(codex.hooks.PostToolUse).toEqual([expect.objectContaining({ matcher: "Bash" })]);
    expect(codex.hooks.SessionEnd[0].hooks[0]).toMatchObject({ timeout: 3 });
    expect(codex.hooks.SessionStart[0].hooks[0].command).toContain("hook --client codex");
    removeLearnHook();
    expect(installed()).toEqual([]);
    expect(installed("codex")).toEqual([]);
  });
});

describe("check now", () => {
  it("knows when a scan is running from its lock", async () => {
    const { scanRunning } = await import("../src/commands/auto.js");
    expect(scanRunning()).toBe(false);
    expect(takeLock()).toBe(true);
    expect(scanRunning()).toBe(true);
    releaseLock();
    expect(scanRunning()).toBe(false);
  });
});
