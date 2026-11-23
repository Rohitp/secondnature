import { beforeEach, describe, expect, it } from "vitest";
import { similar } from "../src/commands/review.js";
import { buildFoldPrompt, parseFold } from "../src/learn/fold.js";
import { callTool } from "../src/mcp/server.js";
import { openDb } from "../src/store/db.js";
import { addToOlder, createLesson, decide, getLesson } from "../src/store/lessons.js";
import { fakeEmbed, useHome } from "./helpers.js";

beforeEach(useHome);
const vec = async (t: string) => (await fakeEmbed([t])).get(t)!;
const OLDER = "When a report introduces a name, say in plain words what it is, and end with the exact steps to test it and what they should see";
const NEWER = "When a report introduces a name, say in plain words what it is, and end with the exact steps to test it and what you will do next";

async function seed() {
  const db = await openDb();
  for (const r of ["github.com/me/servanda", "github.com/me/workbench"]) await db.execute({ sql: "INSERT INTO repos (id,paths) VALUES (?,'[]')", args: [r] });
  // Kept for every repo, but learned in another repo: the case muninn used to miss.
  const older = await createLesson(db, { repo_id: "github.com/me/servanda", text: OLDER, source: "inferred", status: "live", by: "person", vector: await vec(OLDER), why: "You asked what a name meant." });
  await decide(db, older, { global: true, alwaysOn: true });
  const newer = await createLesson(db, { repo_id: "github.com/me/workbench", text: NEWER, source: "inferred", status: "proposed", by: "learn", vector: await vec(NEWER) });
  await db.execute({ sql: "INSERT INTO evidence VALUES (?,?,?,?,?)", args: [newer, "claude-code", "s9", "2026-11-23T10:00:00Z", "what is a harness PR?"] });
  return { db, older, newer };
}

describe("a suggestion close to an older lesson", () => {
  it("is matched to a lesson kept for every repo, even one learned in another repo", async () => {
    const { db, older, newer } = await seed();
    const sim = await similar(db, (await getLesson(db, newer))!);
    expect(sim?.lesson.id).toBe(older);
  });
  it("can be added to the older lesson, which keeps where and when it's told", async () => {
    const { db, older, newer } = await seed();
    await addToOlder(db, newer, older, `${OLDER}, and what you will do next`);
    const o = (await getLesson(db, older))!; const n = (await getLesson(db, newer))!;
    expect(n.status).toBe("retired");
    expect(o.text).toMatch(/what you will do next$/);
    expect([o.status, o.scope, o.always_on]).toEqual(["live", "global", 1]);
    expect((await db.execute({ sql: "SELECT quote FROM evidence WHERE lesson_id=?", args: [older] })).rows.map((r) => r.quote)).toEqual(["what is a harness PR?"]);
  });
  it("keeps the older lesson's words when no new wording is given", async () => {
    const { db, older, newer } = await seed();
    await addToOlder(db, newer, older);
    expect((await getLesson(db, older))!.text).toBe(OLDER);
  });
  it("is named in list_lessons, and review_lesson can add it to the older lesson", async () => {
    const { db, older, newer } = await seed();
    const embed = async () => fakeEmbed;
    expect(await callTool(db, "list_lessons", { repo: "workbench", waiting: true }, embed)).toContain(`Close to kept lesson [${older.slice(0, 8)}], told in every repo`);
    const out = await callTool(db, "review_lesson", { id: newer.slice(0, 8), action: "add_to_older", text: "Explain new names and say what's next.", engineer_said: "fold it into the older one" }, embed);
    expect(out).toMatch(/It's still told in every repo/);
    expect((await getLesson(db, older))!.text).toBe("Explain new names and say what's next.");
    expect((await getLesson(db, newer))!.status).toBe("retired");
  });
});

describe("the combined wording draft", () => {
  it("asks for the older lesson plus only the new point, and falls back to the older words", () => {
    expect(buildFoldPrompt("a", "b")).toContain('OLDER: "a"');
    expect(parseFold('"Explain names, and say what is next."\n', "old")).toBe("Explain names, and say what is next.");
    expect(parseFold("", "old")).toBe("old");
    // Only sharing a topic isn't the same lesson: the engineer is told, and nothing is merged.
    expect(parseFold("DIFFERENT", "old")).toBeNull();
  });
});
