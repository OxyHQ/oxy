/**
 * How an application is recognised (ADR 0045): the registry half of app
 * assertions.
 *
 * The ONLY writer of `application_recognition` and `application_web_origins`.
 * Its one write caller is the staff lane of the application administration
 * router (`PUT /applications/:appId/recognition`), on the same terms as the
 * application's agents (ADR 0044): staff AND `app:update`. The reader is
 * `appAssertion.service.ts`.
 */

import { asc, eq } from 'drizzle-orm';
import type { ApplicationRecognition, ApplicationRecognitionWrite } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { applicationRecognition, applicationWebOrigins } from '../db/schema/applicationRecognition';
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
  if (!row) return { applicationId, webOrigins: [], android: null, ios: null, updatedAt: null };
  const origins = await db
    .select({ origin: applicationWebOrigins.origin })
    .from(applicationWebOrigins)
    .where(eq(applicationWebOrigins.applicationId, applicationId))
    .orderBy(asc(applicationWebOrigins.origin));
  return {
    applicationId,
    webOrigins: origins.map(({ origin }) => origin),
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
 * the Android package or the iOS app is already another application's: one
 * identity names one application.
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
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'An origin, Android package or iOS app in this declaration is already another application’s',
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
