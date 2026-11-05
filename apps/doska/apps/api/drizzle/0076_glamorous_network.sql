ALTER TABLE "custom_field_definition" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "required_task_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;