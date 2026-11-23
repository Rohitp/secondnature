import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, leftAlone } from "../config.js";
import { setAntigravityHooks } from "../deliver/antigravity-hook.js";

export type Client = "claude-code" | "codex";
const files: Record<Client, () => string> = {
  "claude-code": () => process.env.MUNINN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json"),
  codex: () => process.env.MUNINN_CODEX_HOOKS ?? join(homedir(), ".codex", "hooks.json"),
};
/** Claude Code's user settings file (or the one tests point at). */
export const claudeSettingsFile = () => files["claude-code"]();
const NAMES: Record<Client, string> = { "claude-code": "Claude Code", codex: "Codex" };
const cli = () => { const p = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js"); return existsSync(p) ? realpathSync(p) : p; };
const hookCommand = (client: Client) => `"${realpathSync(process.execPath)}" "${cli()}" hook --client ${client}`;
const isOurs = (h: any) => typeof h?.command === "string" && h.command.includes("hook --client") && h.command.includes("cli.js");

/** Event and matcher per client. Codex has no failure event, so muninn checks each Bash result itself. */
export const EVENTS: Record<Client, Record<string, string | undefined>> = {
  // Stop (Claude finished a reply) and PreCompact keep the branch's plan current during long sessions.
  // Failures of file reads, edits and searches too, so a wrong path retried over and over is caught as it happens.
  "claude-code": { SessionStart: undefined, UserPromptSubmit: undefined, PostToolUseFailure: "Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob", SubagentStart: undefined, Stop: undefined, PreCompact: undefined, SessionEnd: undefined,
    // Agent teams: which session is which teammate, and the tasks they hand each other. Recorded only; nothing is told.
    TaskCreated: undefined, TaskCompleted: undefined, TeammateIdle: undefined },
  codex: { SessionStart: undefined, UserPromptSubmit: undefined, PostToolUse: "Bash", SubagentStart: undefined, Stop: undefined, PreCompact: undefined, SessionEnd: undefined },
};
export const DELIVERY_EVENTS = Object.fromEntries(Object.entries(EVENTS["claude-code"]).filter(([e]) => e !== "SessionEnd"));
export const ALL_EVENTS = Object.keys(EVENTS["claude-code"]);
/** Codex is set up only when it is installed here. */
export const codexPresent = () => (process.env.MUNINN_CODEX_HOOKS ? true : !process.env.MUNINN_CLAUDE_SETTINGS && existsSync(join(homedir(), ".codex")));

function read(file: string): any {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`${file} isn't valid JSON, so muninn left it alone.`); }
}
/** Adds muninn's hooks to one client's hook file, keeping every other hook. */
export function installFor(client: Client, events = Object.keys(EVENTS[client])): string[] {
  const file = files[client]();
  const cfg = read(file);
  cfg.hooks ??= {};
  const added: string[] = []; const widened: string[] = [];
  for (const ev of events) {
    if (!(ev in EVENTS[client])) continue;
    const list: any[] = (cfg.hooks[ev] ??= []);
    const matcher = EVENTS[client][ev];
    const mine = list.find((g) => g.hooks?.some(isOurs));
    if (mine) {
      // Installed by an older muninn with a narrower matcher: widen it, if the group holds only muninn's hook.
      if (matcher && mine.matcher !== matcher && mine.hooks.every(isOurs)) { mine.matcher = matcher; widened.push(ev); }
      continue;
    }
    // Codex allows SessionEnd hooks at most 3 seconds.
    const timeout = ev === "SessionEnd" ? 3 : 5;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand(client), timeout }] });
    added.push(ev);
  }
  if (!added.length && !widened.length) return [];
  const had = existsSync(file);
  if (had) copyFileSync(file, `${file}.muninn-backup`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  const what = [added.length ? `added muninn hooks for ${added.join(", ")}` : "", widened.length ? `updated muninn's ${widened.join(", ")} hook to also catch failed file reads, edits and searches` : ""].filter(Boolean).join("; ");
  console.log(`In ${file}: ${what}.${had ? " The previous file is saved next to it as .muninn-backup." : ""}`);
  return [...added, ...widened];
}
/** Installs for Claude Code, and for Codex when it is present. */
export function install(events = ALL_EVENTS) {
  // The `muninn` command reruns itself on this Node when the PATH offers an older one (the hooks use it directly).
  writeFileSync(join(ensureHome(), "node"), realpathSync(process.execPath));
  // Tools you unticked in setup get no hooks.
  const done = leftAlone("claude-code") ? [] : installFor("claude-code", events);
  // Antigravity: mid-run warnings for its agents, where it's installed.
  if (events.includes("PostToolUseFailure") && !leftAlone("antigravity")) {
    try {
      if (setAntigravityHooks((ev: string) => `"${realpathSync(process.execPath)}" "${cli()}" hook --client antigravity --event ${ev}`, true)) console.log("Added muninn to Antigravity's hooks (~/.gemini/config/hooks.json): its agents get a warning when a command keeps failing the same way, and lessons whose keywords match what you typed.");
    } catch (e) { console.log(`Couldn't add Antigravity's hooks: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const codex = codexPresent() && !leftAlone("codex") ? installFor("codex", events.map((e) => (e === "PostToolUseFailure" ? "PostToolUse" : e))) : [];
  if (!done.length && !codex.length) { if (!leftAlone("claude-code")) console.log("muninn's hooks are already installed."); return; }
  if ([...done, ...codex].includes("SessionEnd")) console.log('When a session ends, muninn writes a short handoff and may scan for lessons. Both send redacted excerpts to your Claude Code or Codex. Turn scans off with "autoLearn": false in muninn\'s config.json.');
  if (codex.length) console.log('Codex runs a new hook only after you trust it: open Codex, type /hooks, and trust the muninn entries. Until then Codex skips them.');
  if (done.length) console.log("Cursor also runs hooks from Claude Code's file. muninn spots Cursor and sends nothing there, since Cursor gets lessons through rules files (muninn cursor on).");
}
export const installLearnHook = () => install(["SessionEnd"]);
export function uninstall() {
  try { setAntigravityHooks(() => "", false); } catch { /* leave a file muninn can't read alone */ }
  for (const client of Object.keys(files) as Client[]) {
    const file = files[client]();
    if (!existsSync(file)) continue;
    const cfg = read(file);
    if (!cfg.hooks) continue;
    for (const ev of Object.keys(cfg.hooks)) {
      const kept = (cfg.hooks[ev] as any[]).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) })).filter((g) => g.hooks.length);
      if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
    }
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  }
}
export const removeLearnHook = uninstall;
export function installed(client: Client = "claude-code"): string[] {
  const cfg = read(files[client]());
  return Object.keys(EVENTS[client]).filter((ev) => (cfg.hooks?.[ev] ?? []).some((g: any) => g.hooks?.some(isOurs)));
}
export const clientName = (c: Client) => NAMES[c];
