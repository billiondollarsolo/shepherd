CREATE TABLE IF NOT EXISTS "project_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"target_host" text DEFAULT '127.0.0.1' NOT NULL,
	"target_port" integer NOT NULL,
	"protocol" text DEFAULT 'http' NOT NULL,
	"label" text NOT NULL,
	"auto_forward" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_services_target_port_check" CHECK ("target_port" BETWEEN 1024 AND 65535),
	CONSTRAINT "project_services_target_host_check" CHECK ("target_host" IN ('127.0.0.1', '::1')),
	CONSTRAINT "project_services_protocol_check" CHECK ("protocol" IN ('http', 'https'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_services" ADD CONSTRAINT "project_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_services_project_id_idx" ON "project_services" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_services_project_port_protocol_uq" ON "project_services" USING btree ("project_id","target_host","target_port","protocol");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preview_runtime_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_ttl_ms" integer DEFAULT 7200000 NOT NULL,
	"auto_forward_policy" text DEFAULT 'off' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_runtime_settings_ttl_check" CHECK ("default_ttl_ms" >= 60000),
	CONSTRAINT "preview_runtime_settings_policy_check" CHECK ("auto_forward_policy" IN ('off', 'remembered_on_access'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preview_runtime_settings" ADD CONSTRAINT "preview_runtime_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
