-- oxy:deploy-phase=pre
-- Validates the foreign key 0262 added NOT VALID. VALIDATE takes only a SHARE
-- UPDATE EXCLUSIVE lock on `content_claims` and a ROW SHARE lock on
-- `applications`, so it blocks neither reads nor writes on either.
ALTER TABLE "content_claims" VALIDATE CONSTRAINT "content_claims_referred_by_application_id_applications_id_fk";
