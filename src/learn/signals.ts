import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { redact } from "../privacy/redact.js";
import { cosine, type Embed } from "../embed/model.js";
import type { Session } from "../logs/types.js";

export type Signal = "repeat" | "correction" | "failure_then_fix" | "mistake_returned" | "explained" | "loop" | "refetch" | "stopped" | "confused" | "friction" | "wrong_path" | "big_file" | "big_output" | "reread" | "one_by_one" | "skimmed" | "stated" | "promised" | "sent_back" | "missed" | "unanswered";
export type Moment = {
  signal: Signal; text: string; quotes: { tool: string; session: string; ts: string; quote: string }[];
  sessions: number; days: number; wordings: number; tools: string[]; last: string; vector?: Float32Array;
  context?: string;
  /** In a team of agents, the role the lesson is for ("builder"); told only to that role. */
  role?: string;
  /** Tokens of output the problem wasted: failed repeats and re-reads, not the first try. */
  wasted?: number;
};
const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();
const NEG = /\b(not|never|don'?t|no|avoid|stop|cannot|won'?t|shouldn'?t|without)\b/i;
const STOP = new Set(["run the tests", "commit this", "continue", "go ahead", "looks good", "fix it", "push it"]);
const CHAT = /^(ok|okay|yes|yep|yeah|no|nope|thanks|thank you|sure|cool|great|nice|hmm|hi|hello|lets|let s|what|why|how|where|when|who|which|did|do you|is|are|can you|could you|does|got it|right|and|but|so|or|if|i see)\b/i;
const CORRECTION = /^(no\b|nope\b|don'?t\b|do not\b|wrong\b|not that\b|that'?s (wrong|not)\b|stop\b|actually\b)|\binstead\b/i;
const BENIGN = /^(grep|rg|diff|test|\[|which|pgrep|find|ls|cat|sed|head|tail|awk|command|type|echo|python3? -|git (diff|status|log|show|grep|rev-parse))\b/;
const seg = new Intl.Segmenter("en", { granularity: "sentence" });

export function sentences(text: string): string[] {
  if (text.length > 2000 || text.split("\n").length > 20) return [];
  return text.replace(/```[\s\S]*?```/g, " ").split("\n").filter((l) => !l.trim().startsWith(">"))
    .flatMap((l) => [...seg.segment(l)].map((x) => x.segment.trim().replace(/^[-*\s]+/, ""))).filter(Boolean);
}
export function normCommand(raw: string): string {
  let c = raw.replace(/^\/bin\/(ba|z)?sh\s+-l?c\s+/, "").replace(/^["']|["']$/g, "");
  const [first = "", ...rest] = c.split("\n");
  c = first.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "").replace(/^(\w+=\S+\s+)+/, "").trim();
  const key = c.replace(/\/[\w.@/-]+/g, "<path>").replace(/\b[0-9a-f]{7,}\b/g, "<id>").replace(/\b\d+\b/g, "<n>").slice(0, 90);
  // A heredoc's first line ("python3 - <<'EOF'") says nothing about the script: different scripts must not look alike.
  if (/<</.test(first) && rest.length) return `${key} #${createHash("sha1").update(rest.join("\n").replace(/\d+/g, "").replace(/\s+/g, " ")).digest("hex").slice(0, 6)}`;
  return key;
}
/** One run as evidence: the command on one line, and the first line it printed. */
export function shown(cmd: string, output: string): string {
  const c = cmd.replace(/\s+/g, " ").trim();
  const said = output.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no output)";
  return redact(`$ ${c.length > 150 ? c.slice(0, 149) + "…" : c}  →  ${said.slice(0, 80)}`);
}
/** Whether a later run's output repeats an earlier one's: most of the earlier lines show up again. */
export function repeats(earlier: string, later: string): boolean {
  const lines = [...new Set(earlier.split("\n").map((l) => l.trim()).filter((l) => l.length >= 6))];
  if (lines.length < 2) return false;
  return lines.filter((l) => later.includes(l)).length / lines.length >= 0.6;
}
export function errorLine(o: string): string {
  const ls = o.split("\n").map((l) => l.trim()).filter(Boolean);
  const e = [...ls].reverse().find((l) => /error|fail|exception|denied|not found|cannot|unable/i.test(l)) ?? ls.at(-1) ?? "";
  return e.replace(/\/[\w.@/-]+/g, "<path>").replace(/\b[0-9a-f]{7,}\b/g, "<id>").replace(/\d+/g, "<n>").slice(0, 120);
}

type Item = { text: string; session: string; tool: string; ts: string; before?: string };
type Cluster = { first: Float32Array; firstText: string; items: Item[] };

function cluster(items: Item[], vectors: Map<string, Float32Array>, cutoff: number): Cluster[] {
  const out: Cluster[] = [];
  for (const it of [...items].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const v = vectors.get(norm(it.text))!;
    const hit = out.find((c) => cosine(c.first, v) >= cutoff && NEG.test(c.firstText) === NEG.test(it.text));
    if (hit) hit.items.push(it); else out.push({ first: v, firstText: it.text, items: [it] });
  }
  return out;
}
/** Hours between the first and last time something was said: work in one long session can span days. */
const spanHours = (c: Cluster) => { const t = c.items.map((i) => Date.parse(i.ts)).filter((x) => !Number.isNaN(x)); return t.length ? (Math.max(...t) - Math.min(...t)) / 3_600_000 : 0; };
function toMoment(signal: Signal, c: Cluster): Moment {
  const seen = new Set<string>(); const quotes: Moment["quotes"] = [];
  for (const i of [...c.items].reverse()) {
    const quote = redact((i.before ? `after "${i.before}": ` : "") + i.text).slice(0, 240);
    if (seen.has(norm(i.text)) || quotes.length >= 3) continue;
    seen.add(norm(i.text)); quotes.push({ tool: i.tool, session: i.session, ts: i.ts, quote });
  }
  return {
    signal, text: redact(c.items.map((i) => i.text).reduce((a, b) => (b.length > a.length ? b : a))), quotes,
    sessions: new Set(c.items.map((i) => i.session)).size, days: new Set(c.items.map((i) => i.ts.slice(0, 10))).size,
    wordings: new Set(c.items.map((i) => norm(i.text))).size, tools: [...new Set(c.items.map((i) => i.tool))],
    last: c.items.at(-1)!.ts, vector: c.first,
  };
}

/** One group of similar things you typed, as detection saw it: for tuning the thresholds against real logs. */
export type Considered = { signal: "repeat" | "correction"; texts: string[]; times: number; sessions: number; wordings: number; days: number; hours: number; kept: boolean };
export async function findMoments(sessions: Session[], embed: Embed, opts: { cutoff: number; minSessions: number; trace?: (c: Considered) => void }): Promise<Moment[]> {
  const agent = new Set<string>();
  for (const s of sessions) for (const e of s.events) if (e.k === "agent") for (const x of sentences(e.text)) agent.add(norm(x));
  const repeats: Item[] = []; const corrections: Item[] = [];
  for (const s of sessions) {
    let prev = "";
    for (const e of s.events) {
      if (e.k === "agent") { prev = e.text.slice(0, 160); continue; }
      if (e.k === "cmd") { prev = `ran: ${e.cmd.slice(0, 140)}`; continue; }
      if (e.k === "file") { prev = `${e.tool}: ${e.path.slice(0, 140)}`; continue; }
      if (e.k !== "typed") continue;
      for (const x of sentences(e.text)) {
        const n = norm(x);
        if (n.split(" ").length < 2 || STOP.has(n) || agent.has(n) || x.length > 240) continue;
        if (prev && CORRECTION.test(x)) corrections.push({ text: x, session: s.id, tool: s.tool, ts: e.ts, before: prev });
        if (!x.endsWith("?") && !CHAT.test(x)) repeats.push({ text: x, session: s.id, tool: s.tool, ts: e.ts });
      }
      prev = "";
    }
  }
  const vectors = await embed([...repeats, ...corrections].map((i) => norm(i.text)));
  const moments: Moment[] = [];
  for (const c of cluster(repeats, vectors, opts.cutoff)) {
    const m = toMoment("repeat", c);
    // Across sessions, or within one long session: said 3 times, in more than one wording, hours apart.
    const inOneLong = c.items.length >= 3 && m.wordings >= 2 && spanHours(c) >= 2;
    const kept = m.days >= 3 || (m.sessions >= opts.minSessions && m.wordings >= 2) || inOneLong;
    if (kept) moments.push(m);
    if (c.items.length >= 2) opts.trace?.({ signal: "repeat", texts: c.items.map((i) => i.text), times: c.items.length, sessions: m.sessions, wordings: m.wordings, days: m.days, hours: spanHours(c), kept });
  }
  for (const c of cluster(corrections, vectors, opts.cutoff)) {
    const m = toMoment("correction", c);
    m.context = c.items.at(-1)?.before ? redact(c.items.at(-1)!.before!) : undefined;
    const kept = m.sessions >= 2 || (c.items.length >= 2 && spanHours(c) >= 1);
    if (kept) moments.push(m);
    opts.trace?.({ signal: "correction", texts: c.items.map((i) => `${i.text}   ⟵ after: ${i.before?.slice(0, 100) ?? ""}`), times: c.items.length, sessions: m.sessions, wordings: m.wordings, days: m.days, hours: spanHours(c), kept });
  }
  moments.push(...commandMoments(sessions), ...explainedMoments(sessions), ...intentMoments(sessions), ...pathMoments(sessions), ...wasteMoments(sessions), ...skimMoments(sessions), ...statedMoments(sessions), ...promisedMoments(sessions));
  return moments;
}

/** A long message where the engineer explained something. Said once, so no repeat signal sees it. The writer decides if it holds lasting knowledge. */
export function isExplanation(text: string): boolean {
  const t = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (t.length < 300 || text.length > 6000) return false;
  const parts = [...seg.segment(t)].map((x) => x.segment.trim()).filter((x) => x.split(/\s+/).length >= 4);
  if (parts.length < 3) return false;
  const questions = parts.filter((p) => p.endsWith("?")).length;
  return questions / parts.length < 0.5;
}
/**
 * Messages grouped by what they're doing rather than how they're worded. In a long session you mostly approve,
 * ask and report; the lessons are in the asking ("what is harder-data?", "I don't understand this") and the
 * friction ("why are we asking for simple API calls?", "stuck in loading"). Wording differs every time, so
 * similarity misses them; the pattern of the message doesn't. Each comes with what the agent said just before,
 * since that's usually what caused it.
 */
// "what" as people type it in a hurry: wht, wat, waht, whast.
const W = "(?:what|wht|wat|waht|whta|whast|whats|what's|wats)";
export const CONFUSED = new RegExp(`\\b(${W} (is|are|does|do|was|were) (a |an |the )?[\\w.-]*[-_][\\w.-]*|${W} (is |are )?(a|an|the|this|that|these) |${W} is |${W} does .{1,40} (do|mean)|${W} do (i|you) (need to|have to|mean)|${W} am i (testing|looking at|supposed to)|how do i |where do i |i (don'?t|dont|do not) (understand|get it|follow|know what)|n[oi]t sure what|(is|it'?s|its|this is) (unclear|confusing)|unclear|confus(ed|ing)|hard to (parse|follow|understand|read|explain)|makes? no sense|easier explanation|explain (this|that|it|again|more)|${W} do you mean)`, "i");
/** Asking for what's next, or what else, isn't confusion. */
const NOT_CONFUSED = /\bwhat'?s? (next|else|left)\b|\bwhats next\b|\bwhat else\b|\bwhat (should|shall|can) we (do|build) next\b/i;
export const FRICTION = /\b(why (are|is|did|does|do|was|were) (we|you|it|this|that|there)\b|(doesn'?t|does not|didn'?t|isn'?t|is not|won'?t|can'?t|couldn'?t|wasn'?t) (work|render|load|show|start|open|run|see|find|connect)\w*|not (working|loading|rendering|showing)|stuck|broken|still (not|doesn|isn|fail|see|show|load|ask)|i thought (i|we|you|it|this)|all over the place|lines .{0,20}all over|nothing happen|again\?|keeps? (asking|failing|happening|breaking))/i;
/** How many such messages, in this repo's sessions, before it's a pattern rather than a moment. */
export const INTENT_MIN = 3;

function intentMoments(sessions: Session[]): Moment[] {
  const groups: Record<"confused" | "friction", { text: string; before: string; session: string; tool: string; ts: string }[]> = { confused: [], friction: [] };
  for (const s of sessions) {
    let prev = "";
    for (const e of s.events) {
      if (e.k === "agent") { prev = e.text; continue; }
      if (e.k !== "typed") continue;
      const t = e.text.trim();
      if (t.length > 600 || t.length < 8) { prev = ""; continue; }
      const kind = CONFUSED.test(t) && !NOT_CONFUSED.test(t) ? "confused" : FRICTION.test(t) ? "friction" : null;
      if (kind) groups[kind].push({ text: t, before: prev.replace(/\s+/g, " ").trim(), session: s.id, tool: s.tool, ts: e.ts });
      prev = "";
    }
  }
  const out: Moment[] = [];
  for (const kind of ["confused", "friction"] as const) {
    const items = groups[kind];
    if (items.length < INTENT_MIN) continue;
    const last = items.at(-1)!;
    out.push({
      signal: kind,
      text: redact(kind === "confused"
        ? `The engineer asked what something meant, or said they didn't follow, ${items.length} times`
        : `The engineer reported something not working or not as expected, ${items.length} times`),
      // What the agent said before each: the writer looks for what they have in common.
      context: redact(items.slice(-8).map((i) => `Agent said: "${i.before.slice(0, 220)}" → engineer: "${i.text.slice(0, 200)}"`).join("\n")),
      quotes: items.slice(-3).map((i) => ({ tool: i.tool, session: i.session, ts: i.ts, quote: redact(i.text).slice(0, 240) })),
      sessions: new Set(items.map((i) => i.session)).size, days: new Set(items.map((i) => i.ts.slice(0, 10))).size,
      wordings: new Set(items.map((i) => norm(i.text))).size, tools: [...new Set(items.map((i) => i.tool))], last: last.ts,
    });
  }
  return out;
}

function explainedMoments(sessions: Session[]): Moment[] {
  const out: Moment[] = [];
  for (const s of sessions) for (const e of s.events) {
    if (e.k !== "typed" || !isExplanation(e.text)) continue;
    const text = redact(e.text).slice(0, 3000);
    out.push({ signal: "explained", text, quotes: [{ tool: s.tool, session: s.id, ts: e.ts, quote: text.slice(0, 240) }], sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: e.ts });
  }
  return out;
}

/** A limit or offset that pages through output: `| head -50`, `-n 20`, `--max-count=5`, `LIMIT 10`. */
/**
 * A cap on how much output a command shows, counted from the start (or end): `| head -50`, `| tail -n 20`,
 * `--max-count=5`, `LIMIT 10`. Raising one re-shows everything the smaller one showed. Windows into the middle
 * (offsets, `sed -n 80,160p`) aren't here: reading a file in separate slices reads each part once.
 */
export const PAGE = /\|\s*(?:head|tail)\s+(?:-n\s*)?-?\d+|--max-count[= ]\d+|--lines[= ]\d+|\blimit[= ]\d+|\bLIMIT\s+\d+/gi;
/** Rough tokens in some output, about four characters each: what a repeat cost. */
export const tokensIn = (o: string) => Math.ceil(o.length / 4);
/** How many times in a row the same command must fail the same way to count as a loop. */
export const LOOP_MIN = 3;

function commandMoments(sessions: Session[]): Moment[] {
  const out: Moment[] = [];
  const returned = new Map<string, { cmd: string; err: string; hits: { session: string; tool: string; ts: string }[]; tokens: number }>();
  const stopped = new Map<string, { session: string; tool: string; ts: string }[]>();
  for (const s of sessions) {
    const count = new Map<string, number>(); const lastErr = new Map<string, string>(); const between = new Map<string, string[]>();
    const failTokens = new Map<string, number>();
    // Loops: the same command failing the same way in a row. Kept if the session moved on without fixing it.
    const run = new Map<string, { err: string; n: number; tokens: number; ts: string }>();
    const loops = new Map<string, { err: string; n: number; tokens: number; ts: string }>();
    // Re-fetches: one command re-run with different limits, each time re-reading output the last run cut off.
    // Keyed on the whole command with its caps taken out: only the very same command, re-run with a bigger cap, counts.
    const pages = new Map<string, { key: string; raws: Set<string>; runs: { cmd: string; output: string }[]; ts: string }>();
    // The runs behind each loop and each failure, kept as evidence.
    const tries = new Map<string, { cmd: string; output: string }[]>();
    for (const e of s.events) {
      if (e.k !== "cmd") continue;
      if (e.stopped) {
        const key = normCommand(e.cmd);
        if (key) stopped.set(key, [...(stopped.get(key) ?? []), { session: s.id, tool: s.tool, ts: e.ts }]);
        continue;
      }
      if (!e.failed && new RegExp(PAGE.source, "i").test(e.cmd)) {
        const whole = e.cmd.replace(PAGE, "").replace(/\s+/g, " ").trim();
        const p = pages.get(whole) ?? { key: normCommand(e.cmd.replace(PAGE, "")), raws: new Set<string>(), runs: [], ts: e.ts };
        if (!p.raws.has(e.cmd.trim())) { p.raws.add(e.cmd.trim()); p.runs.push({ cmd: e.cmd, output: e.output }); }
        p.ts = e.ts; pages.set(whole, p);
      }
      const key = normCommand(e.cmd);
      if (!key || BENIGN.test(key)) continue;
      if (e.failed) {
        tries.set(key, [...(tries.get(key) ?? []), { cmd: e.cmd, output: e.output }].slice(-6));
        const err = errorLine(e.output);
        const r = run.get(key);
        const next = r && r.err === err ? { err, n: r.n + 1, tokens: r.tokens + tokensIn(e.output), ts: e.ts } : { err, n: 1, tokens: 0, ts: e.ts };
        run.set(key, next);
        if (next.n >= LOOP_MIN && next.n > (loops.get(key)?.n ?? 0)) loops.set(key, next);
      } else { run.delete(key); loops.delete(key); }
      for (const [k, list] of between) if (k !== key && list.length < 5) list.push(key);
      if (e.failed) {
        const err = errorLine(e.output);
        const k = `${key} :: ${err}`;
        const r = returned.get(k) ?? { cmd: key, err, hits: [], tokens: 0 };
        if (r.hits.length) r.tokens += tokensIn(e.output);
        r.hits.push({ session: s.id, tool: s.tool, ts: e.ts }); returned.set(k, r);
        if (count.get(key)) failTokens.set(key, (failTokens.get(key) ?? 0) + tokensIn(e.output));
        count.set(key, (count.get(key) ?? 0) + 1); lastErr.set(key, err);
        if (!between.has(key)) between.set(key, []);
      } else if ((count.get(key) ?? 0) >= 2) {
        const steps = between.get(key) ?? [];
        out.push({
          signal: "failure_then_fix", text: redact(`\`${key}\` failed with "${lastErr.get(key)}"`),
          context: redact(`Commands run between the failures and the success: ${steps.join("; ") || "none"}`),
          quotes: [...(tries.get(key) ?? []).slice(-2), { cmd: e.cmd, output: e.output }].map((t) => ({ tool: s.tool, session: s.id, ts: e.ts, quote: shown(t.cmd, t.output) })),
          sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: e.ts, wasted: failTokens.get(key) ?? 0,
        });
        count.delete(key); between.delete(key); failTokens.delete(key); tries.delete(key);
      }
    }
    for (const [key, l] of loops) out.push({
      signal: "loop", text: redact(`\`${key}\` failed ${l.n} times in a row with "${l.err}", and the session moved on without fixing it`),
      context: `The repeats cost about ${l.tokens} tokens of output.`,
      quotes: (tries.get(key) ?? []).slice(-3).map((t) => ({ tool: s.tool, session: s.id, ts: l.ts, quote: shown(t.cmd, t.output) })),
      sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: l.ts, wasted: l.tokens,
    });
    for (const p of pages.values()) {
      const key = p.key;
      if (p.raws.size < LOOP_MIN) continue;
      // Checked against what was printed, not guessed from the commands: a run counts as re-read only if a later run showed it again.
      const reread = p.runs.filter((r, i) => p.runs.slice(i + 1).some((later) => repeats(r.output, later.output)));
      if (reread.length < LOOP_MIN - 1) continue;
      out.push({
        signal: "refetch", text: redact(`\`${key}\` was run ${p.raws.size} times with different limits, and ${reread.length} of the runs printed output a later run printed again`),
        context: `About ${reread.reduce((a, r) => a + tokensIn(r.output), 0)} tokens of output were read twice.`,
        quotes: p.runs.slice(-3).map((r) => ({ tool: s.tool, session: s.id, ts: p.ts, quote: shown(r.cmd, r.output) })),
        sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: p.ts, wasted: reread.reduce((a, r) => a + tokensIn(r.output), 0),
      });
    }
  }
  // Commands the engineer stopped more than once: a sign the agent keeps reaching for something they don't want.
  for (const [key, hits] of stopped) {
    if (hits.length < 2) continue;
    const last = hits.at(-1)!;
    out.push({
      signal: "stopped", text: redact(`The engineer stopped \`${key}\` ${hits.length} times before it ran`),
      quotes: hits.slice(-3).map((h) => ({ ...h, quote: redact(`stopped: ${key}`).slice(0, 240) })),
      sessions: new Set(hits.map((h) => h.session)).size, days: new Set(hits.map((h) => h.ts.slice(0, 10))).size, wordings: 1, tools: [...new Set(hits.map((h) => h.tool))], last: last.ts,
    });
  }
  for (const r of returned.values()) {
    const ss = new Set(r.hits.map((h) => h.session));
    if (ss.size < 3) continue;
    const last = r.hits.at(-1)!;
    out.push({
      signal: "mistake_returned", text: redact(`\`${r.cmd}\` keeps failing with "${r.err}"`),
      quotes: [{ tool: last.tool, session: last.session, ts: last.ts, quote: redact(`${r.cmd}: ${r.err}`).slice(0, 240) }],
      sessions: ss.size, days: new Set(r.hits.map((h) => h.ts.slice(0, 10))).size, wordings: 1, tools: [...new Set(r.hits.map((h) => h.tool))], last: last.ts, wasted: r.tokens,
    });
  }
  return out;
}

/** A tool or shell saying a file or folder isn't there. */
const MISSING = /does not exist|no such file or directory|ENOENT|cannot find (the )?(file|path)|path not found/i;
/** Claude Code's Read refusing a file too big to read in one go. */
const TOO_BIG = /exceeds maximum allowed (tokens|size)|file (content )?is too large|too large to read/i;
/** The path in one line of a shell's "No such file or directory": `cat: a/b.ts: No such…`, `ls: cannot access 'x': No such…`. */
const SHELL_MISSING = /^[\w.-]+: (?:cannot (?:access|open|stat) )?['"\u2018]?([^'"\u2019:\s][^'"\u2019:]*?)['"\u2019]?(?:: open)?: No such file or directory/;
/** Words in a command that look like paths: with a slash, or a name with an extension. */
const PATHISH = /(?:^|[\s'"=(])((?:~|\.{1,2})?[\w.@-]*\/[\w.@/-]+|[\w@-][\w.@-]*\.[A-Za-z]\w{0,5})(?=$|[\s'":)|;,])/g;
/** How many events later a found path still counts as the fix for a missing one. */
const PATH_WINDOW = 12;

/** The folder a shell command ran in: the session's, or the one it `cd`s into first. */
const cmdBase = (cwd: string, cmd: string) => { const m = cmd.match(/^\s*cd\s+(['"]?)([^'"&;]+)\1\s*(&&|;)/); return m ? resolve(cwd, m[2]!.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~")) : cwd; };
const abs = (base: string, p: string) => resolve(base, p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
/** A path as the repo knows it: relative to the session's folder when inside it. */
const shortPath = (cwd: string, p: string) => { const r = relative(cwd, p); return r && !r.startsWith("..") && !isAbsolute(r) ? r : p; };
const stem = (p: string) => basename(p, extname(p));
/** Whether a found path is plausibly the one that was missing: the same file name, or the same name with another extension. */
const sameFile = (missing: string, found: string) => missing !== found && (basename(missing) === basename(found) || (stem(missing).length >= 4 && stem(missing) === stem(found) && !!extname(found)));

/**
 * Wrong paths the agent keeps guessing, matched to where the file really was: a read, edit, search or shell
 * command that found nothing, then, a few steps later, a success on the same file name somewhere else.
 * One wrong guess is ordinary; the same wrong guess in another session is what a lesson saves.
 * Also files too big to read in one go, hit in more than one session.
 */
function pathMoments(sessions: Session[]): Moment[] {
  type Hit = { session: string; tool: string; ts: string; from: string; to: string; err: string };
  const groups = new Map<string, Hit[]>();
  const big = new Map<string, { session: string; tool: string; ts: string; err: string }[]>();
  for (const s of sessions) {
    const cwd = s.cwd || "/";
    // Missing paths still waiting for a match, with how many events ago they failed.
    let open: { path: string; at: number; err: string; pattern?: string; tool?: string }[] = [];
    s.events.forEach((e, i) => {
      if (e.k !== "file" && e.k !== "cmd") return;
      open = open.filter((o) => i - o.at <= PATH_WINDOW);
      if (e.k === "file" && e.failed && TOO_BIG.test(e.output)) {
        const key = shortPath(cwd, abs(cwd, e.path));
        big.set(key, [...(big.get(key) ?? []), { session: s.id, tool: s.tool, ts: e.ts, err: e.output.split("\n")[0]!.slice(0, 120) }]);
        return;
      }
      if (e.failed) {
        if (e.k === "file" && MISSING.test(e.output)) open.push({ path: abs(cwd, e.path), at: i, err: e.output.split("\n")[0]!.slice(0, 120), pattern: e.pattern, tool: e.tool });
        if (e.k === "cmd" && !e.stopped) {
          const base = cmdBase(cwd, e.cmd);
          for (const line of e.output.split("\n")) {
            const m = line.trim().match(SHELL_MISSING);
            if (m && !m[1]!.startsWith("(")) open.push({ path: abs(base, m[1]!), at: i, err: line.trim().slice(0, 120) });
          }
        }
        return;
      }
      if (!open.length) return;
      const found = e.k === "file" ? [abs(cwd, e.path)] : [...e.cmd.matchAll(PATHISH)].map((m) => abs(cmdBase(cwd, e.cmd), m[1]!));
      for (const f of found) {
        // A search that failed on a folder counts as found when the same search worked in another folder.
        const o = open.find((x) => sameFile(x.path, f) || (e.k === "file" && x.pattern !== undefined && x.pattern === e.pattern && x.tool === e.tool && x.path !== f));
        if (!o) continue;
        open = open.filter((x) => x !== o);
        const from = shortPath(cwd, o.path), to = shortPath(cwd, f);
        // Grouped by folder when the folders differ ("things in a/ are really in b/"), else by the file itself.
        const key = dirname(from) !== dirname(to) && basename(from) === basename(to) ? `${dirname(from)}/ -> ${dirname(to)}/` : `${from} -> ${to}`;
        groups.set(key, [...(groups.get(key) ?? []), { session: s.id, tool: s.tool, ts: e.ts, from, to, err: o.err }]);
      }
    });
  }
  const out: Moment[] = [];
  for (const [key, hits] of groups) {
    const sessionsHit = new Set(hits.map((h) => h.session)).size;
    if (sessionsHit < 2 && hits.length < 3) continue;
    const pairs = [...new Map(hits.map((h) => [`${h.from} -> ${h.to}`, h])).values()];
    const byFolder = key.endsWith("/");
    out.push({
      signal: "wrong_path",
      text: redact(byFolder
        ? `Agents looked in \`${key.split(" -> ")[0]}\` for files that are in \`${key.split(" -> ")[1]}\`, ${hits.length} times (for example \`${pairs[0]!.from}\` is at \`${pairs[0]!.to}\`)`
        : `Agents looked for \`${pairs[0]!.from}\`, which doesn't exist; it is at \`${pairs[0]!.to}\`. This happened ${hits.length} times`),
      context: redact(`Seen in ${sessionsHit} session(s). Pairs: ${pairs.slice(0, 5).map((p) => `${p.from} → ${p.to}`).join("; ")}`),
      quotes: hits.slice(-3).map((h) => ({ tool: h.tool, session: h.session, ts: h.ts, quote: redact(`missing: ${h.from} (${h.err})  →  found: ${h.to}`).slice(0, 240) })),
      sessions: sessionsHit, days: new Set(hits.map((h) => h.ts.slice(0, 10))).size, wordings: pairs.length, tools: [...new Set(hits.map((h) => h.tool))], last: hits.at(-1)!.ts,
    });
  }
  for (const [path, hits] of big) {
    const sessionsHit = new Set(hits.map((h) => h.session)).size;
    if (sessionsHit < 2) continue;
    out.push({
      signal: "big_file", text: redact(`\`${path}\` was too big to read in one go, in ${sessionsHit} sessions`),
      quotes: hits.slice(-3).map((h) => ({ tool: h.tool, session: h.session, ts: h.ts, quote: redact(`read ${path}  →  ${h.err}`).slice(0, 240) })),
      sessions: sessionsHit, days: new Set(hits.map((h) => h.ts.slice(0, 10))).size, wordings: 1, tools: [...new Set(hits.map((h) => h.tool))], last: hits.at(-1)!.ts,
    });
  }
  return out;
}

/** Reading speed for technical prose, in words a minute: turns an answer's length into how long it takes to read. */
export const READ_WPM = 250;
/** A reply in less than this share of the reading time means the answer wasn't read through. */
export const SKIP_SHARE = 0.5;
/** Answers shorter than this have nothing to skip. */
export const LONG_ANSWER = 150;
/** How many long answers before the pattern means anything, and what share must be skipped or stopped. */
export const SKIM_MIN = { answers: 8, share: 0.3 };

/**
 * People rarely say "shorter, please"; they show it. They reply to a long answer sooner than they could have
 * read it, or stop it while it's being written. Counted across a repo's sessions, that says answers there run
 * longer than the engineer reads. The writer turns it into a lesson about shape (what to put first), never
 * into "explain less": an engineer who asks for plain explanations may still skim the rest.
 */
function skimMoments(sessions: Session[]): Moment[] {
  type Skip = { session: string; tool: string; ts: string; words: number; secs: number | null; opening: string; next: string };
  const skips: Skip[] = [];
  let long = 0, stoppedCount = 0;
  const words = (t: string) => t.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
  for (const s of sessions) {
    let last: { text: string; ts: string } | null = null;
    for (const e of s.events) {
      if (e.k === "agent") { if (e.text.trim()) last = { text: e.text, ts: e.ts }; continue; }
      if (e.k === "cmd" || e.k === "file") { last = null; continue; }
      if (!last) continue;
      const n = words(last.text);
      const opening = last.text.replace(/\s+/g, " ").trim().slice(0, 160);
      if (e.k === "interrupt") {
        if (n >= 40) { stoppedCount++; long++; skips.push({ session: s.id, tool: s.tool, ts: e.ts, words: n, secs: null, opening, next: "(stopped the answer)" }); }
      } else if (n >= LONG_ANSWER) {
        long++;
        const secs = (Date.parse(e.ts) - Date.parse(last.ts)) / 1000;
        const readSecs = (n / READ_WPM) * 60;
        if (Number.isFinite(secs) && secs >= 0 && secs < readSecs * SKIP_SHARE) skips.push({ session: s.id, tool: s.tool, ts: e.ts, words: n, secs: Math.round(secs), opening, next: e.text.replace(/\s+/g, " ").trim().slice(0, 120) });
      }
      last = null;
    }
  }
  if (long < SKIM_MIN.answers || skips.length < INTENT_MIN || skips.length / long < SKIM_MIN.share) return [];
  const fast = skips.length - stoppedCount;
  const median = [...skips].map((k) => k.words).sort((a, b) => a - b)[Math.floor(skips.length / 2)]!;
  return [{
    signal: "skimmed",
    text: `Of ${long} long answers, the engineer replied to ${fast} faster than they could have read them and stopped ${stoppedCount} while they were being written (typical length of those: ${median} words)`,
    context: redact(skips.slice(-8).map((k) => `${k.words} words, ${k.secs === null ? "stopped" : `replied after ${k.secs}s`}. Answer began: "${k.opening}" → engineer: "${k.next}"`).join("\n")),
    quotes: skips.slice(-3).map((k) => ({ tool: k.tool, session: k.session, ts: k.ts, quote: redact(`${k.words}-word answer, ${k.secs === null ? "stopped while being written" : `replied after ${k.secs}s`}: "${k.opening.slice(0, 120)}"`).slice(0, 240) })),
    sessions: new Set(skips.map((k) => k.session)).size, days: new Set(skips.map((k) => k.ts.slice(0, 10))).size, wordings: 1,
    tools: [...new Set(skips.map((k) => k.tool))], last: skips.at(-1)!.ts,
  }];
}

/** A command's output above this many characters (about 10,000 tokens) is more than an agent needs to read. */
export const BIG_OUTPUT = 40_000;
/** What a narrowed command would still show (about 2,000 tokens); only output above it counts as wasted. */
export const ENOUGH_OUTPUT = 8_000;
/** Reads of one unchanged file in a session before it counts as re-reading. */
export const REREAD_MIN = 3;
/** The same kind of command run on one thing after another, in a row, before a script would have done it at once. */
export const STEP_MIN = 6;
/** File tools that change a file, so a later read of it is a fresh read. */
const WRITES = /^(edit|multiedit|write|notebookedit|str_replace|create)/;

/**
 * Token waste that SoL-Pi and Anthropic's code-execution work point at, read from muninn's own session logs:
 * commands that print far more than anyone reads (narrow them, or keep the tail), files read again and again
 * without changing (remember them, or search them), and the same step done on one thing after another
 * (a short script does them all in one turn, and each turn re-reads the whole conversation).
 */
function wasteMoments(sessions: Session[]): Moment[] {
  const out: Moment[] = [];
  type Hit = { session: string; tool: string; ts: string; quote: string; tokens: number };
  const groups = { big_output: new Map<string, Hit[]>(), reread: new Map<string, Hit[]>(), one_by_one: new Map<string, Hit[]>() };
  const add = (m: Map<string, Hit[]>, k: string, h: Hit) => m.set(k, [...(m.get(k) ?? []), h]);
  for (const s of sessions) {
    const cwd = s.cwd || "/";
    const reads = new Map<string, number>();
    let run: { key: string; cmds: string[]; ts: string } | null = null;
    const endRun = () => {
      if (run && new Set(run.cmds).size >= STEP_MIN) add(groups.one_by_one, run.key, { session: s.id, tool: s.tool, ts: run.ts, quote: redact(`${run.cmds.length} runs in a row, e.g. $ ${run.cmds[0]!.replace(/\s+/g, " ").slice(0, 120)}  then  $ ${run.cmds.at(-1)!.replace(/\s+/g, " ").slice(0, 120)}`).slice(0, 300), tokens: 0 });
      run = null;
    };
    for (const e of s.events) {
      if (e.k === "typed" || e.k === "interrupt") { endRun(); continue; }
      if (e.k === "agent") continue;
      if (e.k === "file") {
        endRun();
        const path = shortPath(cwd, abs(cwd, e.path));
        if (WRITES.test(e.tool)) { for (const k of [...reads.keys()]) if (k === path || k.startsWith(`${path}:`)) reads.delete(k); continue; }
        // A part of a file counts as read again only when the same lines are read again.
        if (e.tool !== "read" || e.failed || (e.part && !e.range)) continue;
        const rkey = e.part ? `${path}:${e.range}` : path;
        const n = (reads.get(rkey) ?? 0) + 1; reads.set(rkey, n);
        // The first read is needed; every later one of an unchanged file is the waste.
        if (n >= 2) add(groups.reread, path, { session: s.id, tool: s.tool, ts: e.ts, quote: redact(`read ${path} for the ${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"} time, unchanged`), tokens: Math.ceil((e.size ?? e.output.length) / 4) });
        if (e.size && e.size > BIG_OUTPUT) add(groups.big_output, `read ${path}`, { session: s.id, tool: s.tool, ts: e.ts, quote: redact(`read ${path}  →  ${Math.round(e.size / 4000)}k tokens`), tokens: Math.ceil((e.size - ENOUGH_OUTPUT) / 4) });
        continue;
      }
      if (e.stopped) { endRun(); continue; }
      // A shell command that names a file may change it: the next read of that file is fresh.
      for (const p of [...reads.keys()]) if (e.cmd.includes(basename(p.replace(/:[^/:]*$/, "")))) reads.delete(p);
      const key = normCommand(e.cmd);
      if (e.size && e.size > BIG_OUTPUT && key) add(groups.big_output, key, { session: s.id, tool: s.tool, ts: e.ts, quote: shown(e.cmd, e.output).slice(0, 200) + `  (${Math.round(e.size / 4000)}k tokens)`, tokens: Math.ceil((e.size - ENOUGH_OUTPUT) / 4) });
      if (!key || e.failed || BENIGN.test(key)) { endRun(); continue; }
      if (run && run.key === key) { run.cmds.push(e.cmd); run.ts = e.ts; }
      else { endRun(); run = { key, cmds: [e.cmd], ts: e.ts }; }
    }
    endRun();
  }
  const base = (hits: Hit[]) => ({
    quotes: hits.slice(-3).map(({ tokens: _, ...h }) => h), sessions: new Set(hits.map((h) => h.session)).size,
    days: new Set(hits.map((h) => h.ts.slice(0, 10))).size, wordings: 1, tools: [...new Set(hits.map((h) => h.tool))], last: hits.at(-1)!.ts,
    wasted: hits.reduce((a, h) => a + h.tokens, 0),
  });
  for (const [key, hits] of groups.big_output) {
    if (hits.length < 2) continue;
    const m = base(hits);
    out.push({ signal: "big_output", text: redact(`\`${key}\` showed the agent more than ${Math.round(BIG_OUTPUT / 4000)}k tokens of output ${hits.length} times, in ${m.sessions} session(s)`),
      context: `About ${m.wasted} tokens above what a narrowed command would show.`, ...m });
  }
  for (const [path, hits] of groups.reread) {
    // Re-reading once can be ordinary (after a long detour); twice in one session, or again in another session, is a habit.
    const perSession = new Map<string, number>(); for (const h of hits) perSession.set(h.session, (perSession.get(h.session) ?? 0) + 1);
    if (![...perSession.values()].some((n) => n >= REREAD_MIN - 1) && perSession.size < 2) continue;
    const m = base(hits);
    out.push({ signal: "reread", text: redact(`\`${path}\` was read again without changing, ${hits.length} times in ${m.sessions} session(s)`),
      context: `About ${m.wasted} tokens of the same file read again.`, ...m });
  }
  for (const [key, hits] of groups.one_by_one) {
    const m = base(hits);
    out.push({ signal: "one_by_one", text: redact(`\`${key}\` was run on one thing after another, ${STEP_MIN} or more times in a row, in ${m.sessions} session(s); a script or loop would do them in one step`), ...m, wasted: undefined });
  }
  return out;
}

/** Wasted effort without the embedding model: failing, looping and re-run commands, stops, wrong paths, oversized output, re-reads and step-by-step runs. For insights. */
export function effortMoments(sessions: Session[]): Moment[] { return [...commandMoments(sessions), ...pathMoments(sessions), ...wasteMoments(sessions)]; }

/**
 * A standing instruction said outright: "from now on…", "let's branch and merge for features with PRs",
 * "always run the tests first". Said once is enough: you were telling the agent a rule, not repeating yourself.
 * Wording about the future or about a kind of work marks it; a one-off request ("merge it") doesn't match.
 */
const FUTURE = /\b(from now on|going forward|moving forward|from here on|in (the )?future|by default|as a rule|every time|each time|whenever|always|never|for (all |every |each |any |new |future )?(features?|changes?|prs?|pull requests?|commits?|branches|repos?|projects?|tasks?|releases?|work)\b)/i;
const DIRECTIVE = /\b(let'?s|lets|we (want|need|should|'ll|will|must)|i (want|need|prefer|'d like|would like)|please|make sure|you should|you must|don'?t|do not|stop|use|keep|start)\b/i;
/** Phrases that make a rule by themselves; weaker ones ("always", "for features") also need an instruction word. */
const RULE = /\b(from now on|going forward|moving forward|from here on( out)?|by default|as a rule)\b/i;
/** "From now on I delete…" is about the speaker, not a rule for the agent: often the engineer quoting the agent back. */
const ABOUT_ME = /\b(from now on|going forward|moving forward|from here on( out)?),? i (?!(want|need|prefer|'d like|would like|expect)\b)/i;
export function isStanding(sentence: string): boolean {
  const t = sentence.trim();
  return t.length >= 15 && t.length <= 300 && !t.endsWith("?") && !ABOUT_ME.test(t) && (RULE.test(t) || (FUTURE.test(t) && DIRECTIVE.test(t)));
}
/** The standing instructions in something typed, as sentences. */
export const standingIn = (text: string) => sentences(text).flatMap((x) => x.split(/(?<=[A-Za-z0-9)][.!])\s+(?=[a-z])/)).filter(isStanding);

function statedMoments(sessions: Session[]): Moment[] {
  const out: Moment[] = [];
  for (const s of sessions) for (const e of s.events) {
    if (e.k !== "typed") continue;
    for (const x of standingIn(e.text)) {
      const quote = redact(x).slice(0, 240);
      out.push({ signal: "stated", text: redact(x), quotes: [{ tool: s.tool, session: s.id, ts: e.ts, quote }], sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: e.ts });
    }
  }
  return out;
}

/**
 * The agent's own side of the conversation: a promise about how it will work from now on ("From now on I delete a
 * branch only after checking the merge happened"), or a mistake it owned up to ("my mistake", "I should have…").
 * A promise in chat is forgotten next session, so it's only kept if it becomes a lesson. The agent's whole message
 * goes with it, since that usually says what went wrong: the why.
 */
export const PROMISE = /\b((from now on|going forward|from here on|next time|in future|in the future),? (i|i'll|i will|i'd|we'll)\b|i('ll| will) (always|never|make sure|remember|check first|only)\b|my (mistake|error|fault|bad)\b|that was (my|a) (mistake|error)|i should(n'?t| not)? have\b|i (wrongly|mistakenly)\b)|^lesson( learned| for me)?:/i;
/** Sentences in an agent message, without the size limit `sentences` has for what the engineer types. */
const agentSentences = (text: string) => text.replace(/```[\s\S]*?```/g, " ").split("\n").filter((l) => !l.trim().startsWith(">"))
  .flatMap((l) => [...seg.segment(l)].map((x) => x.segment.trim().replace(/^[-*\s]+/, "").replace(/\*\*/g, ""))).filter(Boolean);
export function promisesIn(text: string): string[] {
  return agentSentences(text).filter((x) => x.length >= 15 && x.length <= 400 && !x.endsWith("?") && PROMISE.test(x));
}
function promisedMoments(sessions: Session[]): Moment[] {
  const out: Moment[] = [];
  for (const s of sessions) {
    let asked = "";
    const seen = new Set<string>();
    for (const e of s.events) {
      if (e.k === "typed") { asked = e.text; continue; }
      if (e.k !== "agent") continue;
      for (const x of promisesIn(e.text)) {
        const key = norm(x); if (seen.has(key)) continue; seen.add(key);
        const quote = redact(x).slice(0, 240);
        // What the engineer last asked, and the agent's whole message around the promise: what happened, and why.
        // The text around the promise, mostly before it: what went wrong is usually said just ahead of the promise.
        const at = Math.max(0, e.text.indexOf(x.slice(0, 30)));
        const near = e.text.slice(Math.max(0, at - 1500), at + x.length + 300);
        const context = redact(`ENGINEER ASKED: ${asked.slice(0, 400)}\nAGENT SAID: ${at > 1500 ? "…" : ""}${near}`);
        out.push({ signal: "promised", text: redact(x), quotes: [{ tool: s.tool, session: s.id, ts: e.ts, quote }], sessions: 1, days: 1, wordings: 1, tools: [s.tool], last: e.ts, context });
      }
    }
  }
  return out;
}
