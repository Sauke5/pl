CREATE TABLE "platform_directory_state" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"cursor" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	CONSTRAINT "platform_directory_singleton" CHECK ("platform_directory_state"."id" = 'directory'),
	CONSTRAINT "platform_directory_revision_valid" CHECK ("platform_directory_state"."revision" >= 0),
	CONSTRAINT "platform_directory_validity_valid" CHECK ("platform_directory_state"."valid_until" >= "platform_directory_state"."observed_at")
);
--> statement-breakpoint
ALTER TABLE "platform_department" ALTER COLUMN "revision" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "platform_user_identity" ALTER COLUMN "revision" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "platform_department" ADD COLUMN "active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_department" ADD COLUMN "head_subjects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_identity" ADD COLUMN "head_department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;