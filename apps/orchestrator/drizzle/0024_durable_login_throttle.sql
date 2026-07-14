CREATE TABLE IF NOT EXISTS "auth_login_throttle" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_login_throttle_last_seen_idx" ON "auth_login_throttle" USING btree ("last_seen_at");
