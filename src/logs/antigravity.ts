import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { notTyped, parseLines, readText, stripPrivate, type AgentMessage, type LogEvent, type Session } from "./types.js";

/**
 * Google Antigravity's plain-text transcripts: <app data>/brain/<conversation>/.system_generated/logs/transcript.jsonl,
 * one step per line: {step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type: USER_INPUT|PLANNER_RESPONSE|…, status,
 * content, tool_calls}. Documented at antigravity.google/docs/hooks; the per-line fields are known only from the
 * app's own prompt text, so anything unexpected is counted as unknown rather than guessed at.
 * Steps may carry created_at (else the file's time is used). There's no folder: it's the git repo the agent's paths fall in.
 */
const text = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map(text).join("\n") : c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "";
/** Antigravity writes each argument JSON-encoded a second time ("\"ls -la\""): unwrap those. */
const unquote = (v: unknown) => { if (typeof v === "string" && v.length > 1 && v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { /* keep as is */ } } return v; };
const argsOf = (t: any): Record<string, unknown> => {
  let a = t?.args ?? t?.arguments ?? t?.input ?? {};
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return {}; } }
  return Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, unquote(v)]));
};
/** What you typed, without the metadata Antigravity wraps it in (<USER_REQUEST>…</USER_REQUEST><ADDITIONAL_METADATA>…). */
const typedIn = (body: string) => body.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)?.[1] ?? body;
/** Absolute paths in a tool call's arguments: files viewed or edited, the folder a command ran in. */
const pathsIn = (a: Record<string, unknown>): string[] => Object.values(a).flatMap((v) => (typeof v === "string" ? [v.replace(/^file:\/\//, "")].filter((p) => p.startsWith("/")) : []));

const tops = new Map<string, string | null>();
function gitTop(path: string): string | null {
  let dir = path;
  while (dir !== "/" && !existsSync(dir)) dir = dirname(dir);
  if (dir === "/") return null;
  // git -C needs a folder: for a file the agent viewed or edited, ask about the folder it's in.
  try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
  if (tops.has(dir)) return tops.get(dir)!;
  let top: string | null = null;
  try { top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() || null; } catch { /* not in a repo */ }
  tops.set(dir, top);
  return top;
}

export function readAntigravity(file: string): Session {
  const events: LogEvent[] = [];
  let unknown = 0;
  let ts = ""; try { ts = statSync(file).mtime.toISOString(); } catch { /* keep empty */ }
  const paths: string[] = [];
  let pending: { cmd: string } | null = null;
  const usage = { input: 0, output: 0, cacheRead: 0 }; let model = "";
  const turns: { ts: string; input: number; output: number; cacheRead?: number }[] = [];
  const messages: AgentMessage[] = []; let task = "";
  for (const o of parseLines(file, readText)) {
    if (typeof o?.type !== "string") { unknown++; continue; }
    if (o.source === "MODEL" && typeof o.input_tokens === "number") { usage.input += o.input_tokens; usage.output += o.output_tokens ?? 0; usage.cacheRead += o.cache_read_tokens ?? 0; if (o.model) model = String(o.model); turns.push({ ts: typeof o.created_at === "string" ? o.created_at : ts, input: o.input_tokens, output: o.output_tokens ?? 0, cacheRead: o.cache_read_tokens ?? 0 }); }
    const body = text(o.content).trim();
    if (typeof o.created_at === "string") ts = o.created_at;
    // A message from another agent in a swarm: "[Message] timestamp=… sender=<conversation id> priority=… content=…".
    // "[swarm] new board message #n" only says the board changed; the first real one is the assignment that started this agent.
    if (o.type === "SYSTEM_MESSAGE") {
      const m = body.match(/sender=([0-9a-f-]{8,})\s+priority=\S+\s+content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/);
      if (m && !/^\[swarm\] new board message/.test(m[2]!.trim())) {
        const text = stripPrivate(m[2]!.trim());
        messages.push({ ts, dir: "in", from: m[1]!, to: [], text: text.slice(0, 2000) });
        if (!task) task = text.slice(0, 2000);
      }
      continue;
    }
    if (o.type === "USER_INPUT" || o.source === "USER_EXPLICIT") {
      const typed = typedIn(body).trim();
      if (typed && !notTyped(typed)) events.push({ k: "typed", text: stripPrivate(typed), ts });
      continue;
    }
    if (o.source === "MODEL" && body && o.type === "PLANNER_RESPONSE") events.push({ k: "agent", text: body, ts });
    for (const t of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      const name = String(t?.name ?? "");
      const a = argsOf(t);
      paths.push(...pathsIn(a));
      const cmd = a.CommandLine ?? a.command ?? a.Command;
      if (/^(post_message|send_message)$/.test(name) && typeof (a.text ?? a.message ?? a.content) === "string") {
        const text = stripPrivate(String(a.text ?? a.message ?? a.content));
        messages.push({ ts, dir: "out", from: null, to: [...new Set([...text.matchAll(/@([\w-]+)/g)].map((x) => x[1]!))], text: text.slice(0, 2000) });
        continue;
      }
      if (name === "run_command" && typeof cmd === "string") {
        if (pending) events.push({ k: "cmd", cmd: pending.cmd, failed: false, output: "", ts });
        pending = { cmd };
      } else if (/^(view_file|read_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|create_file)$/.test(name)) {
        const p = pathsIn(a)[0];
        if (p) events.push({ k: "file", tool: /^(view|read)/.test(name) ? "read" : "edit", path: p, failed: o.status === "ERROR", output: "", ts });
      }
    }
    // A command's result: the step after it, with its output and whether it errored.
    if (pending && /COMMAND/.test(o.type) && o.source !== "MODEL") {
      const failed = o.status === "ERROR" || /exit code[:\s]+[1-9]/i.test(body);
      events.push({ k: "cmd", cmd: pending.cmd, failed, output: body.slice(-2000), ts, size: body.length });
      pending = null;
    }
  }
  const last = pending as { cmd: string } | null;
  if (last) events.push({ k: "cmd", cmd: last.cmd, failed: false, output: "", ts });
  // The repo most of the agent's paths fall in.
  const count = new Map<string, number>();
  for (const p of paths) { const t = gitTop(p); if (t) count.set(t, (count.get(t) ?? 0) + 1); }
  const cwd = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  // brain/<conversation>/.system_generated/logs/transcript.jsonl
  const id = basename(dirname(dirname(dirname(file.replace(/\.gz$/, "")))));
  // An agent no one typed to, started by another conversation's message: that conversation is its parent.
  const typed = events.some((e) => e.k === "typed");
  const parent = !typed ? messages.find((x) => x.dir === "in")?.from ?? undefined : undefined;
  return { id, tool: "antigravity", cwd, clientVersion: "unknown", events, unknown, file, usage, turns, ...(model ? { model } : {}), ...(messages.length ? { messages } : {}), ...(parent ? { parent, task } : {}) };
}
