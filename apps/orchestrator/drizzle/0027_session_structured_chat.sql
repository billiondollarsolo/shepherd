ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS structured_chat boolean NOT NULL DEFAULT false;
