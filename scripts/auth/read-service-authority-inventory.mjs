/** Read-only I03 authority metadata, never a credential or authorization verdict.
 * Fixed columns exclude public keys, hashes, secrets, tokens and personal names.
 * Missing epochs before migration remain missing; they are never reported as zero.
 * Caller/receiver mapping, live authority and required scopes need separate proof. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(`${process.cwd()}/package.json`);
const postgres = require('postgres');
const MAX_ROWS = 1000;
const MAX_BYTES = 1024 * 1024;
const PROJECTIONS = {
  oxy: {
    applications: ['id', 'name', 'type', 'status', 'is_official', 'is_internal', 'owner_account_id', 'scopes'],
    application_credentials: ['id', 'application_id', 'type', 'environment', 'status', 'expires_at', 'scopes'],
    application_workload_identities: ['id', 'application_id', 'provider', 'subject', 'scopes', 'expires_at'],
    app_grants: ['id', 'user_id', 'application_id', 'scopes'],
    service_acting_as_revocations: ['user_id', 'application_id', 'revoked_at'],
    service_acting_as_authority_epochs: ['user_id', 'application_id', 'epoch'],
    users: { columns: ['id', 'account_status'], where: 'id IN (SELECT owner_account_id FROM public.applications UNION SELECT user_id FROM public.app_grants)' },
    account_closure_fences: { columns: ['account_id'], where: 'account_id IN (SELECT owner_account_id FROM public.applications UNION SELECT user_id FROM public.app_grants)' },
  },
};
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export async function readInventory(profile, databaseUrl) {
  if (!Object.hasOwn(PROJECTIONS, profile) || !databaseUrl) throw new Error('Invalid fixed inventory profile');
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });
  try {
    return await client.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL statement_timeout = '15000'`;
      await tx`SET LOCAL lock_timeout = '3000'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '30000'`;
      const [safety] = await tx`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, transaction_timestamp()::text AS observed_at`;
      if (safety.read_only !== 'on' || safety.isolation !== 'repeatable read') throw new Error('Required SQL read-only snapshot absent');
      const tables = {};
      for (const [table, spec] of Object.entries(PROJECTIONS[profile])) {
        const descriptor = Array.isArray(spec) ? { columns: spec } : spec;
        const [presence] = await tx`SELECT to_regclass(${`public.${table}`})::text AS name`;
        if (!presence.name) { tables[table] = { status: 'missing', count: null, rows: [] }; continue; }
        const columns = await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
        const names = new Set(columns.map(row => row.column_name));
        const missing = [...descriptor.columns, ...(descriptor.required ?? [])].filter(column => !names.has(column));
        const legacy = descriptor.legacyProfile && missing.length === descriptor.legacyProfile.absentColumns.length
          && descriptor.legacyProfile.absentColumns.every(column => missing.includes(column));
        if (missing.length && !legacy) { tables[table] = { status: 'schema_mismatch', count: null, missing, rows: [] }; continue; }
        const selectedColumns = legacy ? descriptor.columns.filter(column => !missing.includes(column)) : descriptor.columns;
        if (descriptor.dependsOn) {
          const [dependency] = await tx`SELECT to_regclass(${`public.${descriptor.dependsOn}`})::text AS name`;
          if (!dependency.name) { tables[table] = { status: 'dependency_missing', count: null, rows: [] }; continue; }
        }
        // SQL identifiers, expressions and filters originate exclusively in the fixed map above.
        const where = descriptor.where ? ` WHERE ${descriptor.where}` : '';
        const [total] = await tx.unsafe(`SELECT count(*)::text AS n FROM public.${table}${where}`);
        const count = Number(total.n);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid inventory count');
        if (count > MAX_ROWS) { tables[table] = { status: 'row_limit', count, rows: [] }; continue; }
        const selected = [...selectedColumns.map(column => `"${column}"`), ...(descriptor.extra ?? [])].join(', ');
        const rows = await tx.unsafe(`SELECT ${selected} FROM public.${table}${where} ORDER BY ${selectedColumns.map(column => `"${column}"`).join(', ')} LIMIT ${MAX_ROWS + 1}`);
        if (rows.length !== count) throw new Error('Inventory snapshot count differs');
        tables[table] = { status: 'complete', count, rows: Array.from(rows), ...(legacy ? { schemaProfile: descriptor.legacyProfile.name, unavailableColumns: missing } : {}) };
      }
      const dependency = require.resolve('postgres');
      let packageDirectory = dirname(dependency); let packageMetadata;
      for (let depth = 0; depth < 6; depth++) {
        try { const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')); if (metadata.name === 'postgres') { packageMetadata = metadata; break; } } catch {}
        packageDirectory = dirname(packageDirectory);
      }
      if (!packageMetadata || typeof packageMetadata.version !== 'string') throw new Error('Resolved postgres package lacks metadata');
      const result = { schemaVersion: 1, kind: 'service-authority-preflight', profile, readOnly: true, isolation: safety.isolation, observedAt: safety.observed_at,
        runtime: { node: process.version, postgresVersion: packageMetadata.version, postgresEntrySha256: hash(readFileSync(dependency)) }, tables };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('Inventory output exceeds fixed byte bound');
      return result;
    });
  } finally { await client.end({ timeout: 5 }); }
}
export function encodeInventory(result, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid result nonce');
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > MAX_BYTES) throw new Error('Inventory output exceeds fixed byte bound');
  const payload = bytes.toString('base64'); const chunks = [];
  for (let start = 0; start < payload.length; start += 12000) chunks.push(payload.slice(start, start + 12000));
  return chunks.map((data, seq) => `OXY_BILLING_INVENTORY ${JSON.stringify({ nonce, seq, total: chunks.length, sha256: hash(bytes), data })}`);
}
// Reuses the reviewed bounded inventory packet protocol. Imports alone connect nowhere.
// No metadata row proves a service secret, runtime caller identity or domain permission.
