CREATE TABLE "task_coexecutor" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "task_coexecutor_task_user_unique" UNIQUE("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "due_date_has_time" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_coexecutor" ADD CONSTRAINT "task_coexecutor_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_coexecutor" ADD CONSTRAINT "task_coexecutor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_coexecutor_user_idx" ON "task_coexecutor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_project_archive_idx" ON "task" USING btree ("project_id","archived_at");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_revision_valid" CHECK ("task"."revision" >= 0);