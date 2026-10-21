-- oxy:deploy-phase=pre
-- Widening: admits the `community` kind (a federated ActivityPub Group) and lets
-- a community carry categories. Correct against both images. `users` is hot, so
-- the constraints come back NOT VALID (no scan under ACCESS EXCLUSIVE) and are
-- validated in 0195.
ALTER TABLE "users" DROP CONSTRAINT "users_kind_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_account_categories_kind_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('personal', 'organization', 'project', 'bot', 'channel', 'community')) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_categories_kind_check" CHECK ("users"."kind" in ('organization', 'project', 'bot', 'channel', 'community') or cardinality("users"."account_categories") = 0) NOT VALID;
