/**
 * How an application is recognised (ADR 0045): the registry half of app
 * assertions.
 *
 * The ONLY writer of `application_recognition`, `application_web_origins` and
 * `application_oxyos_entries`. Its write callers are the staff lane of the
 * application administration router (`PUT /applications/:appId/recognition`),
 * on the same terms as the application's agents (ADR 0044): staff AND
 * `app:update`, and the official-app seed (`declareApplicationWebOrigins`,
 * `declareApplicationPlatform`), which only ever adds. The readers are
 * `appAssertion.service.ts`, and (ADR 0058) the platform sign-in and the
 * application-token mint.
 */

import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { ApplicationRecognition, ApplicationRecognitionWrite } from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  applicationOxyosEntries,
  applicationRecognition,
  applicationWebOrigins,
} from '../db/schema/applicationRecognition';
import { isUniqueViolation } from '@oxy.so/db';
import { ConflictError } from '../utils/error';

/** An application's declaration; an application nobody declared declares nothing. */
export async function readApplicationRecognition(
  applicationId: string,
): Promise<ApplicationRecognition> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(applicationRecognition)
    .where(eq(applicationRecognition.applicationId, applicationId))
    .limit(1);
  if (!row) {
    return {
      applicationId,
      webOrigins: [],
      android: null,
      ios: null,
      platformHost: null,
      oxyosDesktopEntryIds: [],
      updatedAt: null,
    };
  }
  const [origins, entries] = await Promise.all([
    db
      .select({ origin: applicationWebOrigins.origin })
      .from(applicationWebOrigins)
      .where(eq(applicationWebOrigins.applicationId, applicationId))
      .orderBy(asc(applicationWebOrigins.origin)),
    db
      .select({ desktopEntryId: applicationOxyosEntries.desktopEntryId })
      .from(applicationOxyosEntries)
      .where(eq(applicationOxyosEntries.applicationId, applicationId))
      .orderBy(asc(applicationOxyosEntries.desktopEntryId)),
  ]);
  return {
    applicationId,
    webOrigins: origins.map(({ origin }) => origin),
    platformHost: row.platformHost ?? null,
    oxyosDesktopEntryIds: entries.map(({ desktopEntryId }) => desktopEntryId),
    android: row.androidPackageName
      ? { packageName: row.androidPackageName, signingCertSha256: row.androidSigningCertSha256 }
      : null,
    ios:
      row.iosTeamId && row.iosBundleId
        ? { teamId: row.iosTeamId, bundleId: row.iosBundleId }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Replace the application's whole declaration. Refused (409) when an origin,
 * a desktop entry id, the Android package or the iOS app is already another
 * application's: one identity names one application. `platformHost` and
 * `oxyosDesktopEntryIds` (ADR 0058) are replaced only when the write names
 * them; a write that omits them leaves them as they are.
 */
export async function writeApplicationRecognition(input: {
  applicationId: string;
  recognition: ApplicationRecognitionWrite;
  staffUserId: string;
}): Promise<ApplicationRecognition> {
  const { applicationId, recognition } = input;
  const values = {
    androidPackageName: recognition.android?.packageName ?? null,
    androidSigningCertSha256: recognition.android?.signingCertSha256 ?? [],
    iosTeamId: recognition.ios?.teamId ?? null,
    iosBundleId: recognition.ios?.bundleId ?? null,
    ...(recognition.platformHost !== undefined ? { platformHost: recognition.platformHost } : {}),
    updatedByUserId: input.staffUserId,
    updatedAt: new Date(),
  };
  try {
    await getDb().transaction(async (tx) => {
      await tx
        .insert(applicationRecognition)
        .values({ applicationId, ...values })
        .onConflictDoUpdate({ target: applicationRecognition.applicationId, set: values });
      await tx
        .delete(applicationWebOrigins)
        .where(eq(applicationWebOrigins.applicationId, applicationId));
      if (recognition.webOrigins.length > 0) {
        await tx
          .insert(applicationWebOrigins)
          .values(recognition.webOrigins.map((origin) => ({ origin, applicationId })));
      }
      if (recognition.oxyosDesktopEntryIds !== undefined) {
        await tx
          .delete(applicationOxyosEntries)
          .where(eq(applicationOxyosEntries.applicationId, applicationId));
        if (recognition.oxyosDesktopEntryIds.length > 0) {
          await tx.insert(applicationOxyosEntries).values(
            recognition.oxyosDesktopEntryIds.map((desktopEntryId) => ({
              desktopEntryId,
              applicationId,
            })),
          );
        }
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'An origin, desktop entry id, Android package or iOS app in this declaration is already another application’s',
      );
    }
    throw error;
  }
  return readApplicationRecognition(applicationId);
}

/** Remove the application's declaration: it can no longer assert any platform. */
export async function removeApplicationRecognition(applicationId: string): Promise<void> {
  await getDb()
    .delete(applicationRecognition)
    .where(eq(applicationRecognition.applicationId, applicationId));
}

/**
 * Add `origins` to the application's declared web origins, creating its
 * (empty) declaration when it has none. The official-app seed's write: it is
 * additive and idempotent, so an Android, iOS or extra web origin staff wrote
 * through `writeApplicationRecognition` survives a re-seed. Returns the origins
 * it added; a second run returns none.
 *
 * Throws when an origin is already another application's — a seed must not
 * move an identity between applications.
 */
export async function declareApplicationWebOrigins(
  applicationId: string,
  origins: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (origins.length === 0) return [];
  return db.transaction(async (tx) => {
    const taken = await tx
      .select({ origin: applicationWebOrigins.origin })
      .from(applicationWebOrigins)
      .where(
        and(
          inArray(applicationWebOrigins.origin, [...origins]),
          ne(applicationWebOrigins.applicationId, applicationId),
        ),
      );
    if (taken.length > 0) {
      throw new ConflictError(
        `Web origin ${taken.map(({ origin }) => origin).join(', ')} is already another application’s`,
      );
    }
    await tx.insert(applicationRecognition).values({ applicationId }).onConflictDoNothing();
    const added = await tx
      .insert(applicationWebOrigins)
      .values(origins.map((origin) => ({ origin, applicationId })))
      .onConflictDoNothing()
      .returning({ origin: applicationWebOrigins.origin });
    // A concurrent registration may win between the initial read and INSERT.
    // ON CONFLICT must not silently report that another application's origin
    // was declared for this one.
    const assigned = await tx
      .select({ origin: applicationWebOrigins.origin })
      .from(applicationWebOrigins)
      .where(
        and(
          inArray(applicationWebOrigins.origin, [...origins]),
          ne(applicationWebOrigins.applicationId, applicationId),
        ),
      );
    if (assigned.length) throw new ConflictError('Web origin is already another application’s');
    return added.map(({ origin }) => origin);
  });
}

/** The subset of `origins` the application has not declared yet (the seed's dry run). */
export async function undeclaredApplicationWebOrigins(
  applicationId: string,
  origins: readonly string[],
): Promise<string[]> {
  if (origins.length === 0) return [];
  const declared = new Set(
    (
      await getDb()
        .select({ origin: applicationWebOrigins.origin })
        .from(applicationWebOrigins)
        .where(eq(applicationWebOrigins.applicationId, applicationId))
    ).map(({ origin }) => origin),
  );
  return origins.filter((origin) => !declared.has(origin));
}

/**
 * The seed's platform declaration (ADR 0058), additive like
 * {@link declareApplicationWebOrigins}: sets `platformHost` when the spec
 * declares one (never clears it) and adds the OxyOS desktop entry ids it does
 * not hold yet (never removes one staff wrote). Throws when an id is already
 * another application's. `dryRun` reports what a real run would change and
 * writes nothing.
 */
export async function declareApplicationPlatform(
  applicationId: string,
  declared: { platformHost?: 'oxyos' | 'astro'; oxyosDesktopEntryIds?: readonly string[] },
  options: { dryRun?: boolean; db?: DatabaseOrTransaction } = {},
): Promise<{ platformHostSet: 'oxyos' | 'astro' | null; desktopEntryIdsAdded: string[] }> {
  const entries = [...(declared.oxyosDesktopEntryIds ?? [])];
  const run = async (tx: DatabaseOrTransaction) => {
    if (entries.length > 0) {
      const taken = await tx
        .select({ desktopEntryId: applicationOxyosEntries.desktopEntryId })
        .from(applicationOxyosEntries)
        .where(
          and(
            inArray(applicationOxyosEntries.desktopEntryId, entries),
            ne(applicationOxyosEntries.applicationId, applicationId),
          ),
        );
      if (taken.length > 0) {
        throw new ConflictError(
          `Desktop entry id ${taken.map(({ desktopEntryId }) => desktopEntryId).join(', ')} is already another application’s`,
        );
      }
    }
    const [current] = await tx
      .select({ platformHost: applicationRecognition.platformHost })
      .from(applicationRecognition)
      .where(eq(applicationRecognition.applicationId, applicationId))
      .limit(1);
    const held = new Set(
      (
        await tx
          .select({ desktopEntryId: applicationOxyosEntries.desktopEntryId })
          .from(applicationOxyosEntries)
          .where(eq(applicationOxyosEntries.applicationId, applicationId))
      ).map(({ desktopEntryId }) => desktopEntryId),
    );
    const toAdd = entries.filter((entry) => !held.has(entry));
    const platformHostSet =
      declared.platformHost !== undefined && current?.platformHost !== declared.platformHost
        ? declared.platformHost
        : null;
    if (options.dryRun) return { platformHostSet, desktopEntryIdsAdded: toAdd };

    if (platformHostSet !== null || toAdd.length > 0 || !current) {
      await tx
        .insert(applicationRecognition)
        .values({ applicationId, ...(platformHostSet ? { platformHost: platformHostSet } : {}) })
        .onConflictDoUpdate({
          target: applicationRecognition.applicationId,
          set: platformHostSet
            ? { platformHost: platformHostSet, updatedAt: new Date() }
            : { updatedAt: new Date() },
        });
    }
    const added =
      toAdd.length > 0
        ? await tx
            .insert(applicationOxyosEntries)
            .values(toAdd.map((desktopEntryId) => ({ desktopEntryId, applicationId })))
            .onConflictDoNothing()
            .returning({ desktopEntryId: applicationOxyosEntries.desktopEntryId })
        : [];
    // A concurrent writer may have taken one between the check and the INSERT.
    if (entries.length > 0) {
      const assigned = await tx
        .select({ desktopEntryId: applicationOxyosEntries.desktopEntryId })
        .from(applicationOxyosEntries)
        .where(
          and(
            inArray(applicationOxyosEntries.desktopEntryId, entries),
            ne(applicationOxyosEntries.applicationId, applicationId),
          ),
        );
      if (assigned.length)
        throw new ConflictError('Desktop entry id is already another application’s');
    }
    return {
      platformHostSet,
      desktopEntryIdsAdded: added.map(({ desktopEntryId }) => desktopEntryId),
    };
  };
  if (declared.platformHost === undefined && entries.length === 0) {
    return { platformHostSet: null, desktopEntryIdsAdded: [] };
  }
  const db = options.db ?? getDb();
  return options.dryRun ? run(db) : db.transaction((tx) => run(tx));
}
