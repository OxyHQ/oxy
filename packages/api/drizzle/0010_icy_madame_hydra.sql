-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "federation_key_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_key_pairs_key_id_key" UNIQUE("key_id")
);
