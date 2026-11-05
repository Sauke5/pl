CREATE TABLE "platform_department_head" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "platform_department_head_department_user_unique" UNIQUE("department_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "platform_department" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	CONSTRAINT "platform_department_revision_valid" CHECK ("platform_department"."revision" >= 0),
	CONSTRAINT "platform_department_validity_valid" CHECK ("platform_department"."valid_until" >= "platform_department"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "platform_user_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"primary_department_id" text,
	"active" boolean NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp NOT NULL,
	"valid_until" timestamp NOT NULL,
	CONSTRAINT "platform_user_identity_subject_unique" UNIQUE("subject"),
	CONSTRAINT "platform_user_identity_revision_valid" CHECK ("platform_user_identity"."revision" >= 0),
	CONSTRAINT "platform_user_identity_validity_valid" CHECK ("platform_user_identity"."valid_until" >= "platform_user_identity"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "project_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"invitee_user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "project_invitation_role_valid" CHECK ("project_invitation"."role" IN ('participant', 'observer')),
	CONSTRAINT "project_invitation_status_valid" CHECK ("project_invitation"."status" IN ('pending', 'accepted', 'declined', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "project_join_request" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"applicant_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "project_join_request_status_valid" CHECK ("project_join_request"."status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "project_member_project_user_unique" UNIQUE("project_id","user_id"),
	CONSTRAINT "project_member_role_valid" CHECK ("project_member"."role" IN ('participant', 'observer'))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "visibility" text;--> statement-breakpoint
ALTER TABLE "platform_department_head" ADD CONSTRAINT "platform_department_head_department_id_platform_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."platform_department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_department_head" ADD CONSTRAINT "platform_department_head_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_identity" ADD CONSTRAINT "platform_user_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_identity" ADD CONSTRAINT "platform_user_identity_primary_department_id_platform_department_id_fk" FOREIGN KEY ("primary_department_id") REFERENCES "public"."platform_department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_invitee_user_id_user_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_request" ADD CONSTRAINT "project_join_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_request" ADD CONSTRAINT "project_join_request_applicant_user_id_user_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_join_request" ADD CONSTRAINT "project_join_request_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_department_head_user_idx" ON "platform_department_head" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_user_identity_department_idx" ON "platform_user_identity" USING btree ("primary_department_id");--> statement-breakpoint
CREATE INDEX "project_audit_project_created_idx" ON "project_audit" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_audit_actor_created_idx" ON "project_audit" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitation_pending_unique" ON "project_invitation" USING btree ("project_id","invitee_user_id") WHERE "project_invitation"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "project_invitation_invitee_idx" ON "project_invitation" USING btree ("invitee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_join_request_pending_unique" ON "project_join_request" USING btree ("project_id","applicant_user_id") WHERE "project_join_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "project_join_request_applicant_idx" ON "project_join_request" USING btree ("applicant_user_id");--> statement-breakpoint
CREATE INDEX "project_member_user_idx" ON "project_member" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_department_id_platform_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."platform_department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_department_id_idx" ON "project" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "project_owner_user_id_idx" ON "project" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_visibility_valid" CHECK ("project"."visibility" IN ('department', 'private'));