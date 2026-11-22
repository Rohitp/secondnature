import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableAntigravity, enableAntigravity, toAntigravity } from "../src/deliver/antigravity.js";
import { readAntigravity } from "../src/logs/antigravity.js";
import { scanLogs } from "../src/logs/discover.js";
import { installMcp, uninstallMcp } from "../src/mcp/install.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { createLesson, decide, ensureRepo } from "../src/store/lessons.js";
import { tmp, useHome, write } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "naksha"); mkdirSync(join(root, "src"), { recursive: true }); execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "src", "app.ts"), "x");
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
afterEach(() => { delete process.env.MUNINN_LOG_ROOT; });

const transcript = (dir: string) => {
  const f = join(dir, "antigravity-ide", "brain", "conv-1", ".system_generated", "logs", "transcript.jsonl");
  write(f, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "fix the build, the token is <private>abc</private>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Looking at the build.", tool_calls: [{ name: "view_file", args: { AbsolutePath: join(root, "src", "app.ts") } }, { name: "run_command", args: { CommandLine: "pnpm build", Cwd: root } }] },
    { step_index: 2, source: "SYSTEM", type: "RUN_COMMAND", status: "ERROR", content: "error TS2304: Cannot find name 'x'" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Fixed it." },
    { weird: true },
  ]);
  return f;
};

describe("Antigravity transcripts", () => {
  it("reads typed text, replies, commands with their failure, files, and the repo from the agent's paths", () => {
    const s = readAntigravity(transcript(tmp()));
    expect(s.id).toBe("conv-1");
    expect(s.tool).toBe("antigravity");
    expect(s.cwd).toBe(execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    expect(s.unknown).toBe(1);
    expect(s.events.map((e) => e.k)).toEqual(["typed", "agent", "file", "cmd", "agent"]);
    expect(s.events[0]).toMatchObject({ text: "fix the build, the token is [private]" });
    expect(s.events[3]).toMatchObject({ cmd: "pnpm build", failed: true });
  });
  it("reads the format Antigravity writes today: wrapped requests, arguments quoted twice, step times", () => {
    const f = join(tmp(), "antigravity", "brain", "conv-2", ".system_generated", "logs", "transcript.jsonl");
    write(f, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-21T14:03:43Z", content: "<USER_REQUEST>\nthere is a spec here. understand it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-21.\n</ADDITIONAL_METADATA>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-21T14:03:44Z", tool_calls: [{ name: "run_command", args: { CommandLine: '"ls -la"', Cwd: JSON.stringify(root) } }, { name: "read_file", args: { Path: JSON.stringify(join(root, "src", "app.ts")) } }] },
    ]);
    const s = readAntigravity(f);
    expect(s.events[0]).toEqual({ k: "typed", text: "there is a spec here. understand it", ts: "2026-11-21T14:03:43Z" });
    expect(s.events.find((e) => e.k === "file")).toMatchObject({ tool: "read", path: join(root, "src", "app.ts") });
    expect(s.events.find((e) => e.k === "cmd")).toMatchObject({ cmd: "ls -la" });
    expect(s.cwd).toBe(execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  });
  it("records how much of a file the agent was shown, and which lines, from the step after the read", () => {
    const f = join(tmp(), "antigravity", "brain", "conv-4", ".system_generated", "logs", "transcript.jsonl");
    const file = join(root, "src", "app.ts");
    write(f, [
      { step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", args: { Path: JSON.stringify(file), StartLine: '"400"', EndLine: '"480"' } }] },
      { step_index: 1, source: "MODEL", type: "GENERIC", status: "DONE", content: "Created At: 2026-11-21T17:17:50Z\nCompleted At: 2026-11-21T17:17:51Z\nShowing lines 400-480 of 601\n400: x" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "view_file", args: { AbsolutePath: file } }] },
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", content: "Showing lines 1-3 of 3\n1: a\n2: b\n3: c" },
    ]);
    const reads = readAntigravity(f).events.filter((e) => e.k === "file");
    expect(reads[0]).toMatchObject({ part: true, range: "400-480", size: "Showing lines 400-480 of 601\n400: x".length });
    expect(reads[1]).toMatchObject({ size: "Showing lines 1-3 of 3\n1: a\n2: b\n3: c".length });
    expect(reads[1]).not.toHaveProperty("part");
  });
  it("finds the repo from a file the agent read, with no folder given anywhere", () => {
    const f = join(tmp(), "antigravity", "brain", "conv-3", ".system_generated", "logs", "transcript.jsonl");
    write(f, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>read the spec</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: '"ls -la"' } }, { name: "read_file", args: { Path: JSON.stringify(join(root, "src", "app.ts")) } }] },
    ]);
    expect(readAntigravity(f).cwd).toBe(execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  });
  it("is found by scans in the app, IDE and command-line folders", () => {
    const logs = tmp(); process.env.MUNINN_LOG_ROOT = logs;
    transcript(join(logs, "antigravity"));
    const scan = scanLogs();
    expect(scan.files.antigravity).toBe(1);
    expect(scan.sessions.map((s) => s.tool)).toEqual(["antigravity"]);
  });
});

describe("Antigravity rules", () => {
  it("turns Cursor's rule frontmatter into Antigravity's", () => {
    expect(toAntigravity({ name: "muninn.mdc", body: "---\ndescription: x\nalwaysApply: true\n---\n\n# Lessons\n- a\n" })).toEqual({ name: "muninn.md", body: "---\ntrigger: always_on\n---\n\n# Lessons\n- a\n" });
    expect(toAntigravity({ name: "muninn-deploy.mdc", body: '---\ndescription: "Use when deploying"\nalwaysApply: false\n---\n\nbody' }).body).toBe('---\ntrigger: model_decision\ndescription: "Use when deploying"\n---\n\nbody');
  });
  it("writes kept lessons into .agents/rules, keeps them out of git, and removes only muninn's", async () => {
    const db = await openDb();
    const id = await createLesson(db, { repo_id: repo, text: "Run pnpm build before committing", source: "manual", status: "live", by: "person" });
    await decide(db, id, { alwaysOn: true });
    mkdirSync(join(root, ".agents", "rules"), { recursive: true });
    writeFileSync(join(root, ".agents", "rules", "mine.md"), "---\ntrigger: always_on\n---\nmine");
    await enableAntigravity(db, repo);
    const file = join(root, ".agents", "rules", "muninn.md");
    expect(readFileSync(file, "utf8")).toMatch(/^---\ntrigger: always_on\n---\n[\s\S]*- Run pnpm build before committing/);
    expect(execFileSync("git", ["-C", root, "check-ignore", ".agents/rules/muninn.md"], { encoding: "utf8" }).trim()).toBe(".agents/rules/muninn.md");
    expect(() => execFileSync("git", ["-C", root, "check-ignore", ".agents/rules/mine.md"], { stdio: "ignore" })).toThrow();
    await disableAntigravity(db, repo);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(root, ".agents", "rules", "mine.md"))).toBe(true);
  });
  it("adds muninn to Antigravity's MCP settings, even when the file is empty", () => {
    const file = process.env.MUNINN_ANTIGRAVITY_MCP!;
    mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "");
    process.env.MUNINN_DESKTOP_CONFIG = join(tmp(), "none", "claude_desktop_config.json");
    try {
      expect(installMcp()).toContain("Antigravity");
      expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.muninn.args.at(-1)).toBe("mcp");
      expect(uninstallMcp()).toContain("Antigravity");
      expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual({});
    } finally { delete process.env.MUNINN_DESKTOP_CONFIG; }
  });
});

describe("turning rules on by itself", () => {
  const sessionIn = (tool: "antigravity" | "cursor" | "claude-code") => ({ id: tool, tool, cwd: root, clientVersion: "1", unknown: 0, events: [] });
  it("turns on Antigravity's or Cursor's rules where you've used them, and says when", async () => {
    const { autoTurnOn, rulesState } = await import("../src/deliver/auto-rules.js");
    const db = await openDb();
    expect(await autoTurnOn(db, new Map([[repo, [sessionIn("claude-code")]]]))).toEqual([]);
    const on = await autoTurnOn(db, new Map([[repo, [sessionIn("claude-code"), sessionIn("antigravity")]]]));
    expect(on.map((t) => t.tool)).toEqual(["antigravity"]);
    expect(existsSync(join(root, ".agents", "rules"))).toBe(true);
    const st = await rulesState(db, repo);
    expect(st.antigravity.on).toBe(true);
    expect(st.antigravity.auto).toMatch(/^\d{4}-/);
    expect(st.cursor).toEqual({ on: false, auto: null });
    expect(await autoTurnOn(db, new Map([[repo, [sessionIn("antigravity")]]]))).toEqual([]);
    expect((await autoTurnOn(db, new Map([[repo, [sessionIn("cursor")]]]))).map((t) => t.tool)).toEqual(["cursor"]);
  });
  it("never turns them back on after you turned them off, until you turn them on yourself", async () => {
    const { autoTurnOn, rulesState, setRules } = await import("../src/deliver/auto-rules.js");
    const db = await openDb();
    const used = new Map([[repo, [sessionIn("antigravity")]]]);
    await autoTurnOn(db, used);
    await setRules(db, repo, "antigravity", false);
    expect(await autoTurnOn(db, used)).toEqual([]);
    expect((await rulesState(db, repo)).antigravity).toEqual({ on: false, auto: null });
    await setRules(db, repo, "antigravity", true);
    expect((await rulesState(db, repo)).antigravity).toEqual({ on: true, auto: null });
  });
});
