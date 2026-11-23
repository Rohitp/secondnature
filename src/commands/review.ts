import type { Client } from "@libsql/client";
import { createInterface, type Interface } from "node:readline/promises";
import { settings } from "../config.js";
import { cosine } from "../embed/model.js";
import { pickToShow } from "../learn/pipeline.js";
import { addToOlder, combine, decide, getLesson, keywordsInUse, lessonsForKeyword, lessonVectors, listLessons, markShown, type Lesson } from "../store/lessons.js";

const STOP = new Set(["about", "after", "always", "before", "because", "never", "should", "their", "there", "these", "those", "using", "which", "would", "could", "answer", "answers", "agent", "lesson", "first", "other", "while", "without", "instead", "every", "where"]);
/** A keyword the engineer would likely type for this lesson: a command or path in backticks, or its most specific word. */
/**
 * Words too common to trigger on: they come up in nearly every prompt or command, so a lesson keyed on them
 * would be sent all the time. Command runners and everyday shell words are the usual culprits ("uv run python" → "run").
 */
const COMMON = new Set(["run", "runs", "make", "test", "tests", "build", "check", "fix", "use", "get", "set", "add", "new", "file", "files", "code", "the", "and", "for", "with", "this", "that", "all", "not", "out", "help",
  "uv", "npx", "npm", "pnpm", "yarn", "bun", "node", "python", "python3", "pip", "bash", "sh", "zsh", "sudo", "exec", "env", "cd", "ls", "cat", "echo", "git", "eof", "true", "false"]);
/** Whether a word is specific enough to trigger a lesson on. */
export const usefulKeyword = (w: string) => w.length >= 3 && !COMMON.has(w.toLowerCase()) && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w);
export function suggestKeyword(text: string): string {
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const tick = m[1]!.split(/[\s/=:]+/).map((w) => w.replace(/^['"(<]+|['")>]+$/g, "")).find((w) => /^[\w.-]{3,}$/.test(w) && !w.startsWith("-") && usefulKeyword(w));
    if (tick) return tick.toLowerCase();
  }
  const words = text.toLowerCase().replace(/`[^`]*`/g, " ").match(/[a-z][a-z0-9_-]{4,}/g) ?? [];
  return words.filter(usefulKeyword).sort((a, b) => b.length - a.length)[0] ?? "";
}
const HOW = `
  How kept lessons reach your agent, once you run "muninn install":
    a  Always-on: sent at the start of every session in this repo, and again after compaction.
       Use it for things that apply to most work here.
    k  Keyword: sent when your prompt contains a word you choose, or a failed command does.
       Example: keyword "estimate" sends the lesson with "run the estimate tests".
       Use it for one task, test suite or script.
    n  Neither: kept and searchable, never sent automatically.
  You can change this later with "muninn edit <id>".`;

export async function similar(db: Client, l: Lesson): Promise<{ lesson: Lesson; score: number } | null> {
  if (!l.repo_id) return null;
  // Kept lessons told in every repo count too, wherever they were learned: a suggestion here can repeat one from another repo.
  const all = await lessonVectors(db, l.repo_id, { withGlobal: true });
  const me = all.find((x) => x.id === l.id)?.vector;
  if (!me) return null;
  let best: { id: string; score: number } | null = null;
  for (const x of all) {
    if (x.id === l.id || !x.vector || !["proposed", "live"].includes(x.status)) continue;
    const score = cosine(me, x.vector);
    if (score >= 0.75 && (!best || score > best.score)) best = { id: x.id, score };
  }
  const lesson = best ? await getLesson(db, best.id) : null;
  return lesson && best ? { lesson, score: best.score } : null;
}

/**
 * Lessons about how the engineer likes to work (explanations, tone, pace). They phrase these many ways,
 * so a keyword misses most of them: on Nov 12 "simplify" never matched "step by step" in 99 prompts.
 */
export const isPreference = (l: { text: string; suggested_scope?: string | null }) =>
  /\b(explain|explanation|answers?|step by step|plain (words|language|english)|jargon|concise|brief|overwhelm|tone|wording|i dont understand|the user|you've asked)\b/i.test(l.text);

export type Defaults = { route: "always" | "keyword" | "none"; keywords: string[]; global: boolean };
/**
 * What muninn would pick, so most reviews are one keypress or one click:
 * how-you-work lessons always-on everywhere; notes and command fixes on their keywords; the rest always-on here.
 */
export function defaultRoute(l: Pick<Lesson, "text" | "kind" | "signal" | "suggested_keywords" | "suggested_scope">): Defaults {
  // A rule you stated once: told every session, but in this repo only until you widen it or it comes up elsewhere.
  if (l.signal === "stated") return { route: "always", keywords: [], global: false };
  if (isPreference(l)) return { route: "always", keywords: [], global: true };
  const suggested: string[] = (l.suggested_keywords ? (JSON.parse(l.suggested_keywords) as string[]) : []).filter(usefulKeyword);
  const guess = suggestKeyword(l.text);
  const global = l.suggested_scope === "global";
  if (l.kind === "note") return { route: "keyword", keywords: suggested.length ? suggested : guess ? [guess] : [], global: false };
  if ((l.signal === "failure_then_fix" || l.signal === "mistake_returned" || l.signal === "loop" || l.signal === "refetch" || l.signal === "stopped" || l.signal === "wrong_path" || l.signal === "big_file" || l.signal === "big_output" || l.signal === "reread" || l.signal === "one_by_one") && guess) return { route: "keyword", keywords: [guess], global };
  return { route: "always", keywords: [], global };
}

async function chooseRoute(db: Client, rl: Interface, l: Lesson, explained: { done: boolean }) {
  if (!explained.done) { console.log(HOW); explained.done = true; }
  const pref = isPreference(l);
  const def = defaultRoute(l);
  if (pref) console.log("  This is about how you like to work, so always-on fits best. A keyword misses the many ways you'd say it.");
  const letter = def.route === "always" ? "a" : def.route === "keyword" ? "k" : "n";
  let route = (await rl.question(`  Deliver: (a)lways-on, (k)eyword, or (n)either? [${letter}] `)).trim().toLowerCase();
  if (!route) route = letter;
  if (route.startsWith("k") && pref && !(await rl.question("  A keyword will often miss this one. Use a keyword anyway (y/n)? ")).trim().toLowerCase().startsWith("y")) route = "a";
  if (route.startsWith("a")) return { alwaysOn: true, triggers: [] as string[] };
  if (!route.startsWith("k")) { console.log("  Kept. It's searchable, but won't be sent automatically."); return { alwaysOn: false, triggers: [] as string[] }; }
  const used = await keywordsInUse(db, l.repo_id);
  if (used.length) console.log(`  Keywords in use: ${used.map((u) => `${u.pattern} (${u.lessons})`).join(", ")}`);
  const suggestion = def.keywords.join(", ") || suggestKeyword(l.text);
  const typed = (await rl.question(`  Keyword(s), comma-separated${suggestion ? ` [${suggestion}]` : ""}: `)).trim();
  const keywords = (typed || suggestion).toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) return { alwaysOn: false, triggers: [] as string[] };
  for (const keyword of keywords) {
    const sharing = await lessonsForKeyword(db, l.repo_id, keyword);
    const max = settings().maxPerDelivery;
    if (sharing.length < max) continue;
    console.log(`  "${keyword}" already has ${sharing.length} lessons, and only ${max} are sent per prompt. Always-on lessons go first, then longer keywords, then newer ones.`);
    console.log(`  These ${sharing.length + 1 - max} would be left out: ${sharing.slice(max - 1).map((x) => `"${x.text.slice(0, 50)}"`).join(", ")}`);
    if (!(await rl.question("  Use it anyway (y/n)? ")).trim().toLowerCase().startsWith("y")) return chooseRoute(db, rl, l, explained);
  }
  return { alwaysOn: false, triggers: keywords };
}

export async function review(db: Client, repo: string | null, lessons?: Lesson[]) {
  const all = lessons ?? (await listLessons(db, { repo, status: "proposed" }));
  const shown = pickToShow(all, settings().shownPerRun);
  if (!shown.length) { console.log("No lessons waiting for review."); return; }
  if (!process.stdin.isTTY) {
    console.log(`${all.length} lessons waiting. Not a terminal, so nothing changes. Top ${shown.length}:`);
    for (const l of shown) console.log(`- [${l.signal}] ${l.text}`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const explained = { done: false };
  let i = 0;
  for (const first of shown) {
    i++;
    const l = await getLesson(db, first.id);
    if (!l || l.status !== "proposed") continue;
    const ev = await db.execute({ sql: "SELECT tool,quote FROM evidence WHERE lesson_id=? LIMIT 3", args: [l.id] });
    console.log(`\n[${i}/${shown.length}] ${l.kind === "note" ? "NOTE: " : ""}${l.text}\n  ${l.signal === "explained" ? "you explained this" : l.signal}, ${l.sessions} session(s)`);
    if (l.why) console.log(`  Why: ${l.why}`);
    for (const e of ev.rows) console.log(`  ${e.tool}: ${e.quote}`);
    await markShown(db, l.id);
    const sim = await similar(db, l);
    if (sim) console.log(`  Similar to a ${sim.lesson.status} lesson (${sim.lesson.id.slice(0, 8)}):\n    "${sim.lesson.text}"`);
    if (sim) console.log(`  (a)dd to that lesson: it takes this one's point and keeps where it's told (${sim.lesson.scope === "global" ? "every repo" : "this repo"}).`);
    const a = (await rl.question(`  (k)eep, (e)dit, ${sim ? "(a)dd to that lesson, (c)ombine, " : ""}(r)eject, (l)ater? `)).trim().toLowerCase();
    if (a.startsWith("r")) { await decide(db, l.id, { status: "rejected" }); continue; }
    if (a.startsWith("a") && sim) {
      const t = (await rl.question("  That lesson's new wording (Enter keeps its words and just adds this one's quotes): ")).trim() || undefined;
      await addToOlder(db, l.id, sim.lesson.id, t);
      console.log("  Added. The older lesson is told as before, and this suggestion is gone from your list.");
      continue;
    }
    let text: string | undefined;
    if (a.startsWith("c") && sim) {
      text = (await rl.question("  Combined text (Enter keeps this lesson's text): ")).trim() || undefined;
      await combine(db, l.id, sim.lesson.id, text);
      console.log("  Combined. The other lesson is retired, and its evidence and keywords moved here.");
    } else if (a.startsWith("e")) {
      text = (await rl.question("  New text: ")).trim() || undefined;
    } else if (!a.startsWith("k")) continue;
    const news = (await rl.question("  Was this news to you (y/n)? ")).trim().toLowerCase().startsWith("y");
    let global: boolean | undefined;
    if (defaultRoute(l).global && l.scope !== "global") global = !(await rl.question("  This looks like it applies to any repo. Make it global (Y/n)? ")).trim().toLowerCase().startsWith("n");
    const route = await chooseRoute(db, rl, l, explained);
    await decide(db, l.id, { status: "live", ...(text ? { text } : {}), news, ...(global !== undefined ? { global } : {}), alwaysOn: route.alwaysOn, triggers: route.triggers });
  }
  rl.close();
}

/** Rough tokens in some text, about four characters each. */
const tokensOf = (t: string) => Math.max(1, Math.ceil(t.length / 4));
const fmt = (n: number) => n.toLocaleString("en-GB");
/**
 * What a lesson is worth, in a sentence: the output the problem wasted, against what telling agents costs.
 * Null when nothing was measured (lessons from what you said, rather than from failing commands).
 */
export function worthSentence(l: { text: string; wasted_tokens?: number | null }, route?: "always" | "keyword" | "none"): string | null {
  const w = Number(l.wasted_tokens ?? 0);
  if (w < 50) return null;
  const cost = tokensOf(l.text);
  const when = route === "always" ? "each session" : "each time it comes up";
  return `The problem wasted about ${fmt(w)} tokens. Telling agents costs about ${fmt(cost)} tokens ${when}.`;
}
