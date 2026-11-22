import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../logs/types.js";
import { redact } from "../privacy/redact.js";
import { wasteIndex, type WasteRow } from "../learn/waste-index.js";
import { syncLessonFiles } from "../deliver/local-file.js";
import { createLesson, decide } from "../store/lessons.js";
import { registerAfter, registerApplier, type NewProposal } from "./store.js";

/**
 * Learned waste reduction, step 2: for a test, build, lint or install command that keeps showing agents far more
 * output than they need, propose a small script that runs it, keeps the whole output in a file, and shows only
 * what matters. The safety rule, checked before anything is proposed:
 *   - the command's exit code comes back unchanged
 *   - every line that looks like an error, failure or warning is shown
 *   - the full output is kept on disk, and the agent is told where
 *   - short output is shown whole
 * Git output (diffs, logs) can't be trimmed safely by pattern, so for git the fix is a lesson only.
 */
export type Family = "test" | "build" | "lint" | "install" | "git";
const FAMILIES: [Family, RegExp][] = [
  ["git", /^git (log|diff|show|blame)\b/],
  ["lint", /\b(lint|eslint|ruff|flake8|pylint|mypy|golangci-lint|clippy|biome|rubocop|typecheck|tsc --noEmit|prettier --check)\b/],
  ["test", /\b(test|tests|vitest|jest|pytest|mocha|rspec|phpunit|ctest|tox|playwright)\b/],
  ["install", /^(npm (i|ci|install)|pnpm (i|install|add)|yarn( install| add)?$|bun (i|install|add)|pip3? install|uv (sync|pip install)|poetry install|bundle install|cargo fetch|go mod download|brew install)\b/],
  ["build", /\b(build|tsc|compile|webpack|gradle|mvn|make|cargo b)\b/],
];
export const familyOf = (key: string): Family | null => (key.includes(".muninn/bin/trim") ? null : FAMILIES.find(([, re]) => re.test(key))?.[0] ?? null);

/** Where the script lives in the repo, and where it keeps full outputs (kept out of git). */
export const TRIM_PATH = ".muninn/bin/trim";
export const TRIM_OUT = ".muninn/out/";
/** Lines that matter in any family. Case-insensitive; kept broad on purpose: showing a line too many is safe. */
export const ERROR_RE = "(error|fail|failed|failure|failing|panic|traceback|exception|warn|warning|fatal|denied|not ok|assert|cannot|can.t|unable|missing|undefined|segmentation|✗|✘|×)";
/** Output up to this many lines and bytes is shown whole. */
const SMALL = { lines: 80, bytes: 8000 };
/** Lines from the end that are always shown: test and build tools print their summary last. */
const TAIL: Record<Exclude<Family, "git">, number> = { test: 30, build: 25, lint: 15, install: 15 };

export const TRIM_SCRIPT = `#!/bin/sh
# Written by muninn (secondnature). Runs a command, keeps its whole output in ${TRIM_OUT}, and shows only what
# matters: every line that looks like an error, failure or warning (with 2 lines after it), the last lines, and
# the exit code, which is passed through unchanged. Short output is shown whole.
# Usage: sh ${TRIM_PATH} <test|build|lint|install> -- <command and its arguments>
#   e.g. sh ${TRIM_PATH} test -- npm test
#   for a pipeline or "&&": sh ${TRIM_PATH} test -- sh -c 'cd web && npm test'
family="$1"; shift
[ "$1" = "--" ] && shift
case "$family" in test) tail_n=${TAIL.test};; build) tail_n=${TAIL.build};; lint) tail_n=${TAIL.lint};; *) tail_n=${TAIL.install};; esac
top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
dir="$top/${TRIM_OUT}"
mkdir -p "$dir"
log="$dir$(date +%Y%m%d-%H%M%S)-$$.log"
"$@" > "$log" 2>&1
code=$?
lines=$(wc -l < "$log" | tr -d ' ')
bytes=$(wc -c < "$log" | tr -d ' ')
if [ "$lines" -le ${SMALL.lines} ] && [ "$bytes" -le ${SMALL.bytes} ]; then
  cat "$log"
else
  awk -v n="$tail_n" -v total="$lines" '
    BEGIN { re = "${ERROR_RE}" }
    { keep = 0 }
    tolower($0) ~ re { after = 3 }
    after > 0 { keep = 1; after-- }
    NR > total - n { keep = 1 }
    keep { if (NR > last + 1) print "  [... " (NR - last - 1) " line(s) not shown]"; print; last = NR }
    END { if (last < total) print "  [... " (total - last) " line(s) not shown]" }
  ' "$log"
fi
echo "[trim] exit code $code. Full output ($lines lines) is in $log; read it only if what is shown is not enough."
exit $code
`;

export type CheckCase = { name: string; ok: boolean; problem?: string; inBytes: number; outBytes: number };
/** Runs the script on sample outputs and checks the safety rule on each. */
export function checkTrim(family: Exclude<Family, "git">, samples: { name: string; text: string; code: number }[], script = TRIM_SCRIPT): CheckCase[] {
  const dir = mkdtempSync(join(tmpdir(), "muninn-trim-"));
  try {
    const file = join(dir, "trim");
    writeFileSync(file, script);
    return samples.map((s, i) => {
      const sample = join(dir, `sample-${i}.txt`);
      writeFileSync(sample, s.text);
      let out = ""; let code = 0;
      try { out = execFileSync("sh", [file, family, "--", "sh", "-c", `cat "$0"; exit ${s.code}`, sample], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
      catch (e: any) { out = String(e.stdout ?? ""); code = e.status ?? -1; }
      const base = { name: s.name, inBytes: s.text.length, outBytes: out.length };
      if (code !== s.code) return { ...base, ok: false, problem: `exit code ${code}, expected ${s.code}` };
      const re = new RegExp(ERROR_RE, "i");
      const lost = s.text.split("\n").find((l) => re.test(l) && !out.includes(l));
      if (lost !== undefined) return { ...base, ok: false, problem: `dropped a line that matters: ${lost.slice(0, 120)}` };
      const saved = out.match(/Full output \(\d+ lines\) is in (\S+);/)?.[1];
      if (!saved) return { ...base, ok: false, problem: "didn't say where the full output is" };
      if (readFileSync(saved, "utf8") !== s.text) return { ...base, ok: false, problem: "the saved output isn't the whole output" };
      return { ...base, ok: true };
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Long made-up outputs in each family's shape, with problems buried in the middle, so the check covers big output too. */
export function stressSamples(family: Exclude<Family, "git">): { name: string; text: string; code: number }[] {
  const pad = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
  const body: Record<typeof family, string> = {
    test: `${pad(300, (i) => `  ✓ case ${i} works (${i % 7}ms)`)}\n  ✗ totals round half up\n    AssertionError: expected 10.5 to equal 11\n      at src/totals.test.ts:42:7\n${pad(300, (i) => `  ✓ other ${i}`)}\nTests: 1 failed, 600 passed`,
    build: `${pad(400, (i) => `compiling module ${i}`)}\nsrc/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n${pad(200, (i) => `emitting chunk ${i}`)}\nBuild finished with 1 error`,
    lint: `${pad(300, (i) => `src/file${i}.ts: ok`)}\nsrc/x.ts:3:1  warning  Unexpected console statement  no-console\n${pad(200, (i) => `src/more${i}.ts: ok`)}\n1 problem (0 errors, 1 warning)`,
    install: `${pad(500, (i) => `Downloading package-${i}@1.0.${i}`)}\nnpm WARN deprecated left-pad@1.3.0: use String.prototype.padStart\n${pad(200, (i) => `Linking package-${i}`)}\nadded 700 packages in 12s`,
  };
  return [
    { name: `long ${family} output that passed`, text: body[family], code: 0 },
    { name: `long ${family} output that failed`, text: body[family], code: 1 },
    { name: "short output", text: "all good\n", code: 0 },
  ];
}

const LESSON: Record<Family, (cmd: string) => string> = {
  test: (c) => `Run \`${c}\` as \`sh ${TRIM_PATH} test -- ${c}\`: it shows the failures, the summary and the exit code, and saves the full output to a file it names.`,
  build: (c) => `Run \`${c}\` as \`sh ${TRIM_PATH} build -- ${c}\`: it shows the errors, the last lines and the exit code, and saves the full output to a file it names.`,
  lint: (c) => `Run \`${c}\` as \`sh ${TRIM_PATH} lint -- ${c}\`: it shows each problem and the exit code, and saves the full output to a file it names.`,
  install: (c) => `Run \`${c}\` as \`sh ${TRIM_PATH} install -- ${c}\`: it shows warnings, errors and the exit code, and saves the full output to a file it names.`,
  git: (c) => `\`${c}\` here prints a lot. Narrow it first (\`--stat\`, a path, \`-n 20\`, or \`--oneline\`) and only then read the part you need.`,
};

/** The plain command to wrap, from a real run: without "cd x &&", env settings, or a pipe to head or tail. */
export function plainCommand(example: string): string {
  return example.replace(/^\/bin\/(ba|z)?sh\s+-l?c\s+/, "").replace(/^["']|["']$/g, "").replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "")
    .replace(/\s*(2>&1\s*)?\|\s*(head|tail)\b.*$/, "").replace(/\s+2>&1\s*$/, "").trim();
}

/** A command counts when it ran at least twice and showed more than this many tokens a run, on average. */
export const TRIM_MIN_AVG = 1500;

/** Proposals for the commands in a repo's sessions that waste the most output tokens. */
export function trimProposals(repo: string, sessions: Session[], rows: WasteRow[] = wasteIndex(sessions)): NewProposal[] {
  const out: NewProposal[] = [];
  for (const r of rows) {
    if (r.kind !== "command" || r.runs < 2 || r.avgTokens < TRIM_MIN_AVG) continue;
    const family = familyOf(r.key);
    if (!family) continue;
    const cmd = plainCommand(r.example);
    if (!cmd || cmd.includes("\n") || cmd.length > 120) continue;
    const cases = family === "git" ? [] : checkTrim(family, stressSamples(family));
    if (cases.some((c) => !c.ok)) continue;
    const money = r.costUsd != null ? `, about $${r.costUsd.toFixed(2)} counting the cached re-reads on later turns` : "";
    const used = r.judged >= 2 && r.used != null ? ` The agent went on to use something from it ${r.used} of ${r.judged} time(s) muninn could judge.` : "";
    const lesson = LESSON[family](cmd);
    out.push({
      repo_id: repo, kind: "trim", key: `trim:${r.key}`,
      title: family === "git" ? `Narrow \`${cmd}\` before reading it` : `Show agents only what matters from \`${cmd}\``,
      why: `\`${cmd}\` ran ${r.runs} times in ${r.sessions} session(s) and showed agents about ${Math.round(r.tokens / 1000)}k tokens of output${money}.${r.repeated ? ` ${r.repeated} run(s) mostly repeated an earlier run's output.` : ""}${used}` +
        (family === "git" ? " Git output can't be cut by pattern without losing what you asked for, so this is a lesson only." : ` Applying writes ${TRIM_PATH}, a short script you can read, and keeps a lesson telling agents to use it. The script passes the exit code through, shows every error, failure and warning line, and keeps the whole output in ${TRIM_OUT} (kept out of git).`),
      payload: { family, cmd, key: r.key, lesson, runs: r.runs, tokens: r.tokens, avgTokens: r.avgTokens, costUsd: r.costUsd, check: cases.map(({ name, ok, inBytes, outBytes }) => ({ name, ok, inBytes, outBytes })) },
      evidence: [{ session: "", tool: r.tools[0] ?? "", ts: r.last, quote: redact(`$ ${r.example}`).slice(0, 240) }],
    });
  }
  return out;
}

registerApplier("trim", (p, root) => {
  if (p.payload.family === "git") return [];
  if (!root) return "Couldn't find this repo's folder on this machine.";
  return [{ file: join(root, TRIM_PATH), after: TRIM_SCRIPT, exclude: { root, path: TRIM_OUT } }];
});
/** Applying keeps the lesson that tells agents to use the script; undoing retires it. */
registerAfter("trim", {
  applied: async (db: Client, p) => {
    const id = await createLesson(db, { repo_id: p.repo_id, text: String(p.payload.lesson), source: "inferred", signal: "big_output", suggestedScope: "repo", status: "live", by: "trim", reviewed: true });
    await decide(db, id, { alwaysOn: true });
    await syncLessonFiles(db);
    return { lesson: id };
  },
  undone: async (db: Client, _p, extra) => { if (extra?.lesson) { await decide(db, String(extra.lesson), { status: "retired" }); await syncLessonFiles(db); } },
});
