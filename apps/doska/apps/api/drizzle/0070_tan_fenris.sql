ALTER TABLE "task" ADD COLUMN "parent_task_id" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_parent_idx" ON "task" USING btree ("parent_task_id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_not_self" CHECK ("task"."parent_task_id" IS NULL OR "task"."parent_task_id" <> "task"."id");