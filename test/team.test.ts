import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cursorRules } from "../src/deliver/cursor.js";
import { deliver } from "../src/deliver/hook.js";
import { ignoredBy, importTeam, letThrough, parseTeamFile, share, TEAM_FILE, teamFile, unshare } from "../src/deliver/team.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { createLesson, decide, ensureRepo, listLessons } from "../src/store/lessons.js";
import { tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "repo"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
async function lesson(text: string, how: { always?: boolean; keyword?: string; global?: boolean } = {}) {
  const db = await openDb();
  const id = await createLesson(db, { repo_id: how.global ? null : repo, text, source: "manual", status: "live", by: "test", reviewed: true });
  await decide(db, id, how.keyword ? { triggers: [how.keyword] } : { alwaysOn: how.always ?? true });
  return id;
}
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("team lessons in the repo", () => {
  it("writes the shared copy and each tool's file, keeping what was already in them", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nOur own notes.\n");
    await lesson("Use pnpm, not npm.");
    await lesson("Migrations need a down step.", { keyword: "migration" });
    await lesson("Only for me, everywhere.", { global: true });
    await lesson("Only found by search.", { always: false });
    const r = await share(await openDb(), repo);
    expect(r.lessons).toBe(2);
    expect(r.files.sort()).toEqual([".agents/rules/team-lessons.md", ".cursor/rules/team-lessons.mdc", ".github/copilot-instructions.md", TEAM_FILE, "AGENTS.md", "CLAUDE.md"].sort());
    expect(read("CLAUDE.md")).toMatch(/^# Project\n\nOur own notes\.\n\n<!-- muninn:team:start -->/);
    expect(read("CLAUDE.md")).toContain('- When the task involves "migration": Migrations need a down step.');
    expect(read(TEAM_FILE)).not.toContain("Only for me");
    expect(read(TEAM_FILE)).not.toContain("Only found by search");
    expect(read(".cursor/rules/team-lessons.mdc")).toContain("alwaysApply: true");
    expect(read(".agents/rules/team-lessons.md")).toContain("trigger: always_on");
    // Running it again changes nothing; turning it off takes muninn's parts out and leaves yours.
    expect((await share(await openDb(), repo)).files).toEqual([]);
    await unshare(await openDb(), repo);
    expect(read("CLAUDE.md")).toBe("# Project\n\nOur own notes.\n");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, ".cursor/rules/team-lessons.mdc"))).toBe(false);
  });
  it("reads a teammate's lessons back, once", async () => {
    const ls = [{ id: "a", text: "Run make check before pushing.", keyword: null }, { id: "b", text: "Seed data lives in fixtures.", keyword: "seed" }];
    expect(parseTeamFile(teamFile(ls))).toEqual([{ text: "Run make check before pushing.", keyword: null }, { text: "Seed data lives in fixtures.", keyword: "seed" }]);
    mkdirSync(join(root, ".muninn")); writeFileSync(join(root, TEAM_FILE), teamFile(ls));
    const db = await openDb();
    expect(await importTeam(db, repo)).toBe(2);
    expect(await importTeam(db, repo)).toBe(0);
    const kept = await listLessons(db, { repo, status: "live" });
    expect(kept.find((l) => l.text === "Run make check before pushing.")).toMatchObject({ always_on: 1, source: "manual" });
  });
  it("doesn't send a lesson again that the agent already read in the team's files", async () => {
    const id = await lesson("Use pnpm, not npm.");
    const db = await openDb();
    await share(db, repo, ["claude", "cursor"]);
    const told = await deliver(db, "claude-code", { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: root });
    expect(told ?? "").not.toContain("Use pnpm");
    const logged = (await db.execute({ sql: "SELECT outcome, trigger_id FROM deliveries WHERE lesson_id=?", args: [id] })).rows[0];
    expect(logged).toMatchObject({ outcome: "sent", trigger_id: "CLAUDE.md" });
    // Codex reads AGENTS.md, which wasn't written here, so it still gets it from the hook.
    expect(await deliver(db, "codex", { hook_event_name: "SessionStart", source: "startup", session_id: "s2", cwd: root })).toContain("Use pnpm");
    // muninn's own Cursor rule leaves it out, since the team rule has it.
    expect((await cursorRules(db, repo, root))[0]!.body).not.toContain("Use pnpm");
  });
  it("says when git ignores the shared copy, and what to put in .gitignore to keep it", async () => {
    await lesson("Use pnpm, not npm.");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.muninn/\n");
    const r = await share(await openDb(), repo, ["cursor"]);
    expect(r.ignored).toMatchObject({ line: 2, pattern: ".muninn/" });
    // A "!" line can't bring back a file in an ignored folder: ignore the folder's contents instead.
    expect(letThrough(".muninn/")).toEqual([".muninn/*", `!${TEAM_FILE}`]);
    writeFileSync(join(root, ".gitignore"), `node_modules/\n${letThrough(".muninn/").join("\n")}\n`);
    expect(ignoredBy(root, TEAM_FILE)).toBeNull();
    expect(ignoredBy(root, ".muninn/out/x.log")).not.toBeNull();
    expect(letThrough("*.md")).toEqual([`!${TEAM_FILE}`]);
  });
});
