CREATE TABLE "doska_attachment_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"project_id" text,
	"actor_id" text,
	"session_binding" text NOT NULL,
	"client_request_id" text NOT NULL,
	"filename" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"receiving_until" timestamp,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_attachment_upload_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "doska_attachment_request_unique" UNIQUE("actor_id","session_binding","client_request_id"),
	CONSTRAINT "doska_attachment_state_check" CHECK ("doska_attachment_upload"."state" IN ('reserved','receiving','uploaded','ready','deleting')),
	CONSTRAINT "doska_attachment_size_check" CHECK ("doska_attachment_upload"."size" > 0 AND "doska_attachment_upload"."size" <= 26214400),
	CONSTRAINT "doska_attachment_sha_check" CHECK ("doska_attachment_upload"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "doska_attachment_binding_check" CHECK ("doska_attachment_upload"."session_binding" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "doska_attachment_object_check" CHECK ("doska_attachment_upload"."state" NOT IN ('receiving','uploaded','ready') OR "doska_attachment_upload"."object_key" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "doska_attachment_upload" ADD CONSTRAINT "doska_attachment_upload_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_attachment_upload" ADD CONSTRAINT "doska_attachment_upload_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_attachment_upload" ADD CONSTRAINT "doska_attachment_upload_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doska_attachment_task_idx" ON "doska_attachment_upload" USING btree ("task_id","state");--> statement-breakpoint
CREATE INDEX "doska_attachment_cleanup_idx" ON "doska_attachment_upload" USING btree ("state","expires_at");