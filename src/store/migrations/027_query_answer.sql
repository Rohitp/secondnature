-- The text the agent got back for each question, so the page can show what it asked and what it was told.
-- Older rows have none: the page lists what was found instead (result_ids).
ALTER TABLE agent_queries ADD COLUMN answer TEXT;
