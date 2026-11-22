import type { Client } from "@libsql/client";
import { cosine, type Embed } from "../embed/model.js";
import { redact } from "../privacy/redact.js";
import { listQueries } from "../store/queries.js";
import type { Moment } from "./signals.js";

/**
 * Questions agents asked muninn that found nothing, asked again: a gap in what muninn keeps. Agents' questions that
 * mean the same thing, at least UNANSWERED_MIN times in the last 30 days, become one moment. Your Claude gets what
 * muninn now holds that comes close (lessons, plan items, past sessions) and writes a note that answers it, or
 * nothing if the history doesn't show the answer. Questions you typed yourself don't count.
 */
export const UNANSWERED_MIN = 2;
const SAME = 0.8;
const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();

export async function unansweredMoments(db: Client, repo: string, embed: Embed, opts: { days?: number } = {}): Promise<Moment[]> {
  const asked = (await listQueries(db, { repo, days: opts.days ?? 30, limit: 2000 }))
    .filter((q) => q.repo === repo && q.tool !== "terminal" && q.surface !== "open_results" && q.results === 0 && q.query.trim().length >= 8);
  if (asked.length < UNANSWERED_MIN) return [];
  const vecs = await embed(asked.map((q) => norm(q.query)));
  const groups: (typeof asked)[] = [];
  for (const q of asked) {
    const v = vecs.get(norm(q.query))!;
    const g = groups.find((g) => cosine(vecs.get(norm(g[0]!.query))!, v) >= SAME);
    if (g) g.push(q); else groups.push([q]);
  }
  const out: Moment[] = [];
  const { gatherSources } = await import("../commands/answer.js");
  for (const g of groups.filter((g) => g.length >= UNANSWERED_MIN)) {
    const q = g[0]!.query;
    // What muninn holds now that comes close: the answer may have been learned since, or sit in a session it didn't rank.
    const near = await gatherSources(db, q, repo, embed, { limit: 6 }).catch(() => []);
    const tools = [...new Set(g.map((x) => x.tool))];
    out.push({
      signal: "unanswered",
      text: redact(`Agents asked muninn ${g.length} times and it found nothing: "${q}"`),
      quotes: g.slice(0, 8).map((x) => ({ tool: x.tool, session: x.session ?? x.id, ts: x.ts, quote: redact(`${x.surface}: ${x.query}`).slice(0, 240) })),
      sessions: new Set(g.map((x) => x.session ?? x.id)).size, days: new Set(g.map((x) => x.ts.slice(0, 10))).size, wordings: new Set(g.map((x) => norm(x.query))).size,
      tools, last: g.map((x) => x.ts).sort().at(-1)!,
      context: near.length ? redact(`What muninn holds now that comes close:\n${near.map((s) => `${s.kind.toUpperCase()} (${s.where}${s.date ? `, ${s.date}` : ""}): ${s.text.slice(0, 600)}`).join("\n\n")}`).slice(0, 4000) : "muninn holds nothing close to this.",
    });
  }
  return out;
}
