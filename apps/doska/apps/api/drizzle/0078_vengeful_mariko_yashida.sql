CREATE TABLE "doska_task_import" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"digest" text NOT NULL,
	"task_ids" jsonb NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_task_import_request_unique" UNIQUE("actor_id","project_id","client_request_id")
);
--> statement-breakpoint
ALTER TABLE "doska_task_import" ADD CONSTRAINT "doska_task_import_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_task_import" ADD CONSTRAINT "doska_task_import_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doska_task_import_digest_idx" ON "doska_task_import" USING btree ("actor_id","project_id","digest");