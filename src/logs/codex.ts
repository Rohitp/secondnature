

import { notTyped, parseLines, readText, sessionIdOf, stripPrivate, textOf, type LogEvent, type Session } from "./types.js";

export function readCodex(file: string): Session {
  const items: LogEvent[] = [];
  const fallback: LogEvent[] = [];
  let cwd = "", clientVersion = "unknown", unknown = 0, branch = "";
  for (const o of parseLines(file, readText)) {
    if (typeof o.type !== "string" || ((o.type === "response_item" || o.type === "event_msg") && typeof o.payload?.type !== "string")) unknown++;
    const p = o.payload ?? {};
    const ts = o.timestamp ?? "";
    if (o.type === "session_meta") { cwd = p.cwd ?? ""; clientVersion = p.cli_version ?? clientVersion; branch = p.git?.branch ?? branch; }
    if (o.type === "response_item" && p.type === "message") {
      const t = textOf(p.content);
      if (p.role === "user" && !notTyped(t)) fallback.push({ k: "typed", text: stripPrivate(t), ts });
      if (p.role === "assistant") fallback.push({ k: "agent", text: t, ts });
    }
    if (o.type === "event_msg" && p.type === "item_completed") {
      const it = p.item ?? {};
      if (it.type === "UserMessage") { const t = textOf(it.content); if (!notTyped(t)) items.push({ k: "typed", text: stripPrivate(t), ts }); }
      if (it.type === "AgentMessage") items.push({ k: "agent", text: textOf(it.content), ts });
      if (it.type === "CommandExecution") {
        const cmd = Array.isArray(it.command) ? it.command.join(" ") : String(it.command ?? "");
        const output = String(it.aggregated_output ?? it.stderr ?? "");
        items.push({ k: "cmd", cmd, failed: typeof it.exit_code === "number" && it.exit_code !== 0, output: output.slice(-2000), ts, size: output.length });
      }
    }
  }
  const hasTyped = items.some((e) => e.k === "typed");
  return { id: sessionIdOf(file), tool: "codex", cwd, clientVersion, events: hasTyped ? items : [...fallback, ...items], unknown, branch: branch || undefined, file };
}
