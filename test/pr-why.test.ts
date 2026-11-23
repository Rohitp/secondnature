import { beforeEach, describe, expect, it } from "vitest";
import { prWhyContext, savedPrWhy, sessionTail, writePrWhy } from "../src/commands/pr-why.js";
import { addItem } from "../src/plan/plan.js";
import { openDb } from "../src/store/db.js";
import { useHome } from "./helpers.js";

const repo = "github.com/me/app";
beforeEach(() => { useHome(); });

describe("the pull request's why", () => {
  it("has nothing to write from on an empty branch", async () => {
    const db = await openDb();
    expect(await prWhyContext(db, repo, "empty")).toBeNull();
    const runner = { name: "fake", run: () => "x" };
    await expect(writePrWhy(db, repo, "empty", runner)).rejects.toThrow(/nothing on this branch/);
  });
  it("is written from the plan and the sessions' summaries, and kept", async () => {
    const db = await openDb();
    await addItem(db, repo, "parser", "goal", "Move ingestion to the new parser", { person: true });
    await addItem(db, repo, "parser", "decision", "No cache of parsed contracts", { person: true });
    await db.execute({ sql: "INSERT INTO handoffs (id,repo_id,branch,session,tool,text,created_at) VALUES ('h1',?,?,?,?,?,?)", args: [repo, "parser", "s1", "claude-code", "Done: dates parse. Tried: a regex for currency codes, reverted.", new Date().toISOString()] });
    let sent = "";
    const runner = { name: "fake", run: (p: string) => { sent = p; return "Moves ingestion to the new parser.\n\nWhy: dates were missed."; } };
    const w = await writePrWhy(db, repo, "parser", runner);
    expect(sent).toContain("Goal: Move ingestion to the new parser");
    expect(sent).toContain("- No cache of parsed contracts");
    expect(sent).toContain("a regex for currency codes");
    expect(w.text).toMatch(/^Moves ingestion/);
    expect(w.sessions).toBe(1);
    expect((await savedPrWhy(db, repo, "parser"))?.text).toBe(w.text);
    expect(await savedPrWhy(db, repo, "other")).toBeNull();
  });
});

describe("a session's last exchanges", () => {
  it("shows what you typed and what the agent said, last ones only", async () => {
    const db = await openDb();
    const add = (seq: number, text: string) => db.execute({ sql: "INSERT INTO chunks (id,repo_id,session,tool,branch,ts,seq,text) VALUES (?,?,?,?,?,?,?,?)", args: [`c${seq}`, repo, "s1", "claude-code", "main", `2026-11-23T1${seq}:00:00Z`, seq, text] });
    await add(1, "ENGINEER: first\nAGENT: one");
    await add(2, "ENGINEER: try a regex\nAGENT: Added it.\nRAN: `npm test` failed: 3 amounts parse as 0");
    await add(3, "ENGINEER: leave it\nAGENT: Reverted.");
    await add(4, "ENGINEER: next time use the money parser");
    const t = await sessionTail(db, "s1");
    expect(t?.tool).toBe("claude-code");
    expect(t?.exchanges).toEqual([
      { you: "try a regex", agent: "Added it." },
      { you: "leave it", agent: "Reverted." },
      { you: "next time use the money parser", agent: "" },
    ]);
    expect(await sessionTail(db, "nope")).toBeNull();
  });
});
