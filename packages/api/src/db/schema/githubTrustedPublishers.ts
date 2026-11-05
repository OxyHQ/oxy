/**
 * `github_trusted_publishers` — the GitHub Actions workflows allowed to publish
 * an application's OTA updates without holding any secret (ADR 0057).
 *
 * A row says: "a job in exactly this repository, on exactly this ref (and, when
 * set, from exactly this workflow file), may exchange its GitHub OIDC token for
 * a five-minute `updates:publish` service token of this application". The
 * exchange is `POST /auth/service-token/github-actions`
 * (`services/githubTrustedPublishing.service.ts`); nothing else reads this table
 * to grant anything.
 *
 * ## Not a credential, and deliberately not a row in `application_credentials`
 *
 * There is no secret to store, rotate or reveal, so none of the credential
 * lanes (OAuth client, service-token mint, machine bearer) may ever see one of
 * these. A token minted here names the row as `credentialId: tp_<id>`, and the
 * live service-principal resolver (`services/agencyServicePrincipal.service.ts`)
 * routes that prefix to THIS table: deleting the row cuts every outstanding
 * token off on its next request.
 *
 * ## Why the numeric `repository_id` is stored and compared
 *
 * GitHub names are reusable. A repository that is deleted (or an organization
 * that is renamed) frees `Owner/Name` for anyone to recreate, and that
 * stranger's workflow would present the same `repository` claim. The numeric
 * id GitHub puts in `repository_id` is never reused, so a row matches only the
 * repository that existed when it was registered. Both must match.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';

import { applications } from './applications';
import { users } from './users';

/** `Owner/Name`, as GitHub spells it: the characters GitHub allows in either half. */
export const GITHUB_REPOSITORY_PATTERN = '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$';

/** A full Git ref; the trusted publisher names a branch or a tag, never a short name. */
export const GITHUB_REF_PATTERN = '^refs/(heads|tags)/[^[:space:]]{1,255}$';

/** A workflow file inside the repository, the path GitHub puts before `@` in `workflow_ref`. */
export const GITHUB_WORKFLOW_PATTERN = '^\\.github/workflows/[A-Za-z0-9._-]{1,200}\\.ya?ml$';

export const githubTrustedPublishers = pgTable(
  'github_trusted_publishers',
  {
    id: generatedId(),

    /** `CASCADE` — a publisher of an application that no longer exists must not publish. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /**
     * `Owner/Name` as GitHub reported it at registration. Compared
     * case-insensitively, because GitHub resolves names that way and puts its
     * own canonical casing in the token.
     */
    repository: text().notNull(),

    /** GitHub's numeric repository id, as a decimal string — see the header. */
    repositoryId: text().notNull(),

    /** The exact `ref` claim a token must carry. */
    ref: text().notNull().default('refs/heads/main'),

    /**
     * `.github/workflows/<file>.yml`, or NULL for "any workflow on that ref".
     * When set, the token's `workflow_ref` must be exactly
     * `<repository>/<workflow>@<ref>`.
     */
    workflow: text(),

    /** Attribution, not ownership: the person who registered it. */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    /** The last successful exchange, as a credential's `last_used_at`. */
    lastUsedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One rule, stated once. NULLS NOT DISTINCT so two "any workflow" rows for
    // the same repository and ref are a duplicate too.
    unique('github_trusted_publishers_rule_key')
      .on(t.applicationId, t.repositoryId, t.ref, t.workflow)
      .nullsNotDistinct(),
    // The exchange reads "this application's publishers"; the unique index above
    // leads with `application_id`, so it serves that read and no second index is
    // needed for it. The live resolver reads by primary key.
    index('github_trusted_publishers_created_by_user_id_idx').on(t.createdByUserId),
    check(
      'github_trusted_publishers_repository_check',
      sql`${t.repository} ~ ${sql.raw(`'${GITHUB_REPOSITORY_PATTERN}'`)}`,
    ),
    check(
      'github_trusted_publishers_repository_id_check',
      sql`${t.repositoryId} ~ '^[1-9][0-9]{0,19}$'`,
    ),
    check(
      'github_trusted_publishers_ref_check',
      sql`${t.ref} ~ ${sql.raw(`'${GITHUB_REF_PATTERN}'`)}`,
    ),
    check(
      'github_trusted_publishers_workflow_check',
      sql`${t.workflow} is null or ${t.workflow} ~ ${sql.raw(`'${GITHUB_WORKFLOW_PATTERN}'`)}`,
    ),
  ],
);

export type GithubTrustedPublisherRow = typeof githubTrustedPublishers.$inferSelect;
