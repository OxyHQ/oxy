/**
 * Shared test harness for the `@oxyhq/protocol/node` suites — an in-memory
 * `RecordStore`/`BlobStore`, an owner-key `OwnerAuth`, a silent logger, and a
 * signed-envelope forge. Not a test file (no `.test.ts` suffix) — imported by
 * the node app / client suites so they exercise `createNodeApp` + `NodeClient`
 * against a faithful (continuity-enforcing) store with no DB and no real crypto
 * service.
 */

import { generateSecp256k1KeyPair } from '../secp256k1';
import { createHash } from 'node:crypto';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { checkContinuity } from '../chain/continuity';
import { signEnvelope, signMessage, verifySignature } from '../envelope/sign';
import type { AppendOutcome, ChainHead } from '../chain/types';
import type { BlobStore, RecordStore } from '../chain/recordStore';
import { BlobHashMismatchError, type NodeLogger, type OwnerAuth } from '../node/nodeApp';

export interface TestKeyPair {
  privateKey: string;
  publicKey: string;
}

/** Generate a secp256k1 keypair (uncompressed hex public key, matching the signer). */
export function generateKeyPair(): TestKeyPair {
  const kp = generateSecp256k1KeyPair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

export const DEFAULT_SUBJECT = 'did:web:node.example:u:owner';

export interface BuildEnvelopeOptions {
  privateKey: string;
  seq: number;
  prev: string | null;
  subject?: string;
  issuer?: string;
  type?: string;
  collection?: string;
  rkey?: string;
  record?: Record<string, unknown>;
  issuedAt?: number;
}

/** Forge a fully-signed v2 envelope with the protocol signer. */
export function buildSignedEnvelope(options: BuildEnvelopeOptions): Promise<SignedRecordEnvelope> {
  const subject = options.subject ?? DEFAULT_SUBJECT;
  return signEnvelope(
    {
      version: 2,
      type: options.type ?? 'app_record',
      subject,
      issuer: options.issuer ?? subject,
      record: options.record ?? { hello: 'world' },
      issuedAt: options.issuedAt ?? 1_700_000_000_000 + options.seq,
      seq: options.seq,
      prev: options.prev,
      collection: options.collection ?? 'app.oxy.identity',
      rkey: options.rkey ?? 'self',
    },
    options.privateKey,
  );
}

/** A continuity-enforcing in-memory `RecordStore` + `BlobStore` (single chain). */
export function createInMemoryNodeStore(): RecordStore & BlobStore {
  const records: Array<{ env: SignedRecordEnvelope; recordId: string }> = [];
  const recordIds = new Set<string>();
  const blobs = new Map<string, Buffer>();
  let head: ChainHead | null = null;

  return {
    async getHead(): Promise<ChainHead | null> {
      return head;
    },
    async append(_subject, env, recordId): Promise<AppendOutcome> {
      const continuity = checkContinuity(head, env);
      if (!continuity.ok) {
        return continuity;
      }
      if (recordIds.has(recordId)) {
        return { ok: false, reason: 'chain_conflict' };
      }
      const seq = env.seq ?? -1;
      records.push({ env, recordId });
      recordIds.add(recordId);
      head = { headRecordId: recordId, seq, recordCount: records.length };
      return { ok: true, recordId, seq };
    },
    async getLogSince(_subject, sinceSeq, limit): Promise<SignedRecordEnvelope[]> {
      return records
        .filter((r) => (r.env.seq ?? -1) > sinceSeq)
        .slice(0, limit)
        .map((r) => r.env);
    },
    async resolveCursorSeq(_subject, recordId): Promise<number | null> {
      const found = records.find((r) => r.recordId === recordId);
      return found ? found.env.seq ?? -1 : null;
    },
    async materializeCurrent(_subject, collection, rkey): Promise<SignedRecordEnvelope | null> {
      const matching = records.filter((r) => r.env.collection === collection && r.env.rkey === rkey);
      return matching.length ? matching[matching.length - 1].env : null;
    },
    async latestIssuedAtForKey(_subject, env): Promise<number | null> {
      const matching = records.filter((r) => r.env.collection === env.collection && r.env.rkey === env.rkey);
      return matching.length ? matching[matching.length - 1].env.issuedAt : null;
    },
    async putBlob(hash, bytes): Promise<void> {
      const buf = Buffer.from(bytes);
      const actual = createHash('sha256').update(buf).digest('hex');
      const address = hash.toLowerCase();
      if (actual !== address) {
        throw new BlobHashMismatchError(address, actual);
      }
      blobs.set(address, buf);
    },
    async getBlob(hash): Promise<Uint8Array | null> {
      return blobs.get(hash.toLowerCase()) ?? null;
    },
  };
}

/** An `OwnerAuth` bound to `ownerPublicKey`, verifying the node-style pin message. */
export function createTestOwnerAuth(ownerPublicKey: string): OwnerAuth {
  const owner = ownerPublicKey.toLowerCase();
  return {
    isOwnerKey(publicKey: string): boolean {
      return publicKey.toLowerCase() === owner;
    },
    async verifyBlobPin(hash, auth): Promise<boolean> {
      if (auth.publicKey.toLowerCase() !== owner) {
        return false;
      }
      const message = `oxy-node:blob-pin:${hash}:${auth.timestamp}`;
      return verifySignature(message, auth.signature, auth.publicKey);
    },
  };
}

/** Sign the owner pin authorization headers for a blob hash. */
export async function signBlobPin(
  hash: string,
  owner: TestKeyPair,
): Promise<{ publicKey: string; signature: string; timestamp: number }> {
  const timestamp = Date.now();
  const signature = await signMessage(`oxy-node:blob-pin:${hash}:${timestamp}`, owner.privateKey);
  return { publicKey: owner.publicKey, signature, timestamp };
}

/** A logger that swallows output (the suites assert on responses, not logs). */
export const silentLogger: NodeLogger = { error() {} };
