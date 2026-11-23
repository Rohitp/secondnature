import type { Client } from "@libsql/client";
import { getPlan } from "../plan/plan.js";
import type { Runner } from "../learn/writer.js";

/**
 * The "why" for a branch's pull request, written by your Claude from the branch's plan and the summaries its
 * sessions left: what the change does, why, what was decided and what was tried and dropped. Kept, so the Plan
 * page shows it again until you ask for a new one. Nothing is sent anywhere: you read it and paste it yourself.
 */
export type PrWhy = { text: string; sessions: number; at: string };
const key = (repo: string, branch: string) => `pr_why:${repo}:${branch}`;

export async function savedPrWhy(db: Client, repo: string, branch: string): Promise<PrWhy | null> {
  const v = (await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [key(repo, branch)] })).rows[0]?.value;
  try { return v ? (JSON.parse(String(v)) as PrWhy) : null; } catch { return null; }
}

/** Everything the note is written from, as plain text. Null when there's nothing to write from. */
export async function prWhyContext(db: Client, repo: string, branch: string): Promise<{ text: string; sessions: number } | null> {
  const p = await getPlan(db, repo, branch);
  const handoffs = (await db.execute({ sql: "SELECT text, created_at FROM handoffs WHERE repo_id=? AND branch=? ORDER BY created_at DESC LIMIT 6", args: [repo, branch] })).rows;
  const sessions = Number((await db.execute({ sql: "SELECT count(DISTINCT session) n FROM chunks WHERE repo_id=? AND branch=?", args: [repo, branch] })).rows[0]?.n ?? 0) || handoffs.length;
  const parts = [
    p.goal ? `Goal: ${p.goal.text}` : "",
    p.decisions.length ? `Decided:\n${p.decisions.map((d) => `- ${d.text}`).join("\n")}` : "",
    p.done.length ? `Done:\n${p.done.slice(-15).map((d) => `- ${d.text}`).join("\n")}` : "",
    p.open.length ? `Still open:\n${p.open.map((d) => `- ${d.text}`).join("\n")}` : "",
    handoffs.length ? `What the sessions on this branch said when they ended, newest first:\n${handoffs.map((h) => `---\n${String(h.text).slice(0, 1500)}`).join("\n")}` : "",
  ].filter(Boolean);
  return parts.length ? { text: parts.join("\n\n"), sessions } : null;
}

export const prWhyPrompt = (branch: string, context: string) => `Write the description for a pull request from the branch "${branch}", from the notes below about the work on it.

Plain text, no markdown headings, under 180 words. In this order, leaving out any part the notes don't support:
- One line saying what the change does.
- "Why:" the problem it solves.
- "Decided:" the choices made, each with its reason, as "- " lines.
- "Tried and dropped:" anything tried and reverted, and why.
- "How to test:" only if the notes say how.
Use only what the notes say. Don't invent numbers, files or results. Plain words; explain any internal name.

Notes:
${context}`;

export async function writePrWhy(db: Client, repo: string, branch: string, runner: Runner): Promise<PrWhy> {
  const ctx = await prWhyContext(db, repo, branch);
  if (!ctx) throw new Error("There's nothing on this branch to write from yet: no plan and no session summaries.");
  const prompt = prWhyPrompt(branch, ctx.text);
  const reply = (runner.runAsync ? await runner.runAsync(prompt) : runner.run(prompt)).trim();
  if (!reply) throw new Error("Your Claude didn't write anything. Try again.");
  const out: PrWhy = { text: reply, sessions: ctx.sessions, at: new Date().toISOString() };
  await db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [key(repo, branch), JSON.stringify(out)] });
  return out;
}

/** The end of a session, as the Plan page shows it under "Where you left off": its last few exchanges, redacted as stored. */
export async function sessionTail(db: Client, session: string, n = 3) {
  const rows = (await db.execute({ sql: "SELECT tool, ts, text FROM chunks WHERE session=? ORDER BY seq", args: [session] })).rows;
  if (!rows.length) return null;
  const line = (t: string, tag: string) => (t.match(new RegExp(`^${tag}: ([\\s\\S]*?)(?=\\n(?:ENGINEER|AGENT|RAN|FILES): |$)`, "m"))?.[1] ?? "").trim();
  return {
    tool: String(rows[0]!.tool), from: String(rows[0]!.ts), to: String(rows.at(-1)!.ts),
    exchanges: rows.slice(-n).map((r) => ({ you: line(String(r.text), "ENGINEER"), agent: line(String(r.text), "AGENT") })),
  };
}
