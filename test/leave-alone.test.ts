import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveSettings, leftAlone } from "../src/config.js";
import { install } from "../src/commands/install.js";
import { tmp, useHome } from "./helpers.js";

/** Tools unticked in setup: no hooks are added for them, and their logs aren't read. */
describe("leaving a tool alone", () => {
  it("adds no Claude Code hooks once you untick it, and adds them when you tick it again", () => {
    useHome();
    saveSettings({ leaveAlone: ["claude-code"] });
    expect(leftAlone("claude-code")).toBe(true);
    install();
    expect(existsSync(process.env.MUNINN_CLAUDE_SETTINGS!)).toBe(false);
    saveSettings({ leaveAlone: [] });
    install();
    expect(existsSync(process.env.MUNINN_CLAUDE_SETTINGS!)).toBe(true);
  });
  it("keeps other settings when saving", async () => {
    const h = useHome();
    writeFileSync(join(h, "config.json"), JSON.stringify({ maxPerDelivery: 5 }));
    saveSettings({ leaveAlone: ["cursor"] });
    const { settings } = await import("../src/config.js");
    expect(settings().maxPerDelivery).toBe(5);
    expect(settings().leaveAlone).toEqual(["cursor"]);
  });
  it("doesn't read the logs of a tool you left alone", async () => {
    useHome();
    const root = tmp(); process.env.MUNINN_LOG_ROOT = root;
    const dir = join(root, "claude", "projects", "-x"); mkdirSync(dir, { recursive: true });
    const repo = tmp();
    const { execFileSync } = await import("node:child_process"); execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ type: "user", sessionId: "s1", cwd: repo, timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "use pnpm, not npm" } }) + "\n");
    const { scanLogs } = await import("../src/logs/discover.js");
    expect(scanLogs().sessions.length).toBe(1);
    saveSettings({ leaveAlone: ["claude-code"] });
    expect(scanLogs().sessions.length).toBe(0);
    delete process.env.MUNINN_LOG_ROOT;
  });
});
