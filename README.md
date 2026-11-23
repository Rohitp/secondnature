# secondnature

**Your coding agents forget everything between sessions. Teach them once, and it becomes second nature.**

secondnature reads your past Claude Code, Codex, Cursor and Antigravity sessions, notices what you keep teaching your agents, and tells them at the right moment, so you stop repeating yourself.

Inside, it goes by its code name, **muninn**, and so does its command: `muninn` is short to type, and `secondnature` works too.

> In Norse myth, Muninn ("memory") is one of Odin's two ravens. Each day it flies out over the world and comes back to tell him what it saw.

## What it does

You tell an agent the same things over and over: "explain it step by step", "the benchmarks folder is at the repo root", "use `poetry run python`, not bare `python`". Next session, it's forgotten. muninn fixes that in three steps:

1. **It learns from your sessions.** After you work, muninn looks through the session logs on your machine for:
   - rules you state, even once ("from now on…", "let's put every feature on a branch"), marked "said once" until they come up again
   - things you said more than once
   - corrections you made to an agent
   - commands that failed and were then fixed
   - paths agents keep looking for in the wrong place, matched to where the file really is
   - long answers you keep skimming or stopping (measured from how fast you reply, never applied without you)
   - long explanations you gave

   Your own Claude (or Codex) turns each one into a short lesson.
2. **You decide what's kept.** Lessons arrive as suggestions. Nothing reaches an agent until you add it.
3. **It keeps your sessions searchable.** Every exchange is stored, redacted, so "how did we fix the webhook last month?" has an answer, for you (`muninn recall`) and for your agents, who are told they can look.
4. **It tells your agents when it matters.** At the start of a session, when a word you chose comes up, or when a command fails the way it has before. It also hands the next session a short note of where you left off, and keeps a running plan for each branch you work on (goal, what's open, decisions, what's done) that you can edit and, if you like, keep in the repo as `PLAN.md`.

It also proposes changes to what your agents read, each one waiting for you to apply or dismiss, and undoable:

- **Ask-first rules.** A command you keep stopping before it runs (say `git push --force`) becomes a rule that makes Claude Code ask you first, in every mode including auto mode. It's saved in the repo's `.claude/settings.local.json`, on this machine only.
- **Skills.** The same steps run in the same order across sessions become a drafted Claude Code skill, so the agent follows them in one go.
- **Edits to CLAUDE.md, AGENTS.md and skills.** On request, your Claude reviews those files against your sessions and proposes a few exact edits.
- **Output trims.** A test, build, lint or install command that keeps showing agents far more output than they need becomes a short script, `.muninn/bin/trim`, and a lesson to run the command through it. The script passes the exit code through, shows every error, failure and warning line and the last lines, shows short output whole, and keeps the full output in `.muninn/out/`. muninn checks the script against those rules before proposing it. For git output it proposes a lesson only.

## Proof that it helped

- **Where tokens go.** `muninn insights` lists the commands and file reads that showed agents the most output: runs, tokens, repeats, whether the agent used it, and an estimated cost that counts the prompt cache re-reading it on every later turn.
- **What each fix saved.** `muninn report` compares an applied trim's output per run before and after, in tokens and money, and says when agents skip it or keep opening the full output anyway.
- **Which lessons worked.** `muninn report` opens with one line ("12 kept. 9 worked. 2 came back. 1 too early to tell."), counts a lesson as worked only after 3 sessions since it was kept, and flags stale lessons: ones naming a file or script that's gone, or that agents were told and the problem came back anyway. `muninn report --page` writes the same as one HTML page to send someone, with its method and its misses.

## Lessons for your team

`muninn share` puts a repo's kept lessons in the repo, so they're reviewed in pull requests like code: `.muninn/lessons.md`, plus the same short list in CLAUDE.md, AGENTS.md, `.github/copilot-instructions.md`, a Cursor rule and an Antigravity rule. A teammate's agents read them from those files; a teammate who uses muninn gets them kept and measured with `muninn share pull` (or the next `muninn learn`).

## Teams of agents and long autonomous runs

muninn learns from work you don't steer, too: Claude Code subagents, Claude Code agent teams, and Antigravity agent swarms (a builder, a reviewer, a checker and qa, each in its own worktree, posting to a shared board).

- **Runs.** Sessions, subagents and worktrees that worked together become one workflow run, each part with a role. A run records, per role, the time, tokens and estimated cost at list price, the commands and failures, and every handoff between roles: approvals, work sent back, and fixes made after approval. `muninn runs` shows them, and the page shows findings your Claude writes about each run.
- **Agents correcting agents.** When a reviewer sends a builder's work back, or the builder fixes something after it was approved, that becomes a suggested lesson for the role that missed it: the builder ("check edge cases before marking a milestone done"), and the reviewers that approved it ("test malformed input before approving").
- **Lessons per role.** A role's lesson is told only to that role: a Claude Code subagent by its type, an agent by the worktree it works in.
- **Did it work?** For each role lesson, muninn compares the runs before it was kept with the runs since, and says whether the role's problems went down, or whether the lesson never reached it. `muninn report` shows it.

And two things for you rather than your agents: `muninn pr` writes the "why" for a branch's pull request (what was tried, what was decided, how to test) from your sessions, and `muninn insights` shows your week: where agents wasted effort, and whether lessons helped.

## Ask it about your work

Ask muninn a question about your own work and it answers from everything it keeps: kept lessons, the decisions and finished work in your branch plans, and your past sessions. It cites each source with its date, and you can ask follow-ups.

- **On the page:** the Ask muninn box at the top.
- **In any chat with Claude:** run `muninn mcp install` once. It adds muninn's MCP server (the standard way chat apps call outside tools) to Claude Code, the Claude desktop app, Antigravity, and Cursor and Codex where they're installed. Then ask, in a normal chat:
  - "what did we decide about the npm name?" or "how did we fix the webhook last time?" (searches everything)
  - "where did the last session on this branch leave off?"
  - "how did the agent swarm do today?" (runs, roles, cost, and whether role lessons worked)
  - "what does muninn tell agents in this repo?" (kept lessons and waiting suggestions, with why)

  Claude can also suggest a lesson when you say "remember that…", and keep or dismiss a waiting suggestion when you ask it to by name; it quotes your request, and you can change it on the page. For another app, `muninn mcp install` prints the command to add.

## What it looks like

`muninn ui` opens one page in your browser, **"What your agents know"**:

- **Suggested from your sessions:** add a suggestion, or dismiss it.
- **Your lessons:** an on/off switch each. Off means agents aren't told it.
- **Settings:** whether muninn speaks up only when a session starts, or mid-task too.

In Claude Code, a side panel shows what muninn told your agent in this session, and why. `muninn setup` adds it; open it in a new session with `/muninn`. To add it by hand from GitHub instead:

```sh
claude plugin marketplace add Rohitp/secondnature
claude plugin install muninn-panel@muninn
```

## How agents are told

| Tool | How |
|---|---|
| Claude Code (terminal and desktop app) | Hooks: session start, your prompt, failed commands, subagents (each told its role's lessons). Agent-team hooks record which teammate did which task |
| Codex | The same hooks, in `~/.codex/hooks.json`. Built from Codex's documentation, not yet tested live |
| Cursor | Rules files in `.cursor/rules/`, turned on by themselves once you use Cursor in a repo |
| Antigravity | Rules files in `.agents/rules/`, turned on by themselves once you use Antigravity in a repo, and written into each agent's worktree with that role's lessons. Hooks in `~/.gemini/config/hooks.json` warn an agent mid-run when a command keeps failing the same way, and pass on keyword lessons. Its sessions, and its swarms' board messages, are read from its plain-text transcripts |
| Claude Code, without hooks | Optional, per repo: always-on lessons in `CLAUDE.local.md`, for this machine only and ignored by git (`muninn local-file on`, or the switch on the page) |
| Any agent | `muninn ask "how do the benchmarks run?"` searches what you've kept |

## Privacy

- Everything stays on your machine, in `~/.muninn`.
- To write lessons, muninn sends **redacted** excerpts of your sessions to **your own** Claude Code (or Codex) login. It has no server, and makes no other network calls apart from a one-time download of a small local model (about 33 MB) used to compare text.
- It reads session logs only. It never reads your code unless a session quoted it.
- It keeps your sessions so you and your agents can search them (`muninn recall`): each exchange, redacted, with a vector from the local model, in `~/.muninn/muninn.db`. It also keeps a compressed copy of each Claude Code and Codex log in `~/.muninn/archive`, because Claude Code deletes its own logs after 30 days.
- Wrap anything you type in `<private>…</private>` and it's never stored, learned from or summarised. `muninn ignore-repo` leaves a whole repo alone, and `muninn purge --yes` deletes everything muninn keeps.

## Install

One command sets it up. It finds your coding tools, reads your past sessions, and shows you what you've been teaching your agents. About 3 minutes.

**One command** (recommended): downloads, installs and sets up in one go.

```sh
npx secondnature setup
```

Afterwards the command is `muninn`. Run it with nothing after it to see what needs you.

**Install, then set up**: installs the command first, so you can run it any time.

```sh
npm install -g secondnature
muninn setup
```

`secondnature` and `muninn` are the same command. Use whichever you like.

**From source**, for contributors. Needs git and pnpm (`corepack enable` sets it up).

```sh
git clone https://github.com/Rohitp/secondnature.git && cd secondnature
corepack enable && pnpm install && pnpm build
npm link && muninn setup
```

`npm link` puts the `muninn` command on your PATH.

**You need**

- A Mac or Linux
- Node 22 or later. Check with `node --version`
- Claude Code (or Codex) signed in, to write lessons

**It works with** Claude Code (in the terminal and the desktop app), Cursor and Antigravity. Codex too, though it isn't checked live yet.

**It stays on your machine.** No account and no server. The only things sent out are redacted excerpts, to your own Claude, to write lessons.

### What setup does

1. **Finds your tools.** You untick any you want left alone: they get no hooks or rules files, and their logs aren't read.
2. **Says what it will do.** What it reads, sends and changes. Nothing happens until you say yes.
3. **Reads your sessions.** A few minutes. You can close the window; it reads them again on its own later.
4. **Shows what you've taught.** The review page opens. Keep what's useful, one click each.

After that you don't need any commands. secondnature reads new sessions on its own after they end, and on a Mac a background check runs every few hours too (`muninn schedule off` stops it). If something drops off later (a settings file rewritten, a new tool installed), it's put back during the next scan, or run `muninn connect` to check now.

### Changed your mind?

`muninn uninstall` removes the hooks and keeps your lessons; `muninn connect` puts them back. `muninn purge --yes` deletes everything secondnature kept.

## Commands

| Command | What it does |
|---|---|
| `muninn` | What needs you, the week in a sentence, and the everyday commands |
| `muninn setup` | Set everything up and take a first look |
| `muninn connect` | Connect, or re-check, every coding tool on this machine |
| `muninn ui` | Open the page |
| `muninn learn` | Look for new lessons now (also runs on its own); `--verbose` for detail |
| `muninn ask "question"` | An answer from your lessons, plans and past sessions, with sources; `--more` for a follow-up |
| `muninn plan` | Where this branch stands: goal, next steps, decisions |
| `muninn mcp install` | Ask about your work from any chat with Claude |
| `muninn related "what"` | What a decision or piece of work led to, what replaced it, the sessions and commits behind it, the files it changed, and what it changed outside the repo |
| `muninn link` / `unlink "decision" "work"` | Say a decision did, or didn't, lead to some work; muninn keeps your choice |
| `muninn recall "what"` | Search your past sessions: what was asked, said and run (`--all-repos`, `--days 30`) |
| `muninn changes` | Proposed rules, skills and instruction edits; `check` reviews CLAUDE.md now |
| `muninn pr [--apply]` | Write the "why" for this branch's pull request |
| `muninn insights` | Your week with coding agents |
| `muninn runs` | Workflow runs: subagents, agent teams and swarms, with roles, handoffs and cost (`--all` for single sessions too) |
| `muninn report` | Whether kept lessons and output trims worked, including lessons for one role in a team of agents |
| `muninn report --page [file]` | The same as one HTML page to send someone |
| `muninn share` / `share pull` / `share off` | Put this repo's lessons in the repo for your team, in each tool's file |
| `muninn schedule on` / `off` | A macOS background job that checks for lessons every few hours |
| `muninn ignore-repo [name]` | Leave a repo alone: not listed, scanned or told anything (`--undo` to reverse) |
| `muninn status` | Check everything is working |
| `muninn pause` / `resume` | Stop or restart muninn |
| `muninn uninstall` | Remove muninn's hooks. Your lessons are kept |

Run `muninn help` for the full list. Output follows a few rules: the answer comes first, anything you need to do ends with `Next:` and the exact command, every mark (✓ ! ✗ –) comes with words, and `NO_COLOR=1` turns colour off.

## Status

Early, and built for one person's daily use first. It works day to day with Claude Code and with Antigravity agent swarms. Not yet tested live: Codex delivery, and Claude Code agent teams, whose message format in the logs isn't documented (muninn reads it defensively, and relies on the documented team hooks). Cursor's chats are read through an undocumented format. Costs are estimates at Anthropic's list prices; set your own in `~/.muninn/config.json` under `prices` for other models, such as Gemini.

## For contributors

- `docs/designs/muninn.md`: the design
- `docs/design-language.md`: how the interface should look and sound
- `docs/implementation-plan.md`: what's done and what's next
- `docs/devlog.md`: decisions and findings along the way

```sh
pnpm test        # 148 tests
pnpm typecheck
```

To publish a new version, run one command in a terminal on `main`:

```sh
pnpm release patch     # fixes: 0.1.0 → 0.1.1 (minor for new features, or an exact version)
```

It checks the repo is committed and up to date with GitHub, runs the types and tests, builds, and publishes to npm (which asks for your authenticator code). Only once npm accepts it does it commit the version, tag it, push, and create the GitHub release with what changed. If anything fails, nothing is released and the version is left as it was. Add `--dry-run` to see all of it without publishing.

## License

MIT. See [LICENSE](LICENSE).
