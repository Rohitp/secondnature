import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, leftAlone } from "../config.js";
import { install } from "./install.js";

/**
 * Connects muninn to every coding tool on this machine, in one go, and can be run again to repair anything that
 * dropped off. What it does, each only where that tool is installed:
 *   hooks       Claude Code, Codex and Antigravity: lessons at the right moment, and the logs muninn learns from
 *   plugin      Claude Code: muninn's panel, and its MCP server in a form running sessions can't drop
 *   MCP         the Claude desktop app, Cursor, Codex and Antigravity: agents can ask muninn questions
 *   background  macOS: a job that checks for lessons every few hours, for days without Claude Code
 * Rules files for Cursor and Antigravity turn on by themselves in each repo where those tools are used, at scans.
 * Every step is safe to repeat: it changes only what's missing.
 */
export type Step = { what: string; result: "done" | "already" | "skipped" | "failed"; note?: string };

const packageRoot = () => { const here = dirname(fileURLToPath(import.meta.url)); const root = join(here, "..", ".."); return existsSync(root) ? realpathSync(root) : root; };
const claude = (...a: string[]) => spawnSync("claude", a, { encoding: "utf8", timeout: 60_000 });
const hasClaudeCli = () => !process.env.MUNINN_CLAUDE_SETTINGS && claude("--version").status === 0;

/** The muninn-panel plugin in Claude Code, from this installed package (no download). It carries muninn's MCP server. */
export function connectClaudePlugin(): Step {
  if (!hasClaudeCli()) return { what: "Claude Code plugin", result: "skipped", note: "the claude command isn't on the PATH" };
  const root = packageRoot();
  if (!existsSync(join(root, ".claude-plugin", "marketplace.json"))) return { what: "Claude Code plugin", result: "skipped", note: "this copy of muninn has no plugin files" };
  const installed = claude("plugin", "list").stdout ?? "";
  if (/muninn-panel@muninn/.test(installed)) return { what: "Claude Code plugin", result: "already" };
  if (!/❯ muninn\b/.test(claude("plugin", "marketplace", "list").stdout ?? "")) {
    const add = claude("plugin", "marketplace", "add", root);
    if (add.status !== 0) return { what: "Claude Code plugin", result: "failed", note: (add.stderr || add.stdout || "").trim().split("\n")[0] };
  }
  const inst = claude("plugin", "install", "muninn-panel@muninn");
  return inst.status === 0 ? { what: "Claude Code plugin", result: "done", note: "muninn's panel, and its MCP server (start a new session to load it)" } : { what: "Claude Code plugin", result: "failed", note: (inst.stderr || inst.stdout || "").trim().split("\n")[0] };
}

/**
 * Everything, in order. `quiet` is for automatic repair during scans: only file changes, no calls to the claude
 * command (slow) and nothing printed.
 */
/** Written by "muninn uninstall" and "muninn mcp uninstall": automatic repair stops until you run "muninn connect" yourself. */
export const disconnectedFile = () => join(ensureHome(), "disconnected");
export function markDisconnected() { try { writeFileSync(disconnectedFile(), new Date().toISOString()); } catch { /* best effort */ } }

export async function connectEverything(opts: { quiet?: boolean } = {}): Promise<Step[]> {
  // You took muninn out: automatic repair leaves it out. Running "muninn connect" yourself puts it back.
  if (opts.quiet && existsSync(disconnectedFile())) return [];
  if (!opts.quiet) rmSync(disconnectedFile(), { force: true });
  const steps: Step[] = [];
  const log = (s: Step) => { steps.push(s); if (!opts.quiet) console.log(`   ${s.result === "done" ? "✓" : s.result === "already" ? "·" : s.result === "failed" ? "✗" : "–"} ${s.what}${s.result === "already" ? ": already set up" : s.result === "skipped" ? `: skipped${s.note ? ` (${s.note})` : ""}` : s.note ? `: ${s.note}` : ""}`); };
  const quietly = <T>(fn: () => T): T => { if (!opts.quiet) return fn(); const orig = console.log; console.log = () => undefined; try { return fn(); } finally { console.log = orig; } };

  // Hooks: Claude Code, Codex, Antigravity.
  try { quietly(() => install()); log({ what: "Hooks (Claude Code, and Codex and Antigravity where installed)", result: "done" }); }
  catch (e) { log({ what: "Hooks", result: "failed", note: e instanceof Error ? e.message : String(e) }); }

  // The plugin first: when it carries the MCP server, Claude Code needs no separate entry.
  const plugin = opts.quiet || leftAlone("claude-code") ? null : connectClaudePlugin();
  if (plugin) log(plugin);

  // MCP everywhere else (and Claude Code's own entry when the plugin couldn't be installed).
  try {
    const { installMcp } = await import("../mcp/install.js");
    const skipClaude = opts.quiet || leftAlone("claude-code") || plugin?.result === "done" || plugin?.result === "already";
    const done = quietly(() => installMcp({ skipClaudeCode: skipClaude }));
    log({ what: "MCP server, so agents can ask muninn questions", result: done.length ? "done" : "skipped", note: done.length ? done.join(", ") : "no other app with MCP found" });
  } catch (e) { log({ what: "MCP server", result: "failed", note: e instanceof Error ? e.message : String(e) }); }

  // The background job, on a Mac.
  // Turned on only when you set muninn up or run "muninn connect": never by automatic repair, so "schedule off" sticks.
  if (!opts.quiet && process.platform === "darwin" && !process.env.MUNINN_LAUNCH_AGENTS_SKIP) {
    const { scheduleOn, schedule } = await import("./schedule.js");
    if (scheduleOn()) log({ what: "Background check every few hours", result: "already" });
    else { try { quietly(() => schedule("on")); log({ what: "Background check every few hours", result: "done", note: '"muninn schedule off" removes it' }); } catch (e) { log({ what: "Background check", result: "failed", note: e instanceof Error ? e.message : String(e) }); } }
  }
  return steps;
}
