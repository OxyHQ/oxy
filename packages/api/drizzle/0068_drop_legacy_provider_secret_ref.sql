-- oxy:deploy-phase=post
--
-- Remove the final Oxy-side locator from the provider-credential schema after
-- the Kaana-custody image is fully live. Migration 0067 refuses to run when the
-- legacy inventory is non-empty; new writes leave this compatibility column
-- NULL. Repeat that safety condition here so a stale task or manual write cannot
-- turn the post-deploy cleanup into silent loss of the only locator for an
-- external secret.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "inference_provider_connections"
		WHERE "secret_ref" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'refusing to drop secret_ref while a legacy provider credential locator remains; import/revoke it and retry';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_key";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_format";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_secret_ref_partition";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" DROP COLUMN "secret_ref";
