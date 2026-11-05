CREATE TABLE "doska_user_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"start_page" text DEFAULT 'my-tasks' NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_user_preference_start_page_valid" CHECK ("doska_user_preference"."start_page" IN ('my-tasks', 'projects', 'search', 'invitations', 'management'))
);
--> statement-breakpoint
ALTER TABLE "doska_user_preference" ADD CONSTRAINT "doska_user_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;