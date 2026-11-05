CREATE TABLE "doska_gateway_nonce" (
	"audience" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "doska_gateway_nonce_unique" UNIQUE("audience","nonce")
);
--> statement-breakpoint
CREATE INDEX "doska_gateway_nonce_expiry_idx" ON "doska_gateway_nonce" USING btree ("expires_at");