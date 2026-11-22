import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { redact } from "../privacy/redact.js";

/**
 * Every question an agent asks muninn: an MCP tool call, or `muninn ask` / `recall` / `related` run by an agent.
 * Shows whether muninn is useful to agents: what they ask, how often it finds something, and which lessons they find.
 * Questions you type yourself in a terminal are kept too, marked tool "terminal", so the page can leave them out.
 */
export type ResultRef = { kind: "lesson" | "note" | "session" | "plan" | "run" | "handoff" | "link" | "repo"; id: string };
export type QueryRow = {
  id: string; ts: string; repo: string | null; branch: string | null; session: string | null;
  /** Who asked: claude-code, codex, cursor, antigravity, claude-desktop, "agent" (an agent muninn couldn't name), or terminal (a person). */
  tool: string;
  /** Where: the MCP tool's name (search_history, get_runs…), or ask, recall, related for the command line. */
  surface: string;
  query: string; results: number; result_ids: ResultRef[]; ms: number;
  /** The text the agent got back (private details hidden, cut at 8,000 characters). None on rows from before it was kept. */
  answer?: string | null;
};

/** Who is running this `muninn` command: an agent's environment variables say which tool started it. */
export function whoIsAsking(env = process.env, tty = !!process.stdout.isTTY): { tool: string; session: string | null } {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return { tool: "claude-code", session: env.CLAUDE_CODE_SESSION_ID ?? null };
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return { tool: "codex", session: env.CODEX_SESSION_ID ?? null };
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return { tool: "cursor", session: null };
  if (Object.keys(env).some((k) => k.startsWith("ANTIGRAVITY"))) return { tool: "antigravity", session: null };
  return { tool: tty ? "terminal" : "agent", session: null };
}
/** An MCP client's name ("claude-code", "Claude Desktop", "antigravity") as muninn names tools. */
export function toolFromClient(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude-code") || n === "claude code") return "claude-code";
  if (n.includes("claude")) return "claude-desktop";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("antigravity") || n.includes("gemini")) return "antigravity";
  return n || "agent";
}

export async function recordQuery(db: Client, q: Omit<QueryRow, "id" | "ts" | "query"> & { query: string }): Promise<void> {
  try {
    await db.execute({
      sql: "INSERT INTO agent_queries (id,ts,repo,branch,session,tool,surface,query,results,result_ids,ms,answer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [randomUUID(), new Date().toISOString(), q.repo, q.branch, q.session, q.tool, q.surface, redact(q.query).slice(0, 300), q.results, JSON.stringify(q.result_ids.slice(0, 40)), Math.round(q.ms), q.answer == null ? null : redact(q.answer).slice(0, 8000)],
    });
  } catch { /* never let the log break an answer */ }
}

/** Questions asked, newest first: one repo's (and those asked with no repo), or all. `days` limits how far back. */
export async function listQueries(db: Client, o: { repo?: string | null; days?: number; limit?: number } = {}): Promise<QueryRow[]> {
  const where = [o.repo ? "(repo=? OR repo IS NULL)" : "1", o.days ? "ts>=?" : "1"].join(" AND ");
  const args = [...(o.repo ? [o.repo] : []), ...(o.days ? [new Date(Date.now() - o.days * 86_400_000).toISOString()] : [])];
  const rows = (await db.execute({ sql: `SELECT * FROM agent_queries WHERE ${where} ORDER BY ts DESC LIMIT ?`, args: [...args, o.limit ?? 500] })).rows;
  return rows.map((r) => ({ id: String(r.id), ts: String(r.ts), repo: r.repo == null ? null : String(r.repo), branch: r.branch == null ? null : String(r.branch), session: r.session == null ? null : String(r.session), tool: String(r.tool), surface: String(r.surface), query: String(r.query), results: Number(r.results), result_ids: JSON.parse(String(r.result_ids ?? "[]")), ms: Number(r.ms), answer: r.answer == null ? null : String(r.answer) }));
}

/** How often agents found each lesson (terminal questions left out): lesson id → count. */
export async function lessonFinds(db: Client, o: { days?: number } = {}): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const q of await listQueries(db, { days: o.days, limit: 5000 })) {
    if (q.tool === "terminal") continue;
    for (const r of new Set(q.result_ids.filter((x) => x.kind === "lesson" || x.kind === "note").map((x) => x.id))) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}
