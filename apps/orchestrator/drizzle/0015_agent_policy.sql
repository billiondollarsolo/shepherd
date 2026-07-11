ALTER TABLE "projects" ADD COLUMN "agent_policy" jsonb DEFAULT '{"defaultAuthority":"callback_only","maxAuthority":"manage","maxConcurrentAgents":12,"spawnRateLimitPerMinute":10,"maxSendBytes":16384,"maxReadMessages":100}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "orchestration_authority" text DEFAULT 'callback_only' NOT NULL;
