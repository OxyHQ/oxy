-- oxy:deploy-phase=pre
-- Notifications may name an `app` entity (an opaque id in the notifying app's
-- namespace), for `system` notifications only. Widens entity_type's CHECK and adds
-- one that ties `app` to `system`; no existing row uses either value, and the
-- previous image writes neither, so it is safe ahead of the rollout.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_entity_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_app_entity_system_only_check" CHECK ("notifications"."entity_type" <> 'app' or "notifications"."type" = 'system');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check" CHECK ("notifications"."entity_type" in ('post', 'reply', 'profile', 'app'));