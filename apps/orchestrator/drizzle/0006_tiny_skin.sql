ALTER TABLE "nodes" ADD COLUMN "env_ref" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pool" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_env_ref_secrets_id_fk" FOREIGN KEY ("env_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;
