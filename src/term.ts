/**
 * How every command prints, from the "Everyday commands and terminal rules" board of the design canvas:
 * lead with the answer, end with one "Next:" and the exact command, marks always with words, colour only for meaning
 * (blue a command to run, green working, amber needs you, red failed, grey detail), and none when NO_COLOR is set or
 * the output isn't a terminal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const colorOn = (stream: { isTTY?: boolean } = process.stdout) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
// The app's colours, lightened for a dark terminal, as the design gives them. 24-bit where the terminal says it can.
const RGB = { cmd: [143, 176, 255], ok: [111, 207, 151], warn: [246, 195, 139], fail: [255, 156, 138], dim: [154, 163, 178] } as const;
const BASIC = { cmd: 94, ok: 32, warn: 33, fail: 31, dim: 90 } as const;
type Tone = keyof typeof RGB;
const paint = (tone: Tone) => (s: string | number) => {
  if (!colorOn()) return String(s);
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
  const [r, g, b] = RGB[tone];
  return `${truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[${BASIC[tone]}m`}${s}\x1b[39m`;
};
export const c = {
  cmd: paint("cmd"), ok: paint("ok"), warn: paint("warn"), fail: paint("fail"), dim: paint("dim"),
  bold: (s: string | number) => (colorOn() ? `\x1b[1m${s}\x1b[22m` : String(s)),
};
/** The four marks. Each line that has one also says in words what it means. */
export const mark = { ok: () => c.ok("✓"), need: () => c.warn("!"), fail: () => c.fail("✗"), skip: () => c.dim("–") };
/** The last line when there's something to do: "Next:" and the exact command. */
export const next = (cmd: string, after = "") => `Next: ${c.cmd(cmd)}${after ? ` ${after}` : ""}`;
/** A name padded to a column, measured without colour codes. */
export const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
/** A bar of 16 cells for progress, filled to a share between 0 and 1. */
export const bar = (share: number, cells = 16) => { const f = Math.round(Math.max(0, Math.min(1, share)) * cells); return c.cmd("█".repeat(f)) + c.dim("░".repeat(cells - f)); };
export const version = () => { try { return String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version); } catch { return ""; } };
export const clock = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An error in plain words: what went wrong, why if known, and the one thing to do about it. */
export async function friendlyError(e: unknown): Promise<string> {
  const msg = e instanceof Error ? e.message : String(e);
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    let who = "";
    try {
      const { scanRunning } = await import("./commands/auto.js");
      const { statSync } = await import("node:fs"); const { home } = await import("./config.js");
      if (scanRunning()) who = ` (muninn learn, started at ${clock(new Date(statSync(join(home(), "auto.lock")).mtimeMs))})`;
    } catch { /* say it without the name */ }
    return `${mark.fail()} ${c.bold("Couldn't open secondnature's data.")}
  Another muninn command is using it right now${who}. Wait for it to finish,
  then run this again.

  ${c.dim("Still stuck after 10 minutes?")} ${c.cmd("muninn status")} ${c.dim("shows what's running.")}`;
  }
  return `${mark.fail()} ${c.bold(msg.split("\n")[0] ?? msg)}\n  ${c.dim("If it keeps happening,")} ${c.cmd("muninn status")} ${c.dim("checks every part.")}`;
}
