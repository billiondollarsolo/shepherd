ALTER TABLE "nodes" ADD COLUMN "agentd_credential_ref" uuid;
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_agentd_credential_ref_secrets_id_fk"
FOREIGN KEY ("agentd_credential_ref") REFERENCES "public"."secrets"("id")
ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "nodes_agentd_credential_ref_idx" ON "nodes" USING btree ("agentd_credential_ref");
