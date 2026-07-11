CREATE TABLE "project_pens" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_pens_user_id_project_id_pk" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "project_pens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
	CONSTRAINT "project_pens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade
);
