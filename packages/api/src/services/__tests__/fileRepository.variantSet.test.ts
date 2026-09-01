/**
 * `upsertVariantSet` writes a BATCH of renditions without clearing the file's
 * whole variant set, against a REAL Postgres.
 *
 * This is what lets background generation and the lazy read path coexist once
 * generation moved off the upload path. `assetService.ensureVariant`
 * materialises ONE variant on demand (`upsertVariant`) — for a video that is a
 * poster-derived image size, which background generation does not produce
 * (it produces poster, `360p`/`720p`/`1080p` and HLS). The predecessor,
 * `replaceVariants`, deleted every row for the file first, so a queued job
 * landing after a lazy read destroyed exactly the renditions that read had just
 * paid an ffmpeg pass to build — and the next read paid it again. Harmless in
 * the old code because generation started immediately; a growing window once a
 * job can sit in a queue.
 */

import { randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres } from '../../config/postgres';
import { findFileById, insertFile, upsertVariant, upsertVariantSet } from '../fileRepository';

/** A globally unique 64-hex content hash — the live-sha256 unique spans the
 *  whole table and suites run in parallel against one database. */
const sha = () => randomBytes(32).toString('hex');
const key = () => `variants/${randomBytes(8).toString('hex')}`;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('upsertVariantSet', () => {
  it('preserves rows of types the batch does not write', async () => {
    const file = await insertFile({ sha256: sha(), mime: 'video/mp4', ext: 'mp4', size: 1, status: 'active', storageKey: key(), systemOwner: '__federation__' });

    // What a lazy read materialised: a poster-derived image size.
    await upsertVariant(file.id, { type: 'w320', key: key(), readyAt: new Date() });

    // What background generation then commits: poster + renditions, no `w320`.
    const written = await upsertVariantSet(file.id, [
      { type: 'poster', key: key(), readyAt: new Date() },
      { type: '720p', key: key(), readyAt: new Date() },
    ]);

    expect(written.map((row) => row.type).sort()).toEqual(['720p', 'poster']);

    const record = await findFileById(file.id);
    expect(record?.variants.map((row) => row.type).sort()).toEqual(['720p', 'poster', 'w320']);
  });

  it('replaces a row of a type the batch DOES write', async () => {
    const file = await insertFile({ sha256: sha(), mime: 'image/png', ext: 'png', size: 1, status: 'active', storageKey: key(), systemOwner: '__federation__' });
    const stale = key();
    const fresh = key();

    await upsertVariant(file.id, { type: 'thumb', key: stale, readyAt: new Date() });
    await upsertVariantSet(file.id, [{ type: 'thumb', key: fresh, readyAt: new Date() }]);

    const record = await findFileById(file.id);
    expect(record?.variants).toHaveLength(1);
    expect(record?.variants[0].key).toBe(fresh);
  });

  it('writes the metadata patch in the same transaction as the renditions', async () => {
    const file = await insertFile({ sha256: sha(), mime: 'image/png', ext: 'png', size: 1, status: 'active', storageKey: key(), systemOwner: '__federation__' });

    await upsertVariantSet(
      file.id,
      [{ type: 'thumb', key: key(), readyAt: new Date() }],
      { metadata: { media: { width: 800, height: 600 } } },
    );

    const record = await findFileById(file.id);
    expect(record?.metadata).toEqual({ media: { width: 800, height: 600 } });
    expect(record?.variants).toHaveLength(1);
  });

  it('is a no-op on rows when the batch is empty', async () => {
    const file = await insertFile({ sha256: sha(), mime: 'image/png', ext: 'png', size: 1, status: 'active', storageKey: key(), systemOwner: '__federation__' });
    await upsertVariant(file.id, { type: 'thumb', key: key(), readyAt: new Date() });

    await upsertVariantSet(file.id, []);

    const record = await findFileById(file.id);
    expect(record?.variants).toHaveLength(1);
  });
});
