import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { aiOut, aiOutWords, noteOut, pickRunner, pickWriter, resetTime } from "../src/learn/writer.js";
import { tmp, useHome } from "./helpers.js";

/** A stand-in claude command: answers --version, then prints `reply` as its JSON result and exits with `code`. */
function standIn(reply: string, code: number) {
  const dir = tmp(), f = join(dir, "claude");
  writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.0; exit 0; fi\ncat >/dev/null\necho '${JSON.stringify({ type: "result", is_error: code !== 0, result: reply })}'\nexit ${code}\n`);
  chmodSync(f, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.MUNINN_WRITER = "claude";
}

beforeEach(() => useHome());

describe("when the AI runs out of usage", () => {
  it("reads the reset time from what the client said, else waits an hour", () => {
    const now = new Date(2026, 10, 24, 10, 0);
    expect(resetTime("Claude AI usage limit reached|1764000000", now).getTime()).toBe(1764000000 * 1000);
    expect(resetTime("5-hour limit reached ∙ resets 3pm", now).getHours()).toBe(15);
    expect(resetTime("limit reached, resets 9am", now).getDate()).toBe(25);
    expect(resetTime("Credit balance is too low", now).getTime() - now.getTime()).toBe(3600_000);
  });

  it("only counts usage and credit errors, not other failures", () => {
    expect(noteOut("claude", "Credit balance is too low")).not.toBeNull();
    expect(noteOut("codex", "You exceeded your current quota, please check your plan and billing details.")).not.toBeNull();
    expect(noteOut("claude", "API Error: 529 Overloaded")).toBeNull();
    expect(noteOut("claude", "SyntaxError: bad JSON")).toBeNull();
  });

  it("pauses AI calls with plain words, lets scans go on without a writer, and clears once a call works", async () => {
    standIn("Claude AI usage limit reached|4102444800", 1);
    const runner = pickRunner("judge")!;
    expect(() => runner.run("hi")).toThrow(/Your Claude is out of usage, so muninn's AI steps are paused until about/);
    expect(aiOut()).toMatchObject({ provider: "claude", until: new Date(4102444800 * 1000).toISOString() });
    // The next call stops at once instead of running the client again.
    await expect(runner.runAsync!("hi")).rejects.toMatchObject({ name: "AiUnavailable" });
    expect(pickWriter()).toBeNull();
    expect(aiOutWords(aiOut()!)).toContain("Everything else keeps working");

    // Credits topped up and "Try again" pressed: the pause is cleared and a working call keeps it clear.
    const { clearAiOut } = await import("../src/learn/writer.js"); clearAiOut();
    standIn("ok", 0);
    expect(pickRunner("judge")!.run("hi")).toBe("ok");
    expect(existsSync(join(process.env.MUNINN_HOME!, "ai-out.json"))).toBe(false);
  });

  it("keeps the client's own words when it fails for another reason", () => {
    standIn("Invalid model name", 1);
    expect(() => pickRunner("judge")!.run("hi")).toThrow(/Claude failed \(exit 1\): Invalid model name/);
    expect(aiOut()).toBeNull();
  });
});
