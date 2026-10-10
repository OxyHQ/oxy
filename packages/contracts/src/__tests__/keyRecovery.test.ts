import {
  backupLookupIdSchema,
  encryptedBackupEnvelopeSchema,
  backupUploadRequestSchema,
  backupStatusResponseSchema,
  safeParseContract,
} from '../index';

const VALID_LOOKUP_ID = 'a'.repeat(64);

const validEnvelope = {
  version: 1,
  algorithm: 'xchacha20poly1305' as const,
  kdfInfo: 'oxy-identity-backup-v1',
  nonce: 'b'.repeat(48),
  ciphertext: 'c'.repeat(128),
  publicKeyHint: '02a1b2',
  createdAt: '2026-07-16T12:00:00.000Z',
};

describe('backupLookupIdSchema', () => {
  it('accepts 64 hex characters', () => {
    expect(safeParseContract(backupLookupIdSchema, VALID_LOOKUP_ID)).toBe(VALID_LOOKUP_ID);
  });

  it('rejects short or non-hex locators', () => {
    expect(safeParseContract(backupLookupIdSchema, 'abc')).toBeNull();
    expect(safeParseContract(backupLookupIdSchema, 'g'.repeat(64))).toBeNull();
  });
});

describe('encryptedBackupEnvelopeSchema', () => {
  it('round-trips a valid envelope', () => {
    expect(safeParseContract(encryptedBackupEnvelopeSchema, validEnvelope)).toEqual(validEnvelope);
  });

  it('rejects wrong algorithm', () => {
    expect(
      safeParseContract(encryptedBackupEnvelopeSchema, {
        ...validEnvelope,
        algorithm: 'aes-gcm',
      }),
    ).toBeNull();
  });
});

describe('backupUploadRequestSchema', () => {
  it('round-trips envelope plus lookupId', () => {
    const payload = { ...validEnvelope, lookupId: VALID_LOOKUP_ID };
    expect(safeParseContract(backupUploadRequestSchema, payload)).toEqual(payload);
  });

  it('rejects upload without a valid lookupId', () => {
    expect(
      safeParseContract(backupUploadRequestSchema, {
        ...validEnvelope,
        lookupId: 'too-short',
      }),
    ).toBeNull();
  });
});

describe('backupStatusResponseSchema', () => {
  it('round-trips missing backup status', () => {
    expect(safeParseContract(backupStatusResponseSchema, { exists: false })).toEqual({
      exists: false,
    });
  });

  it('round-trips existing backup metadata', () => {
    const payload = {
      exists: true,
      publicKeyHint: '02a1b2',
      createdAt: '2026-07-16T12:00:00.000Z',
    };
    expect(safeParseContract(backupStatusResponseSchema, payload)).toEqual(payload);
  });
});
