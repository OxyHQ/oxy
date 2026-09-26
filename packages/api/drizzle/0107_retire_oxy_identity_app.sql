-- oxy:deploy-phase=post
-- The web identity carrier moved from id.oxy.so into auth.oxy.so (ADR 0028), and
-- the "Oxy Identity" application registered id.oxy.so as a trusted first-party
-- origin. Deleting it takes that origin out of the trusted CORS set; everything
-- that references the row cascades. Post-deploy: the image that no longer opens
-- id.oxy.so is already serving.
DELETE FROM "applications" WHERE "name" = 'Oxy Identity' AND 'https://id.oxy.so' = ANY("redirect_uris");
