import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { cosine, type Embed } from "../embed/model.js";
import type { Session } from "../logs/types.js";
import { addEvidence, createLesson, evidenceIndex, lessonVectors, ownerOf, touchSeen } from "../store/lessons.js";
import { findMoments, type Moment, type Signal } from "./signals.js";
import type { Writer, Written } from "./writer.js";

const NEG = /\b(not|never|don'?t|no|avoid|stop|cannot|won'?t|shouldn'?t|without)\b/i;
export type LearnResult = { moments: Record<string, number>; written: number; discarded: number; newLessons: number; addedEvidence: number; dropped: number; skippedNoWriter: number; known: number };

const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();

/** Finds moments in a repo's sessions and stores new candidates as proposed. Nothing goes live here. */
/** Identifies a moment by its quotes, so the writer's verdict can be remembered. */
export const momentKey = (m: Moment) => createHash("sha1").update(m.signal + "\u0000" + m.quotes.map((q) => `${q.session}\u0000${q.quote}`).sort().join("\u0001")).digest("hex");

export async function learnRepo(db: Client, repo: string, sessions: Session[], deps: { embed: Embed; writer: Writer | null; cutoff: number; minSessions: number; notesPerRun?: number; extra?: Moment[] }): Promise<LearnResult> {
  const found = [...(await findMoments(sessions, deps.embed, { cutoff: deps.cutoff, minSessions: deps.minSessions })), ...(deps.extra ?? [])];
  const res: LearnResult = { moments: {}, written: 0, discarded: 0, newLessons: 0, addedEvidence: 0, dropped: 0, skippedNoWriter: 0, known: 0 };
  for (const m of found) res.moments[m.signal] = (res.moments[m.signal] ?? 0) + 1;

  // A moment built from quotes a lesson already holds is that lesson again, however the writer would word it.
  // Add the new evidence there and skip writing. Quotes behind a rejected or retired lesson stay dropped.
  const idx = await evidenceIndex(db, repo);
  const judged = new Set((await db.execute({ sql: "SELECT key FROM judged WHERE repo_id=?", args: [repo] })).rows.map((r) => String(r.key)));
  const moments: Moment[] = [];
  let notes = 0;
  // Newest first, so the note limit keeps recent explanations. Older ones come in later runs.
  for (const m of [...found].sort((a, b) => b.last.localeCompare(a.last))) {
    if (judged.has(momentKey(m))) continue;
    const owner = ownerOf(idx, m.quotes);
    if (!owner) {
      if (m.signal === "explained" && (!deps.writer || notes++ >= (deps.notesPerRun ?? 30))) continue;
      moments.push(m); continue;
    }
    res.known++;
    if (owner.status === "live" || owner.status === "proposed") { await addEvidence(db, owner.id, m.quotes); await touchSeen(db, owner.id, m.sessions, m.last); }
    else res.dropped++;
  }

  // Repeats keep the engineer's words without a writer. The other signals need one.
  let texts: Written[];
  if (!moments.length) texts = [];
  else if (deps.writer && (texts = await deps.writer.write(moments).catch((e) => { if (e?.name === "AiUnavailable") return null as unknown as Written[]; throw e; }))) {
    res.written = texts.filter(Boolean).length;
    res.discarded = texts.filter((t) => !t).length;
    const at = new Date().toISOString();
    for (const [i, t] of texts.entries()) if (!t) await db.execute({ sql: "INSERT OR REPLACE INTO judged (repo_id,key,verdict,at) VALUES (?,?,'noise',?)", args: [repo, momentKey(moments[i]!), at] });
  } else {
    // No writer, or it ran out of usage: repeats keep your words; the rest wait for a later scan (nothing is marked as noise).
    texts = moments.map((m) => (m.signal === "repeat" ? { text: m.text, scope: "repo" } : null));
    res.skippedNoWriter = moments.filter((m) => m.signal !== "repeat").length;
  }
  const kept: { m: Moment; text: string; scope: string; keywords?: string[]; why?: string; vector: Float32Array }[] = [];
  const vectors = await deps.embed(texts.flatMap((t) => (t ? [norm(t.text)] : [])));
  moments.forEach((m, i) => { const t = texts[i]; if (t) kept.push({ m, text: t.text, scope: t.scope, keywords: t.keywords, why: t.why, vector: vectors.get(norm(t.text))! }); });

  const existing = await lessonVectors(db, repo);
  for (const k of kept) {
    const neg = NEG.test(k.text);
    const blocked = existing.find((e) => e.vector && ["rejected", "retired"].includes(e.status) && cosine(e.vector, k.vector) >= 0.98);
    if (blocked) { res.dropped++; continue; }
    // The same advice for two roles is two lessons: each role is told only its own.
    const same = existing.find((e) => e.vector && ["proposed", "live"].includes(e.status) && (e.role ?? null) === (k.m.role ?? null) && cosine(e.vector, k.vector) >= deps.cutoff && NEG.test(e.text) === neg);
    if (same) {
      await addEvidence(db, same.id, k.m.quotes); await touchSeen(db, same.id, k.m.sessions, k.m.last);
      if (k.why) await db.execute({ sql: "UPDATE lessons SET why=? WHERE id=? AND why IS NULL", args: [k.why, same.id] });
      // Seen again: keep the larger measure (a session still running is read again as it grows, so adding would count twice).
      if (k.m.wasted) await db.execute({ sql: "UPDATE lessons SET wasted_tokens=max(coalesce(wasted_tokens,0),?) WHERE id=?", args: [k.m.wasted, same.id] });
      res.addedEvidence++; continue;
    }
    const source = k.m.signal === "repeat" && !deps.writer ? "own_words" : "inferred";
    const id = await createLesson(db, { repo_id: repo, text: k.text, source, signal: k.m.signal, suggestedScope: k.scope, kind: k.m.signal === "explained" || k.m.signal === "unanswered" ? "note" : "rule", suggestedKeywords: k.keywords, status: "proposed", sessions: k.m.sessions, last_seen: k.m.last, vector: k.vector, by: deps.writer ? `learn:${deps.writer.name}` : "learn", wasted: k.m.wasted, why: k.why, role: k.m.role });
    await addEvidence(db, id, k.m.quotes);
    existing.push({ id, status: "proposed", text: k.text, vector: k.vector, role: k.m.role ?? null });
    res.newLessons++;
  }
  return res;
}

/** Top candidates, with no one signal taking more than half. */
export function pickToShow<T extends { signal: string | null }>(ranked: T[], limit: number): T[] {
  const cap = Math.ceil(limit / 2); const used: Record<string, number> = {}; const out: T[] = [];
  for (const l of ranked) {
    const s = l.signal ?? "manual";
    if ((used[s] ?? 0) >= cap || out.length >= limit) continue;
    used[s] = (used[s] ?? 0) + 1; out.push(l);
  }
  return out;
}
export type { Signal };
