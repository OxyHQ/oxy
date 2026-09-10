-- oxy:deploy-phase=pre
-- Align the existing fixed Clarity application row with its reviewed native
-- product manifest. This is an idempotent data migration, not a runtime CORS
-- exception: after it runs, the application registry remains the authority.
UPDATE "applications"
SET
	"website_url" = 'https://clarity.surf',
	"redirect_uris" = CASE
		WHEN 'https://clarity.surf' = ANY("redirect_uris") THEN "redirect_uris"
		ELSE array_append("redirect_uris", 'https://clarity.surf')
	END,
	"updated_at" = date_trunc('milliseconds', now())
WHERE "id" = '01a0646a-2382-74a3-a795-788924d55722'
	AND (
		"website_url" IS DISTINCT FROM 'https://clarity.surf'
		OR NOT ('https://clarity.surf' = ANY("redirect_uris"))
	);
