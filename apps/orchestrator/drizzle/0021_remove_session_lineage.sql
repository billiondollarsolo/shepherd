DROP INDEX IF EXISTS "agent_sessions_parent_session_id_idx";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "parent_session_id";
