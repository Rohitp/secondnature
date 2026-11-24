-- "Working now" notes: one plain sentence per agent, written by the agents themselves through the plan_note tool,
-- so the engineer can see what each running session or subagent is doing without asking. Each agent's newest note
-- replaces its older one; notes go out of view after a day.
CREATE TABLE plan_notes (repo_id TEXT NOT NULL, branch TEXT NOT NULL, who TEXT NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo_id, branch, who));
