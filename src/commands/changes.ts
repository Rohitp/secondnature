import { openDb } from "../store/db.js";
import { repoIdentity } from "../repo/identity.js";
import { pickRunner, saveUsage } from "../learn/writer.js";
import { apply, dismiss, listProposals, proposeInstructions, undo, type Proposal } from "../propose/index.js";

const KIND: Record<string, string> = { guard: "Ask-first rule", skill: "New skill", instruction: "Instruction edit", trim: "Output trim" };
/** What a change will write, short enough for a terminal. */
export function preview(p: Proposal): string {
  if (p.kind === "guard") return `adds "${p.payload.rule}" to permissions.${p.payload.list} in .claude/settings.local.json`;
  if (p.kind === "skill") return String(p.payload.markdown).split("\n").slice(0, 12).join("\n");
  if (p.kind === "trim") return `${p.payload.family === "git" ? "" : "writes .muninn/bin/trim and "}keeps the lesson: ${p.payload.lesson}`;
  const e = p.payload;
  return [e.find ? `- ${String(e.find).split("\n").join("\n- ")}` : "", e.text ? `+ ${String(e.text).split("\n").join("\n+ ")}` : ""].filter(Boolean).join("\n");
}

/**
 * muninn changes                 Changes waiting for you: ask-first rules, skills, instruction edits
 * muninn changes check           Ask your Claude to review this repo's CLAUDE.md, AGENTS.md and skills
 * muninn changes apply <id> | dismiss <id> | undo <id>
 */
export async function changes(args: string[]) {
  const db = await openDb();
  const repo = repoIdentity(process.cwd());
  const [sub, id] = args;
  const byId = async (prefix: string | undefined) => {
    const all = await listProposals(db, null, "all");
    const hits = all.filter((p) => prefix && p.id.startsWith(prefix));
    if (hits.length !== 1) throw new Error(hits.length ? "That id matches more than one change; type more of it." : "No change with that id. Run \"muninn changes\" to see them.");
    return hits[0]!;
  };
  if (sub === "apply") { const p = await byId(id); const r = await apply(db, p.id); console.log(`Applied: ${p.title}. Changed ${r.files.join(", ")}. Undo with "muninn changes undo ${p.id.slice(0, 8)}".`); return; }
  if (sub === "dismiss") { const p = await byId(id); await dismiss(db, p.id); console.log(`Dismissed: ${p.title}. muninn won't propose it again.`); return; }
  if (sub === "undo") { const p = await byId(id); await undo(db, p.id); console.log(`Undone: ${p.title}. The file is back as it was, and the change is waiting again.`); return; }
  if (sub === "check") {
    if (!repo) throw new Error("Run this inside a git repo.");
    const runner = pickRunner("judge");
    if (!runner) throw new Error("This needs the claude (or codex) command, which muninn couldn't find.");
    console.log("Asking your Claude to review this repo's CLAUDE.md, AGENTS.md and skills against your sessions…");
    const r = await proposeInstructions(db, repo, runner);
    await saveUsage(db, runner, "instruction review");
    console.log(r.proposed ? `${r.proposed} edit(s) proposed.` : r.checked ? "Its suggestions didn't fit the files as they are, or were proposed before." : "Nothing clearly worth changing.");
  } else if (sub) throw new Error("Usage: muninn changes [check | apply <id> | dismiss <id> | undo <id>]");
  const waiting = await listProposals(db, repo, "proposed");
  if (!waiting.length) { console.log("No changes waiting. muninn proposes them as it reads your sessions; \"muninn changes check\" reviews your instruction files now."); return; }
  for (const p of waiting) console.log(`\n[${p.id.slice(0, 8)}] ${KIND[p.kind]}: ${p.title}\n  ${p.why}\n  ${preview(p).split("\n").join("\n  ")}`);
  console.log('\nApply with "muninn changes apply <id>", or dismiss. muninn ui shows them too.');
}
