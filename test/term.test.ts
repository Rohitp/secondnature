import { afterEach, describe, expect, it, vi } from "vitest";
import { c, mark, next } from "../src/term.js";
import { useHome } from "./helpers.js";

const tty = (on: boolean) => Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
afterEach(() => { tty(false); delete process.env.NO_COLOR; vi.restoreAllMocks(); });

describe("terminal output", () => {
  it("uses colour only in a terminal, and never with NO_COLOR", () => {
    tty(false); expect(c.cmd("muninn ui")).toBe("muninn ui");
    tty(true); expect(c.cmd("muninn ui")).toContain("\x1b[");
    process.env.NO_COLOR = "1"; expect(c.cmd("muninn ui")).toBe("muninn ui");
  });
  it("keeps the words beside every mark, so it reads the same without colour", () => {
    tty(false);
    expect([mark.ok(), mark.need(), mark.fail(), mark.skip()]).toEqual(["✓", "!", "✗", "–"]);
    expect(next("muninn ui")).toBe("Next: muninn ui");
  });
});

describe("muninn with nothing after it", () => {
  it("on a new machine, leads with what needs you and the one command to run", async () => {
    useHome(); tty(false);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(String(s)); });
    const { homeScreen } = await import("../src/commands/home.js");
    await homeScreen(40);
    const out = lines.join("\n").split("\n");
    expect(out[0]).toMatch(/^secondnature · /);
    expect(out).toContain("! secondnature isn't set up on this machine, so agents aren't told anything.");
    expect(out).toContain("  Next: muninn setup");
    expect(out.at(-1)).toBe("All 40 commands: muninn help");
  });
});

describe("muninn status", () => {
  it("puts one part on each line and ends with what to run", async () => {
    useHome(); tty(false); process.env.MUNINN_WRITER = "none";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(String(s)); });
    const { status } = await import("../src/commands/status.js");
    await status();
    const out = lines.join("\n").split("\n");
    delete process.env.MUNINN_WRITER;
    expect(out).toContain("! Claude Code     not connected");
    expect(out.some((l) => l.startsWith("! Your Claude     couldn't find the claude command"))).toBe(true);
    expect(out.at(-1)).toMatch(/^\d+ things need you\. Next: muninn setup$/);
  });
});
