CREATE TABLE "agent_capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "installation_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "scopes" text[] NOT NULL,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "agent_capabilities_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_session_id_agent_sessions_id_fk"
FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_project_id_projects_id_fk"
FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_capabilities_session_id_idx" ON "agent_capabilities" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "agent_capabilities_project_id_idx" ON "agent_capabilities" USING btree ("project_id");
