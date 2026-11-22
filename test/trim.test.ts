import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { LogEvent, Session } from "../src/logs/types.js";
import { apply, listProposals, propose, trimProposals, undo } from "../src/propose/index.js";
import { checkTrim, familyOf, plainCommand, stressSamples, TRIM_PATH, TRIM_SCRIPT } from "../src/propose/trim.js";
import { repoIdentity } from "../src/repo/identity.js";
import { openDb } from "../src/store/db.js";
import { ensureRepo, getLesson } from "../src/store/lessons.js";
import { tmp, useHome } from "./helpers.js";

let root = ""; let repo = "";
beforeEach(async () => {
  useHome(); root = join(tmp(), "repo"); mkdirSync(root); execFileSync("git", ["init", "-q", root]);
  repo = repoIdentity(root)!; await ensureRepo(await openDb(), repo, root);
});
const at = (d: number) => new Date(Date.UTC(2026, 10, d, 10)).toISOString();
const testOutput = Array.from({ length: 400 }, (_, i) => `  ✓ case ${i} passes`).join("\n");
const run = (cmd: string, d: number): LogEvent => ({ k: "cmd", cmd, failed: false, output: testOutput.slice(-2000), ts: at(d), size: testOutput.length * 2 });
const sess = (id: string, events: LogEvent[]): Session => ({ id, tool: "claude-code", cwd: root, clientVersion: "1", unknown: 0, events });

describe("which commands get a trim", () => {
  it("sorts commands into families, and leaves alone what it can't trim or already trims", () => {
    expect(familyOf("npm test")).toBe("test");
    expect(familyOf("npx vitest run")).toBe("test");
    expect(familyOf("npm run build")).toBe("build");
    expect(familyOf("npx eslint src")).toBe("lint");
    expect(familyOf("pnpm install")).toBe("install");
    expect(familyOf("git diff main")).toBe("git");
    expect(familyOf("ls -la")).toBeNull();
    expect(familyOf(`sh ${TRIM_PATH} test -- npm test`)).toBeNull();
  });
  it("wraps the plain command, without cd, a pipe to tail, or 2>&1", () => {
    expect(plainCommand("cd web && npm test 2>&1 | tail -40")).toBe("npm test");
    expect(plainCommand("/bin/zsh -lc 'pytest -q'")).toBe("pytest -q");
  });
});

describe("the safety check", () => {
  it("passes the script on long and short output, passing and failing", () => {
    for (const f of ["test", "build", "lint", "install"] as const) {
      const cases = checkTrim(f, stressSamples(f));
      expect(cases.every((c) => c.ok), JSON.stringify(cases)).toBe(true);
      // Long output comes out at least five times smaller.
      expect(cases[0]!.outBytes * 5).toBeLessThan(cases[0]!.inBytes);
    }
  });
  it("catches a script that loses the exit code or an error line", () => {
    const noCode = TRIM_SCRIPT.replace(/exit \$code\n$/, "exit 0\n");
    expect(checkTrim("test", stressSamples("test"))[1]!.ok).toBe(true);
    expect(checkTrim("test", stressSamples("test"), noCode)[1]).toMatchObject({ ok: false, problem: "exit code 0, expected 1" });
    const noErrors = TRIM_SCRIPT.replace('tolower($0) ~ re { after = 3 }', "");
    expect(checkTrim("test", stressSamples("test"), noErrors)[0]!.problem).toContain("dropped a line that matters");
  });
});

describe("trim proposals", () => {
  it("proposes a trim for a test command that keeps printing a lot, then applies and undoes it", async () => {
    const db = await openDb();
    const sessions = [sess("a", [run("npm test", 1), run("npm test", 1)]), sess("b", [run("cd x && npm test", 2)])];
    const [p, ...rest] = trimProposals(repo, sessions);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ kind: "trim", key: "trim:npm test", title: "Show agents only what matters from `npm test`" });
    expect(p!.why).toContain("ran 3 times in 2 session(s)");
    expect(p!.payload.lesson).toContain(`sh ${TRIM_PATH} test -- npm test`);
    expect(await propose(db, p!)).toBe(true);

    const [waiting] = await listProposals(db, repo);
    await apply(db, waiting!.id);
    expect(readFileSync(join(root, TRIM_PATH), "utf8")).toBe(TRIM_SCRIPT);
    // The full outputs are kept out of git.
    expect(execFileSync("git", ["-C", root, "check-ignore", ".muninn/out/x.log"], { encoding: "utf8" }).trim()).toBe(".muninn/out/x.log");
    const applied = (await listProposals(db, repo, "applied"))[0]!;
    const lesson = await getLesson(db, String((applied.payload.after as { lesson: string }).lesson));
    expect(lesson).toMatchObject({ status: "live", always_on: 1, text: p!.payload.lesson });

    await undo(db, applied.id);
    expect(existsSync(join(root, TRIM_PATH))).toBe(false);
    expect((await getLesson(db, lesson!.id))!.status).toBe("retired");
  });
  it("doesn't propose for commands with small output or run only once", () => {
    const small: LogEvent = { k: "cmd", cmd: "npm test", failed: false, output: "ok", ts: at(1), size: 400 };
    expect(trimProposals(repo, [sess("a", [small, small, small])])).toEqual([]);
    expect(trimProposals(repo, [sess("a", [run("npm test", 1)])])).toEqual([]);
  });
  it("for git, proposes a lesson only, and writes no script", async () => {
    const db = await openDb();
    const [p] = trimProposals(repo, [sess("a", [run("git diff main", 1), run("git diff main", 1)])]);
    expect(p!.title).toBe("Narrow `git diff main` before reading it");
    await propose(db, p!);
    await apply(db, (await listProposals(db, repo))[0]!.id);
    expect(existsSync(join(root, TRIM_PATH))).toBe(false);
  });
});
