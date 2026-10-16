/**
 * Pre-flight for migration `0168_file_references` (ADR 0042 D4). READ-ONLY.
 *
 *   DATABASE_URL=… bun run packages/api/scripts/file-references-preflight.ts
 *
 * 0167 copies every `file_links` row into `file_references`, resolving its
 * free-text `app` to an application, and FAILS — copying nothing — when any
 * `app` names no single active application. Run this against the target
 * database before deploying: it prints one JSON line per distinct `app` with
 * its link count and what it resolves to, then a summary line, and exits 1 if
 * the migration would refuse.
 *
 * Resolution is `referenceApplicationCandidates`, the runtime twin of the
 * migration's `oxy_file_link_application_id`; both read
 * `src/utils/legacyFileLinkApplications.ts`, and a test holds the migration's
 * copy equal to it. An unmappable value is fixed by adding it to that table
 * (and to 0167, before it ships) or by deleting those links deliberately —
 * never by guessing.
 */
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { referenceApplicationCandidates } from '../src/services/fileReference.service';

async function main(): Promise<void> {
  await connectPostgres();
  try {
    const db = getDb();
    const exists = (await db.execute(
      sql`select to_regclass('public.file_links')::text as name`,
    )) as unknown as Array<{ name: string | null }>;
    if (!exists[0]?.name) {
      console.log(JSON.stringify({ summary: { fileLinks: 'absent', wouldRefuse: false } }));
      return;
    }

    // `count` is int8: postgres.js returns it as a string.
    const apps = (await db.execute(
      sql`select app, count(*)::text as links from file_links group by app order by app`,
    )) as unknown as Array<{ app: string; links: string }>;

    let unmapped = 0;
    let links = 0;
    for (const { app, links: count } of apps) {
      const candidates = await referenceApplicationCandidates(app);
      const resolved = candidates.length === 1 ? candidates[0] : null;
      if (!resolved) unmapped += 1;
      links += Number(count);
      console.log(
        JSON.stringify({
          app,
          links: Number(count),
          ...(resolved
            ? { applicationId: resolved.id, applicationName: resolved.name }
            : {
                unmappable: candidates.length === 0 ? 'no application' : 'ambiguous',
                candidates,
              }),
        }),
      );
    }

    console.log(
      JSON.stringify({
        summary: { distinctApps: apps.length, links, unmapped, wouldRefuse: unmapped > 0 },
      }),
    );
    if (unmapped > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
