# muninn panel for Claude Code

A side panel in Claude Code that shows what secondnature told this session, and why. On top, the one thing to do now: a command looping in this session (and, when a lesson you kept fits it but this session never got it, a "Tell the agent now" button that sends it with your next message), a kept problem that came back, or a new lesson to keep. Below: each thing told this session with why and Helped / Wrong, where you left off on this branch, how many new lessons wait, and the week in a sentence. The "Speaks up to this session" picker sets how often it speaks up. The status line shows how many things were told.

Install it from a terminal, after installing secondnature (`npm install -g secondnature`):

```sh
claude plugin marketplace add Rohitp/secondnature
claude plugin install muninn-panel@muninn
```

Then start a new Claude Code session and open the panel with `/muninn`.

From a local checkout instead: `claude plugin marketplace add <path to the checkout>`, then the same install line.

Needs the `muninn` command on the PATH Claude Code starts with: `npm install -g secondnature` puts it there, or `npm link` in a checkout.

Changing the panel: Claude Code runs an installed copy, not this folder. Bump `version` in `.claude-plugin/plugin.json`, then run `claude plugin marketplace update muninn` and `claude plugin update muninn-panel@muninn`, and start a new session.
