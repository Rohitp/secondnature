import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
export type LogEvent =
  | { k: "typed"; text: string; ts: string }
  | { k: "agent"; text: string; ts: string }
  /** `output` is cut short; `size` is how many characters the agent was really shown, when the log says. */
  | { k: "cmd"; cmd: string; failed: boolean; output: string; ts: string; stopped?: boolean; size?: number }
  /** A file read, edit or search through the agent's own tools rather than the shell. `path` is the file or folder it named. `part`: a read of only some lines, `range` which ones ("400-480") when the log says. */
  | { k: "file"; tool: string; path: string; pattern?: string; failed: boolean; output: string; ts: string; size?: number; part?: boolean; range?: string }
  /** The engineer stopped the agent while it was answering (not a single command: that's a stopped "cmd"). */
  | { k: "interrupt"; ts: string };
/** One event as a line of plain text, for summaries. */
export const eventLine = (e: LogEvent): string =>
  e.k === "typed" ? `ENGINEER: ${e.text.slice(0, 1500)}`
  : e.k === "agent" ? `AGENT: ${e.text.slice(0, 600)}`
  : e.k === "cmd" ? `COMMAND${e.failed ? " (failed)" : ""}: ${e.cmd.slice(0, 200)}`
  : e.k === "file" ? `${e.tool.toUpperCase()}${e.failed ? " (failed)" : ""}: ${e.path.slice(0, 200)}`
  : "ENGINEER stopped the answer";
export type Tool = "claude-code" | "codex" | "cursor" | "antigravity";
export type WorkflowRun = { id: string; name: string; status: string; started: string; durationMs: number; agents: number; tokens: number; phases: string[]; logs: string[] };
export type AgentMessage = { ts: string; dir: "in" | "out"; from: string | null; to: string[]; text: string };
export type Usage = { input: number; output: number; cacheRead: number };
export type Session = {
  id: string; tool: Tool; cwd: string; clientVersion: string; events: LogEvent[]; unknown: number; branch?: string; file?: string;
  /** Tokens the session's model read and wrote, when the log records them. */
  usage?: Usage; model?: string;
  /** Tokens per model reply, with its time, so a slice of a long session can be measured on its own. */
  turns?: { ts: string; input: number; output: number; cacheRead?: number }[];
  /** A subagent: the session that started it, its type ("Explore", "general-purpose", a custom agent), and the task it was handed. */
  parent?: string; agentType?: string; task?: string;
  /** In a team of agents: the subagent's type, the worktree's name, or "main". Set by scans. */
  role?: string;
  /** A Claude Code agent-team teammate's name ("researcher"), from muninn's team hooks. */
  teammate?: string;
  /** Messages between agents in a swarm: posted to the shared board ("out"), or sent to this agent ("in", with the sender's session id). */
  messages?: AgentMessage[];
  /** A Claude Code workflow agent: the workflow run, its phase ("Check") and its label ("review:step-4:r1"). */
  workflow?: { id: string; phase?: string; label?: string };
  /** Claude Code workflow runs this session started, from their summary files. */
  workflowRuns?: WorkflowRun[];
  /** Subagents this session started, read from their own logs. */
  subagents?: Session[];
  /** Separate sessions this one started in the Claude desktop app (its start_session tool): when, and the name and title it gave each. */
  launches?: { ts: string; name: string; title: string; localId?: string }[];
  /** For a session another one started that way: the name it was given ("m10-foundations") and the starting session's id. Set by runs. */
  launchedAs?: string; launchedBy?: string;
  /** Whether this session directed others over its whole life, so each slice of it gets the same role. Set by runs. */
  coordinator?: boolean;
};
/** First and last time a session did anything. */
export const spanOf = (s: Session): { start: string; end: string } => {
  const ts = s.events.map((e) => e.ts).filter(Boolean).sort();
  return { start: ts[0] ?? "", end: ts.at(-1) ?? "" };
};
/** First text of every LLM run muninn starts, so readers can skip those sessions. */
export const OWN_RUN_MARK = "[muninn-lesson-writer]";
/** Text the engineer wraps in <private>…</private> is never learned from, stored or summarised. An unclosed tag hides the rest. */
export const PRIVATE = /<private>[\s\S]*?(<\/private>|$)/gi;
export const stripPrivate = (t: string) => t.replace(PRIVATE, "[private]");
/** A log file's text, unpacking muninn's compressed copies (.gz) of logs the tool has since deleted. */
export const readText = (f: string): string => f.endsWith(".gz") ? gunzipSync(readFileSync(f)).toString("utf8") : readFileSync(f, "utf8");
/** A session's id from its log file name, with or without muninn's .gz. */
export const sessionIdOf = (f: string, ext = ".jsonl") => basename(f).replace(/\.gz$/, "").replace(new RegExp(`${ext.replace(".", "\\.")}$`), "");
export const parseLines = (f: string, read: (f: string) => string): any[] =>
  read(f).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
export const textOf = (c: unknown): string =>
  typeof c === "string" ? c
  : Array.isArray(c) ? c.map((x: any) => (["text", "input_text", "output_text"].includes(x?.type) ? x.text ?? "" : "")).join(" ")
  : "";
const NOT_TYPED = ["<", "Caveat:", "[Request interrupted", "This session is being continued", "Base directory for this skill", "## My request", "# Files pasted by the user", "Pasted text contains", "Briefly inform the user about the task result"];
export const notTyped = (t: string) => NOT_TYPED.some((s) => t.trimStart().startsWith(s));
export const isOwnRun = (s: Session) => s.events.some((e) => e.k === "typed" && e.text.includes(OWN_RUN_MARK));
/** A tool result showing the engineer stopped or rejected the call, rather than the command failing. */
export const STOPPED = /The user doesn't want to proceed with this tool use|\[Request interrupted by user for tool use\]|The user rejected this|was rejected by the user/;
