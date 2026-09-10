-- oxy:deploy-phase=post
-- Remove legacy Oxy secret references and all secret-derived metadata only after the new runtime is stable.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "inference_provider_connections"
		WHERE "secret_ref" IS NOT NULL
			OR "key_prefix" IS NOT NULL
			OR "fingerprint" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'legacy provider credential rows must be revoked/migrated before Kaana-only custody cleanup';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_key";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_format";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_partition";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_key_prefix_length";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_fingerprint_format";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP COLUMN "secret_ref";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP COLUMN "key_prefix";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP COLUMN "fingerprint";
