import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { headline, proofData, proofHtml } from "../src/learn/proof.js";
import type { Session } from "../src/logs/types.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { createLesson, ensureRepo } from "../src/store/lessons.js";
import { tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "repo"); mkdirSync(join(root, "src"), { recursive: true }); execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "src", "app.ts"), "x");
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
const at = (d: number) => new Date(Date.UTC(2026, 10, d, 10)).toISOString();
const sess = (id: string, d: number): Session => ({ id, tool: "claude-code", cwd: root, clientVersion: "1", unknown: 0, events: [{ k: "typed", text: "hi", ts: at(d) }] });

async function kept(text: string, d: number) {
  const db = await openDb();
  const id = await createLesson(db, { repo_id: repo, text, source: "inferred", status: "live", by: "test", reviewed: true });
  await db.execute({ sql: "UPDATE lessons SET reviewed_at=?, created_at=? WHERE id=?", args: [at(d), at(d), id] });
  return id;
}
async function told(id: string, session: string, d: number) {
  await (await openDb()).execute({ sql: "INSERT INTO deliveries (id,ts,tool,session,event,lesson_id,outcome,tokens) VALUES (?,?,?,?,?,?,?,?)", args: [`${id}-${session}`, at(d), "claude-code", session, "SessionStart", id, "sent", 10] });
}
async function seen(id: string, session: string, d: number) {
  await (await openDb()).execute({ sql: "INSERT INTO evidence (lesson_id,tool,session,seen_at,quote) VALUES (?,?,?,?,?)", args: [id, "claude-code", session, at(d), `q-${session}`] });
}

describe("proof", () => {
  it("sorts kept lessons into worked, came back and too early, and flags stale ones", async () => {
    const db = await openDb();
    const sessions = [sess("s1", 2), sess("s2", 3), sess("s3", 4), sess("s4", 5)];
    // Told, three sessions since, never came back: worked.
    const good = await kept("Edit `src/app.ts` with care.", 1);
    for (const s of ["s1", "s2", "s3"]) await told(good, s, [2, 3, 4][Number(s[1]) - 1]!);
    // Told, and the problem came back in two sessions anyway: came back, and stale.
    const bad = await kept("Run the linter before committing.", 1);
    for (const [s, d] of [["s1", 2], ["s2", 3]] as const) { await told(bad, s, d); await seen(bad, s, d); }
    // Kept just now: too early. It names a file that's gone: stale.
    const early = await kept("Config lives in `src/old-config.ts`.", 5);

    const p = await proofData(db, repo, sessions);
    const by = (id: string) => p.lessons.find((l) => l.id === id)!;
    expect(by(good)).toMatchObject({ outcome: "worked", sessionsSince: 4, stale: null });
    expect(by(bad)).toMatchObject({ outcome: "came_back", stale: { reason: "did_nothing" } });
    expect(by(early)).toMatchObject({ outcome: "too_early", stale: { reason: "missing_path" } });
    expect(headline(p)).toBe("3 kept. 1 worked. 1 came back. 1 too early to tell. 2 look stale: retire or rewrite them.");

    const html = proofHtml(p);
    expect(html).toContain("Did the lessons work?");
    expect(html).toContain("How this is measured");
    expect(html).toContain("src/old-config.ts");
    expect(html).not.toContain("<script");
  });
});
