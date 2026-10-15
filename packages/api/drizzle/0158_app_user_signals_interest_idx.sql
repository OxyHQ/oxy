-- oxy:deploy-phase=pre
-- Additive: one index on `app_user_signals` (~80k rows), which the image
-- before this one simply does not read. The recommendation scorer takes an
-- application's top interest scores off it instead of scanning and sorting
-- every row the application has.
CREATE INDEX "app_user_signals_application_id_interest_score_user_id_idx" ON "app_user_signals" USING btree ("application_id","interest_score" DESC NULLS LAST,"user_id");