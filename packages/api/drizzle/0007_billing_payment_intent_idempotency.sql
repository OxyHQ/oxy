-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE UNIQUE INDEX "billing_transactions_payment_intent_key" ON "billing_transactions" USING btree ("stripe_payment_intent_id","type") WHERE "billing_transactions"."type" = 'credit_purchase' and "billing_transactions"."stripe_payment_intent_id" is not null;