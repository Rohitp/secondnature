import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cursorRules, disableCursor, enableCursor, syncCursor } from "../src/deliver/cursor.js";
import { rulesMissing, setRules } from "../src/deliver/auto-rules.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { createLesson, decide, ensureRepo } from "../src/store/lessons.js";
import { tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "repo"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
const lesson = async (text: string, o: { alwaysOn?: boolean; keyword?: string; status?: "live" | "retired"; global?: boolean } = {}) => {
  const db = await openDb();
  const id = await createLesson(db, { repo_id: o.global ? null : repo, text, source: "manual", status: "live", by: "person" });
  await decide(db, id, { alwaysOn: !!o.alwaysOn, ...(o.keyword ? { triggers: [o.keyword] } : {}), ...(o.global ? { global: true } : {}), ...(o.status ? { status: o.status } : {}) });
  return id;
};
const dir = () => join(root, ".cursor", "rules");

describe("Cursor rules", () => {
  it("notices when the rules file was deleted, and putting it back writes it again", async () => {
    await lesson("Quote === in zsh", { alwaysOn: true });
    const db = await openDb();
    expect(await rulesMissing(db, repo, "cursor")).toBe(false);
    await enableCursor(db, repo);
    expect(await rulesMissing(db, repo, "cursor")).toBe(false);
    execFileSync("rm", [join(dir(), "muninn.mdc")]);
    expect(await rulesMissing(db, repo, "cursor")).toBe(true);
    await setRules(db, repo, "cursor", true);
    expect(await rulesMissing(db, repo, "cursor")).toBe(false);
  });
  it("puts always-on and global lessons in one always-applied file, and keyword lessons in agent-requested files", async () => {
    await lesson("Quote === in zsh", { alwaysOn: true });
    await lesson("Explain simply", { alwaysOn: true, global: true });
    await lesson("Set the key first", { keyword: "Estimate" });
    await lesson("Not routed");
    const files = await cursorRules(await openDb(), repo);
    expect(files.map((f) => f.name)).toEqual(["muninn.mdc", "muninn-estimate.mdc"]);
    expect(files[0]!.body).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---/);
    expect(files[0]!.body).toContain("- Quote === in zsh");
    expect(files[0]!.body).toContain("- Explain simply");
    expect(files[0]!.body).toContain("muninn ask");
    expect(files[0]!.body).not.toContain("Not routed");
    expect(files[1]!.body).toMatch(/description: ".*estimate.*"\nalwaysApply: false/);
  });
  it("writes files, keeps them out of git, and rewrites them when lessons change", async () => {
    const id = await lesson("Set the key first", { keyword: "estimate" });
    await enableCursor(await openDb(), repo);
    expect(readdirSync(dir()).sort()).toEqual(["muninn-estimate.mdc", "muninn.mdc"]);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".cursor/rules/muninn*.mdc");
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    await decide(await openDb(), id, { status: "retired" });
    await syncCursor(await openDb());
    expect(readdirSync(dir())).toEqual(["muninn.mdc"]);
  });
  it("leaves the engineer's own rules alone, and removes only muninn's", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "team.mdc"), "mine");
    await enableCursor(await openDb(), repo);
    await enableCursor(await openDb(), repo);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8").match(/muninn\*\.mdc/g)).toHaveLength(1);
    await disableCursor(await openDb(), repo);
    expect(readdirSync(dir())).toEqual(["team.mdc"]);
    await syncCursor(await openDb());
    expect(existsSync(join(dir(), "muninn.mdc"))).toBe(false);
  });
});
