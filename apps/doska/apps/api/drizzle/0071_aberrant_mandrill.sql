CREATE TABLE "doska_checklist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"checklist_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doska_checklist" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "mention_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "doska_checklist_item" ADD CONSTRAINT "doska_checklist_item_checklist_id_doska_checklist_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."doska_checklist"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "doska_checklist" ADD CONSTRAINT "doska_checklist_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "doska_checklist_item_list_idx" ON "doska_checklist_item" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "doska_checklist_task_idx" ON "doska_checklist" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;