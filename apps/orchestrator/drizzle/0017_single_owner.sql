DO $$
DECLARE
  owner_id uuid;
BEGIN
  SELECT id INTO owner_id
  FROM users
  ORDER BY (role = 'admin') DESC, created_at ASC, id ASC
  LIMIT 1;

  IF owner_id IS NOT NULL THEN
    UPDATE agent_sessions SET created_by = owner_id WHERE created_by <> owner_id;
    UPDATE nodes SET created_by = owner_id WHERE created_by IS NOT NULL AND created_by <> owner_id;
    DELETE FROM project_pens WHERE user_id <> owner_id;
    DELETE FROM users WHERE id <> owner_id;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "installation_owner" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_installation_owner_unique" UNIQUE("installation_owner");
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
