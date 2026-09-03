/**
 * Executes the actual 0070 data migration against PostgreSQL. This is a data
 * cleanup rather than a schema declaration, so snapshot-sync alone cannot
 * prove that it preserves a legacy icon's path and unrelated parameters.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  closePostgres,
  connectPostgres,
  getDb,
} from "../../../config/postgres";
import { applications } from "../applications";
import { users } from "../users";

const MIGRATION = path.resolve(
  __dirname,
  "../../../../drizzle/0070_sanitize_legacy_application_icon_urls.sql",
);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it("cleans sensitive icon parameters while preserving path, safe parameters and fragment", async () => {
  const marker = `icon-migration-${Date.now()}`;
  const [owner] = await getDb()
    .insert(users)
    .values({ username: marker, email: `${marker}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: marker,
      ownerAccountId: owner.id,
      icon: "/icons/homiio.svg?size=64&Token=secret-marker&theme=dark&access_token=second-marker&AUTHORIZATION=third-marker#logo",
    })
    .returning({ id: applications.id });

  const migrationSql = readFileSync(MIGRATION, "utf8");
  await getDb().execute(sql.raw(migrationSql));

  const [row] = await getDb()
    .select({ icon: applications.icon })
    .from(applications)
    .where(eq(applications.id, application.id));
  expect(row.icon).toBe("/icons/homiio.svg?size=64&theme=dark#logo");
});
