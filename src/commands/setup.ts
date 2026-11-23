import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { loadEmbedder, modelCached } from "../embed/model.js";
import { saveSettings, settings } from "../config.js";
import { uiDetached } from "../ui/detach.js";
import { codexPresent } from "./install.js";
import { learn } from "./learn.js";
import { pickRunner } from "../learn/writer.js";
import { bar, c, mark, next, pad, plural, version } from "../term.js";

type ToolRow = { id: "claude-code" | "cursor" | "antigravity" | "codex"; name: string; sessions: number; repos: number; on: boolean };
const HOW: Record<ToolRow["id"], string> = {
  "claude-code": "told at session start, on your prompt, when a command fails",
  cursor: "told through rules files, kept out of git",
  antigravity: "told through rules and hooks, per role",
  codex: "hooks added, not checked live yet",
};
const found = (t: ToolRow) => (t.sessions ? `${plural(t.sessions, t.id === "cursor" ? "chat" : "session")} in ${plural(t.repos, "repo")}` : "installed, no sessions yet");

/** Asks yes or no. Outside a terminal it takes the safe answer given, and says so. */
async function ask(q: string, def: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) { console.log(`${c.bold(q)} ${c.dim(`(not a terminal, so: ${def ? "yes" : "no"})`)}`); return def; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${c.bold(q)} ${c.dim(def ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith("y") : def;
}

/** The tool list with ticks: ↑↓ move, space ticks, enter continues, q quits. Outside a terminal it keeps the ticks as they are. */
async function pickTools(rows: ToolRow[]): Promise<ToolRow[] | null> {
  const line = (t: ToolRow, i: number, at: number) => `${i === at && process.stdin.isTTY ? c.cmd("›") : " "}${t.on ? c.ok("[x]") : c.dim("[ ]")} ${pad(t.name, 14)}${c.dim(found(t))}`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    rows.forEach((t, i) => console.log(line(t, i, -1)));
    console.log(c.dim("Not a terminal, so every tool with sessions is ticked."));
    return rows;
  }
  let at = 0;
  const draw = (first: boolean) => {
    if (!first) process.stdout.write(`\x1b[${rows.length + 2}A`);
    for (const [i, t] of rows.entries()) process.stdout.write(`\x1b[2K${line(t, i, at)}\n`);
    process.stdout.write(`\x1b[2K\n\x1b[2K${c.dim("↑↓ move · space tick · enter continue · q quit")}\n`);
  };
  draw(true);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((done) => {
    const finish = (v: ToolRow[] | null) => { process.stdin.off("keypress", onKey); process.stdin.setRawMode(false); process.stdin.pause(); done(v); };
    const onKey = (_: string, k: { name?: string; ctrl?: boolean }) => {
      if (k.name === "up") at = (at + rows.length - 1) % rows.length;
      else if (k.name === "down") at = (at + 1) % rows.length;
      else if (k.name === "space") rows[at]!.on = !rows[at]!.on;
      else if (k.name === "return") return finish(rows);
      else if (k.name === "q" || k.name === "escape" || (k.ctrl && k.name === "c")) return finish(null);
      draw(false);
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Runs fn with console.log quiet, for steps whose own chatter the screen replaces. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log; console.log = () => undefined;
  try { return await fn(); } finally { console.log = orig; }
}

/**
 * One command from nothing to a first look, per the "Setup in the terminal" design board: what's on this Mac with
 * ticks, what setup will do and a yes, then connect, download the model and read your sessions, then the top finds
 * and the review page.
 */
export async function setup(args: string[]) {
  // Run through npx, this copy lives in a cache npm may clear, and the hooks would point at it. Install the command
  // for good first, then carry on from that copy.
  if (/[\\/]_npx[\\/]/.test(import.meta.url) && !process.env.MUNINN_FROM_NPX) {
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    console.log(`Installing the muninn command first, so the hooks don't point at npx's temporary copy:\n  ${c.cmd(`npm install -g secondnature@${version()}`)}\n`);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const inst = spawnSync(npm, ["install", "-g", `secondnature@${version()}`], { stdio: "inherit" });
    if (inst.status !== 0) { console.log(`\n${mark.fail()} ${c.bold("Couldn't install the muninn command.")} Nothing else was changed.\n  ${next(`npm install -g secondnature`, "then muninn setup")}`); process.exitCode = 1; return; }
    const prefix = spawnSync(npm, ["prefix", "-g"], { encoding: "utf8" }).stdout.trim();
    const bin = process.platform === "win32" ? join(prefix, "muninn.cmd") : join(prefix, "bin", "muninn");
    const r = spawnSync(bin, ["setup", ...args], { stdio: "inherit", env: { ...process.env, MUNINN_FROM_NPX: "1" } });
    process.exitCode = r.status ?? 1;
    return;
  }
  const started = Date.now();
  console.log(`${c.bold(`secondnature ${version()}`)}\nTeach your coding agents once. Nothing is told to an agent until you keep it.\n`);

  const { toolsOnThisMac } = await import("../logs/discover.js");
  const alone = new Set(settings().leaveAlone ?? []);
  const rows: ToolRow[] = toolsOnThisMac(codexPresent()).map((t) => ({ ...t, on: alone.has(t.id) ? false : t.sessions > 0 || t.id === "claude-code" }));
  if (!rows.length) {
    console.log(`${mark.need()} ${c.bold("No coding tools found on this Mac.")} secondnature works with Claude Code, Cursor, Antigravity and Codex.\n  ${next("muninn setup", "again once one is installed. Nothing was changed.")}`);
    return;
  }
  console.log(c.bold("Found on this Mac"));
  const picked = await pickTools(rows);
  if (!picked) { console.log("\nStopped. Nothing was changed."); return; }
  const on = picked.filter((t) => t.on);
  if (!on.length) { console.log(`\n${mark.skip()} Nothing ticked, so nothing to set up. Nothing was changed.`); return; }

  console.log(`\n${c.bold("What this does")}
${c.cmd("  Reads      ")}the session logs above, on this Mac. Never your code,
             unless a session quoted it.
${c.cmd("  Sends      ")}redacted excerpts to your own Claude, to write each lesson.
${modelCached() ? "" : `${c.cmd("  Downloads  ")}a 33 MB model, once, to compare text on this Mac.\n`}${c.cmd("  Changes    ")}adds hooks and rules files so agents can be told.
             Undo all of it with ${c.cmd("muninn uninstall")}.
`);
  if (!(await ask("Set it up?", true))) { console.log("Stopped. Nothing was changed."); return; }
  // Unticked tools are left alone from now on: no hooks, no rules files, logs not read.
  saveSettings({ leaveAlone: picked.filter((t) => !t.on).map((t) => t.id) });

  // 1. Connect.
  console.log(`\n${c.bold("1  Connect your tools")}`);
  const { connectEverything } = await import("./connect.js");
  const steps = await quietly(() => connectEverything());
  const failed = steps.filter((s) => s.result === "failed");
  for (const t of on) console.log(`   ${failed.some((s) => /hook/i.test(s.what)) && t.id !== "cursor" ? mark.fail() : mark.ok()} ${pad(t.name, 19)}${c.dim(HOW[t.id])}`);
  const mcp = steps.find((s) => /MCP/.test(s.what));
  if (mcp && mcp.result !== "failed" && mcp.result !== "skipped") console.log(`   ${mark.ok()} ${pad("Ask from chat", 19)}${c.dim("agents and the Claude app can search what you keep")}`);
  const bg = steps.find((s) => /Background/.test(s.what));
  if (bg && bg.result !== "failed") console.log(`   ${mark.ok()} ${pad("Checks on its own", 19)}${c.dim("every few hours.")} ${c.cmd("muninn schedule off")} ${c.dim("stops it")}`);
  for (const s of failed) console.log(`   ${mark.fail()} ${s.what}: ${c.fail(s.note ?? "failed")}`);

  // 2. The model.
  console.log("");
  if (modelCached()) console.log(`${c.bold("2  Download the model")}   ${bar(1)}  ${c.dim("33 MB")}  ${c.ok("already here")}`);
  else {
    console.log(c.bold("2  Download the model"));
    try { await loadEmbedder(); console.log(`   ${bar(1)}  ${c.dim("33 MB")}  ${c.ok("done")}`); }
    catch (e) {
      console.log(`   ${mark.fail()} ${c.fail(`Couldn't download it: ${e instanceof Error ? e.message : String(e)}`)}\n   ${next("muninn learn --all-repos", "to try again")}`);
      return;
    }
  }

  // 3. Read the sessions, with a live count of lessons as your Claude writes them.
  console.log(`\n${c.bold("3  Read your sessions")}`);
  for (const t of on.filter((x) => x.sessions)) console.log(`   ${pad(t.name, 14)}${c.dim(plural(t.sessions, t.id === "cursor" ? "chat" : "session"))}`);
  const noClient = !pickRunner("judge");
  if (noClient) console.log(`${c.warn("   ! Couldn't find the claude command.")}
     Without it, only things you said word for word more than once
     can become lessons. To fix it: install Claude Code, check that
     ${c.cmd("claude --version")} works, then run ${c.cmd("muninn learn")}.`);
  const { openDb } = await import("../store/db.js");
  const db = await openDb();
  const before = new Date(started).toISOString();
  const count = async () => Number((await db.execute({ sql: "SELECT count(*) n FROM lessons WHERE status='proposed' AND created_at>=?", args: [before] })).rows[0]?.n ?? 0);
  const live = process.stdout.isTTY;
  let tick: NodeJS.Timeout | null = null;
  if (live) {
    const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; let i = 0;
    process.stdout.write(c.dim("   This takes a few minutes. Close this window if you like; secondnature reads them again on its own later.\n"));
    tick = setInterval(() => { void count().then((n) => process.stdout.write(`\r\x1b[2K   ${c.cmd(spin[i++ % spin.length]!)} ${noClient ? "Reading" : "Writing lessons with your Claude:"} ${c.bold(noClient ? "…" : `${n} so far`)}`)); }, 250);
  }
  try { await quietly(() => learn({ allRepos: true, noReview: true })); }
  finally { if (tick) { clearInterval(tick); process.stdout.write("\r\x1b[2K"); } }

  // 4. Done: the top finds, then the review page.
  const secs = Math.round((Date.now() - started) / 1000);
  const top = (await db.execute({ sql: "SELECT text, plain, sessions FROM lessons WHERE status='proposed' ORDER BY sessions DESC, last_seen DESC LIMIT 3" })).rows;
  const waiting = Number((await db.execute("SELECT count(*) n FROM lessons WHERE status='proposed'")).rows[0]?.n ?? 0);
  const sessions = on.reduce((a, t) => a + t.sessions, 0);
  console.log("");
  if (waiting) {
    console.log(`${mark.ok()} ${c.bold(`Done in ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`}.`)}\n`);
    console.log(`Across ${plural(sessions, "session")} in ${plural(on.filter((t) => t.sessions).length, "tool")}, secondnature found\n${c.bold(plural(waiting, "thing"))} worth telling your agents. The top ${top.length}:\n`);
    const clip = (s: string) => (s.length > 52 ? `${s.slice(0, s.lastIndexOf(" ", 51) > 30 ? s.lastIndexOf(" ", 51) : 51)}…` : s);
    top.forEach((r, i) => { const t = clip(String(r.plain ?? r.text).replace(/\s+/g, " ")); console.log(`  ${i + 1}  ${pad(t, 54)}${c.dim(Number(r.sessions) > 1 ? `in ${r.sessions} sessions` : "")}`); });
    console.log("");
    if (args.includes("--no-open")) console.log(`Keep what's useful. Nothing is told to your agents until you do.\n${next("muninn ui")}`);
    else {
      try { const link = await uiDetached({ open: true }); console.log(`Opening the review page: ${c.cmd(link.match(/https?:\S+/)?.[0] ?? link)}\nKeep what's useful there. Nothing is told to your agents until you do.`); }
      catch (e) { console.log(`Couldn't open the review page: ${e instanceof Error ? e.message : String(e)}\n${next("muninn ui")}`); }
    }
  } else {
    console.log(`${mark.ok()} ${c.bold("Connected. No sessions to learn from yet.")}\n\nWork as usual in ${on.map((t) => t.name).join(", ")}. secondnature\nlooks again on its own after each session, and tells you when it\nhas something to review.`);
  }
  console.log(`\n${c.bold("Next time")}\n  You just work. To check on it: ${c.cmd("muninn")}${c.dim("  (shows what needs you)")}\n  To undo everything: ${c.cmd("muninn uninstall")}`);
}
