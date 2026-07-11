ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "pinned";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "reviewed_at";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "reviewed_by";
