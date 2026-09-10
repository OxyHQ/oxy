-- oxy:deploy-phase=pre
-- Remove bearer-shaped query parameters from legacy application icons without
-- logging, decoding or otherwise inspecting their values. The path, fragment,
-- safe parameters, their byte representation and their order are preserved.
WITH "icon_source" AS (
	SELECT
		"id",
		CASE
			WHEN strpos("icon", '#') > 0 THEN left("icon", strpos("icon", '#') - 1)
			ELSE "icon"
		END AS "before_fragment",
		CASE
			WHEN strpos("icon", '#') > 0 THEN substr("icon", strpos("icon", '#'))
			ELSE ''
		END AS "fragment"
	FROM "applications"
	WHERE "icon" IS NOT NULL
),
"icon_query" AS (
	SELECT
		"id",
		split_part("before_fragment", '?', 1) AS "path",
		substr("before_fragment", strpos("before_fragment", '?') + 1) AS "query",
		"fragment"
	FROM "icon_source"
	WHERE strpos("before_fragment", '?') > 0
),
"filtered_query" AS (
	SELECT
		"icon_query"."id",
		"icon_query"."path",
		"icon_query"."fragment",
		string_agg("part"."value", '&' ORDER BY "part"."ordinality") FILTER (
			WHERE lower(split_part("part"."value", '=', 1)) NOT IN (
				'token',
				'access_token',
				'authorization'
			)
		) AS "safe_query",
		bool_or(
			lower(split_part("part"."value", '=', 1)) IN (
				'token',
				'access_token',
				'authorization'
			)
		) AS "contains_sensitive_parameter"
	FROM "icon_query"
	CROSS JOIN LATERAL unnest(string_to_array("icon_query"."query", '&'))
		WITH ORDINALITY AS "part"("value", "ordinality")
	GROUP BY "icon_query"."id", "icon_query"."path", "icon_query"."fragment"
)
UPDATE "applications" AS "application"
SET "icon" =
	"filtered_query"."path"
	|| CASE
		WHEN "filtered_query"."safe_query" IS NULL THEN ''
		ELSE '?' || "filtered_query"."safe_query"
	END
	|| "filtered_query"."fragment"
FROM "filtered_query"
WHERE "application"."id" = "filtered_query"."id"
	AND "filtered_query"."contains_sensitive_parameter";
