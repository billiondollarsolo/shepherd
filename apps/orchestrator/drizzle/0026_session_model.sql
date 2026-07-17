ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model text;
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS reasoning_effort text;
