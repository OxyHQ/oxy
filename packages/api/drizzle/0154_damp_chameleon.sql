-- oxy:deploy-phase=post
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_plan_checkout_intents_subject_account_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_plan_checkout_intents_subject_account_id_users_id_fk" FOREIGN KEY ("subject_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;