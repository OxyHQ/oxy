-- oxy:deploy-phase=pre
--
-- `file_references` (ADR 0042 D4): the successor of `file_links`, naming the
-- application that uses a file by its real id instead of the free-text `app`.
--
--  * file_references: (file_id, application_id → applications, entity_type,
--    entity_id, created_by_user_id NULL, webhook_url [deprecated], created_at),
--    unique on the four identifying columns.
--  * the three scopes CHECKs widen to `files:references:write`.
--  * EVERY existing `file_links` row is copied, its `app` resolved to an
--    application by `oxy_file_link_application_id` — the same table as
--    `src/utils/legacyFileLinkApplications.ts` (a test holds them equal). An
--    `app` that resolves to no application, or to two, FAILS this migration
--    and names every such value: a link is never dropped and never guessed.
--    Run `bun scripts/file-references-preflight.ts` against the target
--    database first; it lists every distinct value and what it resolves to.
--    Rows are copied with their own ids. Two rows that resolve to one
--    reference (the same file, application, entity) collapse into the first.
--  * Until the post migration (`*_drop_file_links`) drops `file_links`, the image still
--    serving writes links there: a trigger mirrors every insert, delete and
--    file move into `file_references`, refusing an unmappable `app` exactly as
--    the copy does. The new image writes only `file_references`, which the
--    previous image does not read — for the length of the rollout it may see a
--    file referenced only by the new image as unused.
--
-- PRE. Additive against both images: a new table, a widened CHECK, a trigger
-- on a table only the previous image writes.
CREATE TABLE "file_references" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"application_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_by_user_id" text,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "file_references_file_id_application_id_entity_key" UNIQUE("file_id","application_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_references_application_id_entity_type_entity_id_idx" ON "file_references" USING btree ("application_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "file_references_created_by_user_id_idx" ON "file_references" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete', 'files:references:write']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete', 'files:references:write']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch', 'files:app:write', 'files:app:delete', 'files:references:write']::text[]);--> statement-breakpoint
-- The resolver. NULL when the value names no application or more than one.
CREATE FUNCTION oxy_file_link_application_id(link_app text) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH legacy(app, application_id, names) AS (
    VALUES
      ('goway', '73176d04c3654667138c23ec', ARRAY['GoWay']),
      ('mercaria', NULL, ARRAY['Mercaria', 'Marketplace']),
      ('nilo', 'ed143b1b58d60eab417f7d5c', ARRAY['Nilo']),
      ('oxy-mail', '6a37b3e61ddfd195b656819b', ARRAY['Oxy Inbox']),
      ('profiles', NULL, ARRAY['Oxy Accounts'])
  ),
  candidates AS (
    SELECT DISTINCT a.id
    FROM applications a
    LEFT JOIN legacy l ON l.app = link_app
    WHERE a.status = 'active'
      AND (
        a.id = link_app
        OR a.id = l.application_id
        OR (a.type <> 'third_party' AND a.name = ANY (l.names))
      )
  )
  SELECT CASE WHEN count(*) = 1 THEN min(id) END FROM candidates
$$;--> statement-breakpoint
DO $$
DECLARE
  unmapped text;
BEGIN
  SELECT string_agg(format('%L (%s links)', app, n), ', ' ORDER BY app) INTO unmapped
  FROM (
    SELECT app, count(*) AS n FROM file_links GROUP BY app
  ) apps
  WHERE oxy_file_link_application_id(app) IS NULL;
  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'file_links.app values that name no single active application: %. Nothing was copied. Map each to an application in src/utils/legacyFileLinkApplications.ts and this migration, or remove those links deliberately, before migrating (scripts/file-references-preflight.ts lists them).', unmapped;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO file_references (id, file_id, application_id, entity_type, entity_id, created_by_user_id, webhook_url, created_at)
SELECT fl.id, fl.file_id, m.application_id, fl.entity_type, fl.entity_id, fl.created_by, fl.webhook_url, fl.created_at
FROM file_links fl
JOIN (
  SELECT app, oxy_file_link_application_id(app) AS application_id
  FROM (SELECT DISTINCT app FROM file_links) apps
) m ON m.app = fl.app
ORDER BY fl.created_at, fl.id
ON CONFLICT (file_id, application_id, entity_type, entity_id) DO NOTHING;--> statement-breakpoint
-- The rollout-window mirror. Dropped by `*_drop_file_links` with `file_links`.
CREATE FUNCTION file_links_mirror_to_file_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resolved text;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM file_references r
    WHERE r.file_id = OLD.file_id
      AND r.application_id = oxy_file_link_application_id(OLD.app)
      AND r.entity_type = OLD.entity_type
      AND r.entity_id = OLD.entity_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    resolved := oxy_file_link_application_id(NEW.app);
    IF resolved IS NULL THEN
      RAISE EXCEPTION 'file_links.app % names no single active application', quote_literal(NEW.app);
    END IF;
    INSERT INTO file_references (id, file_id, application_id, entity_type, entity_id, created_by_user_id, webhook_url, created_at)
    VALUES (NEW.id, NEW.file_id, resolved, NEW.entity_type, NEW.entity_id, NEW.created_by, NEW.webhook_url, NEW.created_at)
    ON CONFLICT (file_id, application_id, entity_type, entity_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER file_links_mirror_to_file_references
AFTER INSERT OR UPDATE OR DELETE ON file_links
FOR EACH ROW EXECUTE FUNCTION file_links_mirror_to_file_references();
