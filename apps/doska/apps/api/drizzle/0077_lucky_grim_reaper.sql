CREATE TABLE "doska_resource_link_state" (
	"task_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doska_resource_link" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"source" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_resource_link_tuple_unique" UNIQUE("task_id","source","object_type","object_id")
);
--> statement-breakpoint
CREATE TABLE "doska_resource_request" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "doska_resource_request_unique" UNIQUE("actor_id","project_id","client_request_id")
);
--> statement-breakpoint
ALTER TABLE "doska_resource_link_state" ADD CONSTRAINT "doska_resource_link_state_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_resource_link" ADD CONSTRAINT "doska_resource_link_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_resource_request" ADD CONSTRAINT "doska_resource_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doska_resource_request" ADD CONSTRAINT "doska_resource_request_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doska_resource_link_ref_idx" ON "doska_resource_link" USING btree ("source","object_type","object_id","id");