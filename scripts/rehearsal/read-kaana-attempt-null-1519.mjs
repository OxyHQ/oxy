/** Read-only, bounded signed telemetry probe. No inference or ledger imports. */
import { createHash, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { readKaanaSigningConfig } = await import(
  new URL('./packages/api/scripts/run-kaana-signed-canary.mjs', pathToFileURL(`${process.cwd()}/`))
);

const MAX_PAGES = 3;
const PAGE_SIZE = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function probe() {
  if (process.env.DATABASE_URL !== undefined || process.env.TEST_DATABASE_URL !== undefined) {
    throw new Error('database_binding_forbidden');
  }
  const config = readKaanaSigningConfig();
  if (config.baseUrl !== 'https://kaana.ai') throw new Error('canonical_origin_required');
  const pages = [];
  let after = null;
  let nullUnits = 0;
  let emptyUnits = 0;
  let example;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = Buffer.from(
      JSON.stringify({ schemaVersion: 1, ...(after ? { after } : {}), limit: PAGE_SIZE }),
    );
    const timestamp = Date.now();
    const signingInput = Buffer.from(
      ['oxy-kaana-provider-telemetry:v1', config.keyId, String(timestamp), hash(body)].join('\n'),
    );
    const signature = sign(null, signingInput, config.privateKey).toString('base64');
    const response = await fetch(`${config.baseUrl}/internal/v1/provider-telemetry/attempts`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'cache-control': 'no-store',
        'X-Oxy-Kaana-Key-Id': config.keyId,
        'X-Oxy-Kaana-Timestamp': String(timestamp),
        'X-Oxy-Kaana-Signature': `v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200 || !response.body) throw new Error('feed_http_or_body_failed');
    const chunks = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new Error('feed_byte_bound');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks, bytes);
    const data = JSON.parse(raw);
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.attempts) ||
      data.attempts.length > PAGE_SIZE ||
      typeof data.caughtUp !== 'boolean' ||
      !(data.next === null || typeof data.next === 'string')
    ) {
      throw new Error('feed_shape_failed');
    }
    for (const row of data.attempts) {
      if (!Object.hasOwn(row, 'units') || !(row.units === null || Array.isArray(row.units))) {
        throw new Error('feed_units_shape_failed');
      }
      if (row.units === null) {
        nullUnits++;
        example ??= {
          requestIdSha256: hash(String(row.requestId)),
          attemptIndex: row.attemptIndex,
          units: null,
          costIsNull: row.cost === null,
          costSource: row.costSource,
          telemetryIsNull: row.telemetry === null,
          deploymentId: row.deploymentId,
        };
      } else if (row.units.length === 0) emptyUnits++;
    }
    pages.push({
      page,
      status: response.status,
      count: data.attempts.length,
      bytes,
      responseSha256: hash(raw),
      caughtUp: data.caughtUp,
      readAt: data.readAt,
    });
    if (nullUnits || data.caughtUp) break;
    if (!data.next || data.next === after) throw new Error('feed_cursor_failed');
    after = data.next;
  }
  console.log(
    JSON.stringify({
      probe: 'kaana-attempt-null-readback-v1',
      pages,
      nullUnits,
      emptyUnits,
      example,
      nullServed: nullUnits > 0,
      providerRequests: 0,
      oxyLedgerWrites: 0,
      responseAuthentication: 'TLS plus signed request; response has no separate signature',
    }),
  );
  if (!nullUnits) process.exitCode = 2;
}
probe().catch(() => {
  console.error(
    JSON.stringify({ probe: 'kaana-attempt-null-readback-v1', error: 'bounded_read_failed' }),
  );
  process.exitCode = 1;
});
