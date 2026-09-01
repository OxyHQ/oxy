/**
 * Transparency checkpoint service tests.
 *
 * The Merkle math itself is covered in `@oxyhq/protocol`; this suite locks the
 * SERVICE behaviour that makes the log trustworthy in production:
 *  - a checkpoint is signed, gapless, and hash-linked to its predecessor;
 *  - the concurrent-writer loser ADOPTS the persisted root instead of publishing
 *    a second root for the same index (two signed roots for one period is the
 *    exact equivocation this system exists to detect);
 *  - an inclusion proof is served from the snapshot the checkpoint COMMITTED to,
 *    not from whatever the heads happen to be now, and it verifies against the
 *    published root with the protocol's own verifier.
 *
 * The models are mocked; the protocol crypto is real.
 */

import { verifyInclusionProof, verifyCheckpointSignature, checkpointHash } from '@oxyhq/protocol';
import { ec as EC } from 'elliptic';

const ec = new EC('secp256k1');
const oxyKey = ec.genKeyPair();
const OXY_PRIVATE_KEY = oxyKey.getPrivate('hex');
const OXY_PUBLIC_KEY = oxyKey.getPublic('hex');

interface HeadRow {
  subjectDid: string;
  seq: number;
  headRecordId: string;
}

interface CheckpointRow {
  index: number;
  periodEnd: number;
  treeSize: number;
  root: string;
  prevCheckpointHash: string | null;
  signatures: { publicKey: string; alg: 'ES256K-DER-SHA256'; signature: string }[];
  anchors: unknown[];
  snapshot: HeadRow[];
}

let heads: HeadRow[] = [];
let stored: CheckpointRow[] = [];
/** When set, the next `create` rejects with a duplicate-key error for that index. */
let duplicateOnIndex: number | null = null;

const mockRepoHeadFind = jest.fn(() => ({ lean: () => Promise.resolve(heads) }));

jest.mock('../../models/RepoHead', () => ({
  __esModule: true,
  RepoHead: { find: (...a: unknown[]) => mockRepoHeadFind(...(a as [])) },
  default: { find: (...a: unknown[]) => mockRepoHeadFind(...(a as [])) },
}));

function sortedDesc(): CheckpointRow[] {
  return [...stored].sort((a, b) => b.index - a.index);
}

const checkpointModel = {
  findOne: jest.fn((filter?: { index?: number }) => ({
    sort: () => ({ lean: () => Promise.resolve(sortedDesc()[0] ?? null) }),
    lean: () =>
      Promise.resolve(stored.find((c) => c.index === filter?.index) ?? null),
  })),
  find: jest.fn((filter: { index?: { $gte?: number } }) => ({
    sort: () => ({
      limit: () => ({
        lean: () =>
          Promise.resolve(
            [...stored]
              .filter((c) => c.index >= (filter?.index?.$gte ?? 0))
              .sort((a, b) => a.index - b.index),
          ),
      }),
    }),
  })),
  create: jest.fn((doc: CheckpointRow) => {
    if (duplicateOnIndex === doc.index) {
      duplicateOnIndex = null;
      const err = new Error('E11000 duplicate key error') as Error & { code: number };
      err.code = 11000;
      return Promise.reject(err);
    }
    stored.push(doc);
    return Promise.resolve(doc);
  }),
};

jest.mock('../../models/TransparencyCheckpoint', () => ({
  __esModule: true,
  TransparencyCheckpoint: checkpointModel,
  default: checkpointModel,
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  buildCheckpoint,
  getInclusionProof,
  getLatestCheckpoint,
  listCheckpoints,
  MAX_CHECKPOINT_SUBJECTS,
  checkpointSignedFields,
} from '../transparency.service';

function head(n: number): HeadRow {
  return {
    subjectDid: `did:web:oxy.so:u:${String(n).padStart(3, '0')}`,
    seq: n,
    headRecordId: String(n).padStart(64, '0'),
  };
}

beforeEach(() => {
  heads = [head(1), head(2), head(3)];
  stored = [];
  duplicateOnIndex = null;
  process.env.OXY_PRIVATE_KEY = OXY_PRIVATE_KEY;
  jest.clearAllMocks();
});

describe('buildCheckpoint', () => {
  it('publishes a signed genesis checkpoint with no previous link', async () => {
    const checkpoint = await buildCheckpoint(1_800_000_000_000);

    expect(checkpoint.index).toBe(0);
    expect(checkpoint.prevCheckpointHash).toBeNull();
    expect(checkpoint.treeSize).toBe(3);
    expect(checkpoint.signatures).toHaveLength(1);
    expect(checkpoint.signatures[0].publicKey).toBe(OXY_PUBLIC_KEY);
    await expect(
      verifyCheckpointSignature(checkpointSignedFields(checkpoint), checkpoint.signatures[0]),
    ).resolves.toBe(true);
  });

  it('hash-links each checkpoint to its predecessor so history cannot be rewritten', async () => {
    const first = await buildCheckpoint(1_800_000_000_000);
    heads = [head(1), head(2), head(3), head(4)];
    const second = await buildCheckpoint(1_800_000_600_000);

    expect(second.index).toBe(1);
    expect(second.prevCheckpointHash).toBe(await checkpointHash(checkpointSignedFields(first)));
    expect(second.treeSize).toBe(4);
  });

  it('commits an empty tree when no subject has a chain yet', async () => {
    heads = [];
    const checkpoint = await buildCheckpoint(1_800_000_000_000);
    expect(checkpoint.treeSize).toBe(0);
  });

  it('refuses to publish an unsigned checkpoint when the Oxy key is not configured', async () => {
    process.env.OXY_PRIVATE_KEY = '';
    await expect(buildCheckpoint(1_800_000_000_000)).rejects.toThrow(/OXY_PRIVATE_KEY/);
    expect(checkpointModel.create).not.toHaveBeenCalled();
  });

  it('refuses to publish a checkpoint whose proofs it could not serve', async () => {
    heads = Array.from({ length: MAX_CHECKPOINT_SUBJECTS + 1 }, (_, i) => head(i));
    await expect(buildCheckpoint(1_800_000_000_000)).rejects.toThrow(/subjects/i);
    expect(checkpointModel.create).not.toHaveBeenCalled();
  });

  it('adopts the persisted checkpoint when another task won the same index', async () => {
    // A concurrent task already published index 0 with a DIFFERENT root.
    const winner: CheckpointRow = {
      index: 0,
      periodEnd: 1_800_000_000_000,
      treeSize: 1,
      root: 'a'.repeat(64),
      prevCheckpointHash: null,
      signatures: [{ publicKey: OXY_PUBLIC_KEY, alg: 'ES256K-DER-SHA256', signature: 'sig' }],
      anchors: [],
      snapshot: [head(1)],
    };
    stored = [winner];
    duplicateOnIndex = 0;
    // The loser recomputes index 0 (it read the head list before the winner landed).
    stored = [];
    checkpointModel.findOne.mockImplementationOnce(() => ({
      sort: () => ({ lean: () => Promise.resolve(null) }),
      lean: () => Promise.resolve(null),
    }));
    stored = [winner];

    const result = await buildCheckpoint(1_800_000_000_000);

    expect(result.root).toBe(winner.root);
    expect(stored).toHaveLength(1);
  });
});

describe('getInclusionProof', () => {
  it('serves a proof that verifies against the published root', async () => {
    const checkpoint = await buildCheckpoint(1_800_000_000_000);
    const proof = await getInclusionProof(head(2).subjectDid);

    expect(proof).not.toBeNull();
    if (!proof) return;
    expect(proof.seq).toBe(head(2).seq);
    expect(proof.headRecordId).toBe(head(2).headRecordId);
    await expect(
      verifyInclusionProof({
        leaf: proof.leaf,
        index: proof.leafIndex,
        treeSize: checkpoint.treeSize,
        proof: proof.proof,
        root: checkpoint.root,
      }),
    ).resolves.toBe(true);
  });

  it('proves against the snapshot the checkpoint committed to, not the current heads', async () => {
    const first = await buildCheckpoint(1_800_000_000_000);
    // The subject's chain advances AFTER the checkpoint was published.
    heads = [head(1), { ...head(2), seq: 99, headRecordId: 'f'.repeat(64) }, head(3)];
    await buildCheckpoint(1_800_000_600_000);

    const proof = await getInclusionProof(head(2).subjectDid, 0);
    expect(proof).not.toBeNull();
    if (!proof) return;
    expect(proof.seq).toBe(head(2).seq);
    await expect(
      verifyInclusionProof({
        leaf: proof.leaf,
        index: proof.leafIndex,
        treeSize: first.treeSize,
        proof: proof.proof,
        root: first.root,
      }),
    ).resolves.toBe(true);
  });

  it('returns null for a subject that is not in the checkpoint', async () => {
    await buildCheckpoint(1_800_000_000_000);
    await expect(getInclusionProof('did:web:oxy.so:u:nobody')).resolves.toBeNull();
  });

  it('returns null when no checkpoint has been published yet', async () => {
    await expect(getInclusionProof(head(1).subjectDid)).resolves.toBeNull();
  });

  it('returns null for a checkpoint index that does not exist', async () => {
    await buildCheckpoint(1_800_000_000_000);
    await expect(getInclusionProof(head(1).subjectDid, 42)).resolves.toBeNull();
  });
});

describe('reads', () => {
  it('reports the newest checkpoint', async () => {
    await buildCheckpoint(1_800_000_000_000);
    const second = await buildCheckpoint(1_800_000_600_000);
    await expect(getLatestCheckpoint()).resolves.toMatchObject({ index: second.index });
  });

  it('lists the checkpoint chain oldest first so a verifier can walk the links', async () => {
    await buildCheckpoint(1_800_000_000_000);
    await buildCheckpoint(1_800_000_600_000);
    const list = await listCheckpoints(0, 10);
    expect(list.map((c) => c.index)).toEqual([0, 1]);
  });

  it('never exposes the committed snapshot, which would enumerate every subject', async () => {
    await buildCheckpoint(1_800_000_000_000);
    const latest = await getLatestCheckpoint();
    expect(latest).not.toBeNull();
    expect(latest as unknown as Record<string, unknown>).not.toHaveProperty('snapshot');
  });
});
