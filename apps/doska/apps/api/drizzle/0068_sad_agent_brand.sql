ALTER TABLE "column" ADD COLUMN "semantic_state" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "column" ADD CONSTRAINT "column_semantic_state_valid" CHECK ("column"."semantic_state" IN ('planned', 'active', 'completed'));--> statement-breakpoint
ALTER TABLE "column" ADD CONSTRAINT "column_semantic_completion_valid" CHECK ("column"."semantic_state" IS NULL OR (("column"."semantic_state" = 'completed') = "column"."is_final"));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_revision_valid" CHECK ("project"."revision" >= 0);