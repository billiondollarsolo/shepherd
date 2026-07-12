DO $$
DECLARE
  owner_id uuid;
BEGIN
  SELECT id INTO owner_id
  FROM users
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  IF owner_id IS NOT NULL THEN
    UPDATE nodes SET created_by = owner_id WHERE created_by IS NULL;
  END IF;
END $$;
