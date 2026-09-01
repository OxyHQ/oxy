-- oxy:deploy-phase=pre
--
-- PRE: one new table plus a foreign key onto it. The previous image does not
-- read `follow_namespaces`, and the only kinds that exist when this lands are
-- the platform's own `oxy.*` seed from 0016 — so backfilling the namespace it
-- already implies is enough to make the constraint satisfiable at creation
-- time, with nothing to migrate afterwards.
--
-- WHY THIS EXISTS. 0016 enforces that `mercaria.store` lives in the namespace
-- `mercaria`. It does not enforce that only Mercaria may say so: any
-- application holding `follow-targets:register` could register `syra.artist`
-- and define what a Syra artist is from then on. With a handful of first-party
-- apps that is theoretical; with a thousand it is the tenancy model, and it
-- fails silently — the squatter's registration simply wins.

CREATE TABLE "follow_namespaces" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "namespace" text NOT NULL,
  "application_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "follow_namespaces_namespace_key" UNIQUE ("namespace"),
  CONSTRAINT "follow_namespaces_shape_check" CHECK ("namespace" ~ '^[a-z][a-z0-9_]*$')
);

ALTER TABLE "follow_namespaces"
  ADD CONSTRAINT "follow_namespaces_application_id_applications_id_fk"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE set null;

CREATE INDEX "follow_namespaces_application_idx" ON "follow_namespaces" ("application_id");

-- The platform's own namespace, owned by no application row — the same reason
-- `follow_target_kinds.application_id` is nullable for the `oxy.*` seed.
INSERT INTO "follow_namespaces" ("namespace", "application_id")
VALUES ('oxy', NULL)
ON CONFLICT ("namespace") DO NOTHING;

-- Any namespace already implied by a registered kind, so the foreign key below
-- is satisfiable the moment it is created. On a fresh deployment this is the
-- `oxy` row above and nothing else; on one where an application already
-- registered a kind, it grants that application's namespace to whoever
-- registered it, which is the only attribution the data supports.
INSERT INTO "follow_namespaces" ("namespace", "application_id")
SELECT DISTINCT ON ("namespace") "namespace", "application_id"
FROM "follow_target_kinds"
ORDER BY "namespace", "created_at" ASC
ON CONFLICT ("namespace") DO NOTHING;

-- A kind's namespace is now a reference, not a string somebody typed.
-- RESTRICT: a namespace with kinds in it cannot be pulled out from under them.
ALTER TABLE "follow_target_kinds"
  ADD CONSTRAINT "follow_target_kinds_namespace_fk"
  FOREIGN KEY ("namespace") REFERENCES "follow_namespaces"("namespace") ON DELETE restrict;
