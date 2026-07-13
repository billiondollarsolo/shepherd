-- Shepherd is a single-owner greenfield product. Every session must have an owner;
-- WebSocket authorization therefore never needs a permissive null-owner fallback.
-- Repair historical rows to the oldest installation user, then remove truly orphaned
-- rows from installations that never completed owner setup.
UPDATE "agent_sessions"
SET "created_by" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1)
WHERE "created_by" IS NULL
  AND EXISTS (SELECT 1 FROM "users");
--> statement-breakpoint
DELETE FROM "agent_sessions" WHERE "created_by" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "created_by" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_created_by_users_id_fk"
FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
ON DELETE restrict ON UPDATE no action;
