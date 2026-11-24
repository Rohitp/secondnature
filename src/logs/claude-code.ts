

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { notTyped, parseLines, readText, sessionIdOf, STOPPED, stripPrivate, textOf, type AgentMessage, type LogEvent, type Session } from "./types.js";

/** Claude Code's own tools that name a file or folder. */
const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Grep", "Glob", "Skill"]);
/** The engineer stopped the answer itself. "…for tool use" is a stopped command, which the command result shows. */
const INTERRUPTED = /^\s*\[Request interrupted by user\]/;

/** A subagent's log: <project>/<parent session>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json beside it. */
export const isSubagentLog = (file: string) => /[\\/]subagents[\\/]/.test(file);
/** The session folder a subagent log sits under: <project>/<session>/subagents/[workflows/<run>/]agent-x.jsonl. */
const sessionDirOf = (file: string) => { let d = dirname(file); while (basename(d) !== "subagents" && d !== dirname(d)) d = dirname(d); return dirname(d); };

export function readClaude(file: string): Session {
  const sub = isSubagentLog(file);
  const events: LogEvent[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 }; const counted = new Set<string>(); let model = "";
  const turns: { ts: string; input: number; output: number; cacheRead?: number }[] = [];
  let task = "";
  const messages: AgentMessage[] = [];
  // Sessions this one asked the desktop app to start, until the result says whether one started.
  const launchCalls = new Map<string, { ts: string; name: string; title: string }>();
  const launches: NonNullable<Session["launches"]> = [];
  // What each tool call asked for, until its result arrives: a shell command, or a file tool and the path it named.
  const pending = new Map<string, { cmd: string } | { tool: string; path: string; pattern?: string; part?: boolean; range?: string }>();
  let cwd = "", clientVersion = "unknown", unknown = 0, branch = "";
  for (const o of parseLines(file, readText)) {
    // New record types are normal. A message without the expected shape means the format changed.
    if (typeof o.type !== "string" || ((o.type === "user" || o.type === "assistant") && o.message?.content === undefined)) unknown++;
    if (o.cwd) cwd ||= o.cwd;
    if (o.version) clientVersion = o.version;
    if (o.gitBranch) branch = o.gitBranch;
    // A message's tokens, once per message (its blocks are logged as separate records with the same id).
    const u = o.type === "assistant" ? o.message?.usage : null;
    if (u && !counted.has(o.message.id ?? o.uuid)) {
      counted.add(o.message.id ?? o.uuid);
      usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); usage.output += u.output_tokens ?? 0; usage.cacheRead += u.cache_read_input_tokens ?? 0;
      turns.push({ ts: o.timestamp ?? "", input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 });
      if (o.message.model && o.message.model !== "<synthetic>") model = o.message.model;
    }
    // In a subagent's own log every record is a "sidechain". Its first message is the task its parent handed it, not you.
    if (o.isMeta || (o.isSidechain && !sub)) continue;
    if (sub && o.type === "user" && !task && typeof o.message?.content === "string") { task = o.message.content; continue; }
    if (sub && o.type === "user" && typeof o.message?.content === "string") continue;
    // A message sent while the agent was working is logged as a queued command, not a user message.
    if (o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string") {
      const t = o.attachment.prompt;
      if (!notTyped(t)) events.push({ k: "typed", text: stripPrivate(t), ts: o.timestamp ?? "" });
      continue;
    }
    const c = o.message?.content;
    const ts = o.timestamp ?? "";
    // A message from a teammate arrives as a user turn wrapped in a tag naming the sender (agent teams; not documented).
    const wrapped = o.type === "user" ? (typeof c === "string" ? c : textOf(c)).match(/^\s*<(teammate-message|agent-message|cross-session-message)\b([^>]*)>([\s\S]*?)<\/\1>/) : null;
    if (wrapped) {
      const from = wrapped[2]!.match(/\b(?:teammate_id|from|from-name|sender|name)="([^"]+)"/)?.[1] ?? null;
      messages.push({ ts, dir: "in", from, to: [], text: stripPrivate(wrapped[3]!.trim()).slice(0, 2000) });
      continue;
    }
    if (o.type === "user") {
      if (typeof c === "string") { if (INTERRUPTED.test(c)) events.push({ k: "interrupt", ts }); else if (!notTyped(c)) events.push({ k: "typed", text: stripPrivate(c), ts }); continue; }
      for (const x of Array.isArray(c) ? c : []) {
        if (x?.type === "text" && INTERRUPTED.test(x.text ?? "")) events.push({ k: "interrupt", ts });
        else if (x?.type === "text" && !notTyped(x.text ?? "")) events.push({ k: "typed", text: stripPrivate(x.text), ts });
        if (x?.type === "tool_result" && launchCalls.has(x.tool_use_id)) {
          // "Started session "Milestone 10" (session_id: local_…, name: m10-foundations)". A proposal that nobody started isn't a launch.
          const call = launchCalls.get(x.tool_use_id)!, said = textOf(x.content);
          const m = said.match(/^\s*Started session "([^"]*)" \(session_id: (local_[\w-]+)(?:, name: ([\w.-]+))?/);
          if (m) launches.push({ ts: call.ts || ts, name: m[3] ?? call.name, title: m[1] || call.title, localId: m[2] });
        }
        if (x?.type === "tool_result" && pending.has(x.tool_use_id)) {
          const r = o.toolUseResult ?? {};
          const call = pending.get(x.tool_use_id)!;
          pending.delete(x.tool_use_id);
          if (!("cmd" in call)) {
            // A file tool's result is the file itself: keep only enough to see why it failed.
            const whole = typeof r === "string" ? r : textOf(x.content);
            const output = whole.slice(0, 400);
            if (!STOPPED.test(output)) events.push({ k: "file", ...call, failed: x.is_error === true, output, ts, size: (textOf(x.content) || whole).length });
            continue;
          }
          const output = [r.stderr, r.stdout, typeof r === "string" ? r : "", textOf(x.content)].filter(Boolean).join("\n");
          const stopped = x.is_error === true && STOPPED.test(output);
          // What the agent was shown is the tool result itself; stdout and stderr repeat it.
          events.push({ k: "cmd", cmd: call.cmd, failed: x.is_error === true, output: output.slice(-2000), ts, size: (textOf(x.content) || output).length, ...(stopped ? { stopped } : {}) });
        }
      }
    }
    if (o.type === "assistant") for (const x of Array.isArray(c) ? c : []) {
      if (x?.type === "text") events.push({ k: "agent", text: x.text ?? "", ts });
      if (x?.type === "tool_use" && /(^|__)start_session$/.test(String(x.name)) && ts) launchCalls.set(x.id, { ts, name: String(x.input?.name ?? ""), title: String(x.input?.title ?? "") });
      if (x?.type === "tool_use" && x.name === "Bash") pending.set(x.id, { cmd: x.input?.command ?? "" });
      // A message to a teammate (agent teams). The field names aren't documented, so the likely ones are tried.
      if (x?.type === "tool_use" && x.name === "SendMessage") {
        const i = x.input ?? {};
        const to = [i.to, i.recipient, i.name, i.target, i.teammate].find((v) => typeof v === "string" && v) as string | undefined;
        const text = [i.message, i.content, i.text, i.body, i.summary].find((v) => typeof v === "string" && v) as string | undefined;
        if (text) messages.push({ ts, dir: "out", from: null, to: to ? [to] : [], text: stripPrivate(text).slice(0, 2000) });
      }
      const path = x?.type === "tool_use" && FILE_TOOLS.has(x.name) ? x.input?.file_path ?? x.input?.notebook_path ?? x.input?.path ?? x.input?.skill : undefined;
      if (typeof path === "string" && path) pending.set(x.id, { tool: String(x.name).toLowerCase(), path, ...(typeof x.input?.pattern === "string" ? { pattern: x.input.pattern } : {}), ...(x.input?.offset != null || x.input?.limit != null ? { part: true, range: `${x.input?.offset ?? 1}+${x.input?.limit ?? ""}` } : {}) });
    }
  }
  const base: Session = { id: sessionIdOf(file), tool: "claude-code", cwd, clientVersion, events, unknown, branch: branch || undefined, file, usage, turns, ...(model ? { model } : {}), ...(messages.length ? { messages } : {}), ...(launches.length ? { launches } : {}) };
  if (!sub) return base;
  let meta: { agentType?: string; description?: string; name?: string; workflowPhase?: string; inWorkflowRun?: boolean } = {};
  const metaFile = join(dirname(file), `${sessionIdOf(file)}.meta.json`);
  try { if (existsSync(metaFile)) meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch { /* no type then */ }
  // Text after the first item of a subagent's own user records is tool output, never you.
  return { ...base, events: events.filter((e) => e.k !== "typed"), parent: basename(sessionDirOf(file)), ...(meta.inWorkflowRun || basename(dirname(dirname(file))) === "workflows" ? { workflow: { id: basename(dirname(file)), phase: meta.workflowPhase, label: meta.description } } : {}), agentType: meta.name ?? meta.agentType ?? "subagent", task: (meta.description ? `${meta.description}: ` : "") + task.slice(0, 2000) };
}
