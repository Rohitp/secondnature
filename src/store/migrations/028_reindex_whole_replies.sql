-- Sessions are now stored with whole agent replies (up to 8,000 characters, was the first 400 and last 1,200).
-- Clearing indexed_at makes the next learn read every log again; only exchanges whose text changed are re-embedded.
UPDATE session_files SET indexed_at = NULL;
