-- oxy:deploy-phase=pre
ALTER TABLE "users" DROP CONSTRAINT "users_color_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_color_check" CHECK ("users"."color" in ('teal', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'sky', 'orange', 'mint', 'mono', 'oxy') or "users"."color" ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$');