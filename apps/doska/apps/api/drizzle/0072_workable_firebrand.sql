CREATE TABLE "doska_template_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doska_template_selection" (
	"task_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "doska_template_selection_revision_valid" CHECK ("doska_template_selection"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "doska_template_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_template_snapshot_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "doska_template_snapshot_version_valid" CHECK ("doska_template_snapshot"."version" >= 1 AND "doska_template_snapshot"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "doska_template" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"department_id" text NOT NULL,
	"source_project_id" text,
	"name" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_template_visibility_valid" CHECK ("doska_template"."visibility" IN ('private','department','company')),
	CONSTRAINT "doska_template_revision_valid" CHECK ("doska_template"."revision" >= 0 AND "doska_template"."snapshot_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "doska_template_selection" ADD CONSTRAINT "doska_template_selection_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template_selection" ADD CONSTRAINT "doska_template_selection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template_snapshot" ADD CONSTRAINT "doska_template_snapshot_template_id_doska_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."doska_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template_snapshot" ADD CONSTRAINT "doska_template_snapshot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template" ADD CONSTRAINT "doska_template_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template" ADD CONSTRAINT "doska_template_department_id_platform_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."platform_department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_template" ADD CONSTRAINT "doska_template_source_project_id_project_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doska_template_audit_template_idx" ON "doska_template_audit" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE INDEX "doska_template_selection_project_idx" ON "doska_template_selection" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doska_template_owner_idx" ON "doska_template" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "doska_template_audience_idx" ON "doska_template" USING btree ("visibility","department_id");