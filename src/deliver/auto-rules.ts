import type { Client } from "@libsql/client";
import type { Session } from "../logs/types.js";
import { leftAlone } from "../config.js";

/**
 * Cursor and Antigravity have no hooks, so their agents only hear lessons through rules files in the repo.
 * Once muninn sees you use one of them in a repo, it turns those files on there by itself and says so on the page.
 * If you turn them off, muninn remembers and never turns them back on for that repo.
 */
export type RulesTool = "cursor" | "antigravity";
export const RULES_TOOLS: RulesTool[] = ["cursor", "antigravity"];
export const TOOL_NAME: Record<RulesTool, string> = { cursor: "Cursor", antigravity: "Antigravity" };

const mod = (t: RulesTool) => (t === "cursor" ? import("./cursor.js").then((m) => ({ enabled: m.enabled, on: m.enableCursor, off: m.disableCursor }))
  : import("./antigravity.js").then((m) => ({ enabled: m.enabled, on: m.enableAntigravity, off: m.disableAntigravity })));
const getMeta = async (db: Client, key: string) => { const v = (await db.execute({ sql: "SELECT value FROM meta WHERE key=?", args: [key] })).rows[0]?.value; return v == null ? null : String(v); };
const setMeta = (db: Client, key: string, value: string | null) => value === null
  ? db.execute({ sql: "DELETE FROM meta WHERE key=?", args: [key] })
  : db.execute({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", args: [key, value] });
const offKey = (t: RulesTool, repo: string) => `rules_off:${t}:${repo}`;
const autoKey = (t: RulesTool, repo: string) => `rules_auto:${t}:${repo}`;

/** Turns rules on for each repo where a Cursor or Antigravity session was seen, unless you turned them off there. */
export async function autoTurnOn(db: Client, byRepo: Map<string, Session[]>): Promise<{ tool: RulesTool; repo: string; files: string[] }[]> {
  const out: { tool: RulesTool; repo: string; files: string[] }[] = [];
  for (const tool of RULES_TOOLS) {
    if (leftAlone(tool)) continue; // you unticked it in setup
    const m = await mod(tool);
    const on = new Set(await m.enabled(db));
    for (const [repo, sessions] of byRepo) {
      if (on.has(repo) || !sessions.some((s) => s.tool === tool) || (await getMeta(db, offKey(tool, repo)))) continue;
      const r = await m.on(db, repo).catch(() => null);
      if (!r) continue; // the repo's folder isn't on this machine
      await setMeta(db, autoKey(tool, repo), new Date().toISOString());
      out.push({ tool, repo, files: r.files });
    }
  }
  return out;
}

/** Whether each tool's rules are on in a repo, and when muninn turned them on by itself (null if you did). */
export async function rulesState(db: Client, repo: string): Promise<Record<RulesTool, { on: boolean; auto: string | null }>> {
  const out = {} as Record<RulesTool, { on: boolean; auto: string | null }>;
  for (const tool of RULES_TOOLS) {
    const on = (await (await mod(tool)).enabled(db)).includes(repo);
    out[tool] = { on, auto: on ? await getMeta(db, autoKey(tool, repo)) : null };
  }
  return out;
}

/** You turning rules on or off. Off is remembered, so a later session doesn't turn them back on. */
export async function setRules(db: Client, repo: string, tool: RulesTool, on: boolean) {
  const m = await mod(tool);
  await setMeta(db, autoKey(tool, repo), null);
  if (on) { await setMeta(db, offKey(tool, repo), null); return m.on(db, repo); }
  await m.off(db, repo);
  await setMeta(db, offKey(tool, repo), new Date().toISOString());
  return null;
}
