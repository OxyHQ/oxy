/**
 * The content-claim submission (ADR 0043 D10): what the API accepts is what
 * the Oxy website's form validates, and every refusal is a stable KEY under
 * `contentClaim.errors.*`, never English.
 */
import {
  CONTENT_CLAIM_COUNTER_NOTICE_LIMITS,
  CONTENT_CLAIM_COUNTER_NOTICE_VALIDATION_KEYS,
  CONTENT_CLAIM_LIMITS,
  CONTENT_CLAIM_VALIDATION_KEYS,
  contentClaimCounterNoticeSchema,
  contentClaimSubmissionSchema,
  isErasureRequest,
  isRightsClaim,
} from '../contentClaims';
import * as client from '../client';

const valid = {
  kind: 'copyright',
  contentUrls: ['https://cloud.oxy.so/64f1a2b3c4d5e6f708192a3b'],
  description: 'This photo is mine and was posted without my permission.',
  originalWorkUrl: 'https://ada.example/work',
  claimant: {
    name: '  Ada Lovelace ',
    email: 'ada@example.com',
    organization: 'Analytical Engines Ltd',
    relationship: 'rights_holder',
  },
  statements: { goodFaith: true, accurate: true },
  signature: 'Ada Lovelace',
};

function keysFor(input: unknown): Record<string, string> {
  const parsed = contentClaimSubmissionSchema.safeParse(input);
  if (parsed.success) return {};
  const keys: Record<string, string> = {};
  for (const issue of parsed.error.issues) keys[issue.path.join('.')] ??= issue.message;
  return keys;
}

describe('contentClaimSubmissionSchema', () => {
  it('accepts a complete claim, trimmed', () => {
    const parsed = contentClaimSubmissionSchema.parse(valid);
    expect(parsed.claimant.name).toBe('Ada Lovelace');
  });

  it('answers every refusal with a contentClaim.errors key', () => {
    const keys = keysFor({
      kind: 'spam',
      contentUrls: ['http://insecure.example', 'ftp://x', 'not a url'],
      description: 'short',
      originalWorkUrl: 'javascript:alert(1)',
      claimant: { name: '', email: 'nope', organization: 'x'.repeat(201), relationship: 'boss' },
      statements: { goodFaith: false, accurate: false },
      signature: '   ',
    });
    expect(keys).toEqual({
      kind: 'contentClaim.errors.kind',
      'contentUrls.0': 'contentClaim.errors.contentUrlInvalid',
      'contentUrls.1': 'contentClaim.errors.contentUrlInvalid',
      'contentUrls.2': 'contentClaim.errors.contentUrlInvalid',
      description: 'contentClaim.errors.descriptionShort',
      originalWorkUrl: 'contentClaim.errors.originalWorkUrl',
      'claimant.name': 'contentClaim.errors.name',
      'claimant.email': 'contentClaim.errors.email',
      'claimant.organization': 'contentClaim.errors.organization',
      'claimant.relationship': 'contentClaim.errors.relationship',
      'statements.goodFaith': 'contentClaim.errors.goodFaith',
      'statements.accurate': 'contentClaim.errors.accurate',
      signature: 'contentClaim.errors.signature',
    });
    for (const key of Object.values(keys)) {
      expect(CONTENT_CLAIM_VALIDATION_KEYS).toContain(key);
    }
  });

  it('bounds the URLs and the description', () => {
    expect(keysFor({ ...valid, contentUrls: [] })).toEqual({
      contentUrls: 'contentClaim.errors.contentUrlsRequired',
    });
    expect(
      keysFor({
        ...valid,
        contentUrls: Array.from(
          { length: CONTENT_CLAIM_LIMITS.maxUrls + 1 },
          (_, i) => `https://x.example/${i}`,
        ),
      }),
    ).toEqual({ contentUrls: 'contentClaim.errors.contentUrlsTooMany' });
    expect(
      keysFor({ ...valid, description: 'x'.repeat(CONTENT_CLAIM_LIMITS.maxDescription + 1) }),
    ).toEqual({
      description: 'contentClaim.errors.descriptionLong',
    });
    expect(
      keysFor({
        ...valid,
        contentUrls: [`https://x.example/${'a'.repeat(CONTENT_CLAIM_LIMITS.maxUrlLength)}`],
      }),
    ).toEqual({ 'contentUrls.0': 'contentClaim.errors.contentUrlInvalid' });
  });

  it('is strict: an unknown key is refused, not dropped', () => {
    const parsed = contentClaimSubmissionSchema.safeParse({ ...valid, extra: true });
    expect(parsed.success).toBe(false);
    expect(
      contentClaimSubmissionSchema.safeParse({
        ...valid,
        claimant: { ...valid.claimant, phone: '1' },
      }).success,
    ).toBe(false);
  });

  it('names erasure requests and rights claims', () => {
    expect(isErasureRequest('privacy', 'affected_person')).toBe(true);
    expect(isErasureRequest('privacy', 'authorized_agent')).toBe(false);
    expect(isErasureRequest('copyright', 'affected_person')).toBe(false);
    expect(isRightsClaim('trademark')).toBe(true);
    expect(isRightsClaim('privacy')).toBe(false);
  });

  it('carries its constants on the Zod-free client entry', () => {
    expect(client.CONTENT_CLAIM_KINDS).toEqual([
      'copyright',
      'trademark',
      'privacy',
      'illegal_content',
      'other',
    ]);
    expect(client.CONTENT_CLAIM_LIMITS).toBe(CONTENT_CLAIM_LIMITS);
    expect(
      [...client.OPEN_CONTENT_CLAIM_STATES, ...client.CLOSED_CONTENT_CLAIM_STATES].sort(),
    ).toEqual([...client.CONTENT_CLAIM_STATES].sort());
  });
});

describe('contentClaimCounterNoticeSchema', () => {
  const notice = {
    reference: 'oxy-7k3m-9q2d',
    subscriber: {
      name: 'Grace Hopper',
      address: '1 Harbor Way, Arlington, VA 22201, USA',
      phone: '+1 (555) 010-2030',
      email: 'grace@example.com',
    },
    material: {
      description: 'A photo of my own garden that I took and uploaded.',
      location: 'https://mention.earth/@grace/posts/1',
    },
    explanation: 'I took this photo myself; the claimant has mistaken it for theirs.',
    statements: { perjury: true, jurisdiction: true, serviceOfProcess: true, disclosure: true },
    signature: 'Grace Hopper',
  };

  function noticeKeys(input: unknown): Record<string, string> {
    const parsed = contentClaimCounterNoticeSchema.safeParse(input);
    if (parsed.success) return {};
    const keys: Record<string, string> = {};
    for (const issue of parsed.error.issues) keys[issue.path.join('.')] ??= issue.message;
    return keys;
  }

  it('accepts a complete notice and normalizes the reference', () => {
    const parsed = contentClaimCounterNoticeSchema.parse(notice);
    expect(parsed.reference).toBe('OXY-7K3M-9Q2D');
    expect(
      contentClaimCounterNoticeSchema.safeParse({
        ...notice,
        reference: undefined,
        fileIds: ['f1'],
      }).success,
    ).toBe(true);
  });

  it('needs the claim named by reference, id or files', () => {
    expect(noticeKeys({ ...notice, reference: undefined })).toEqual({
      reference: 'contentClaim.counterNotice.errors.claim',
    });
  });

  it('answers every refusal with a contentClaim.counterNotice.errors key', () => {
    const keys = noticeKeys({
      reference: 'OXY-IIII-0000',
      claimId: 'not-a-uuid',
      fileIds: [],
      subscriber: { name: '', address: ' ', phone: 'call me', email: 'nope' },
      material: { description: 'short', location: '' },
      explanation: 'too short',
      statements: {
        perjury: false,
        jurisdiction: false,
        serviceOfProcess: false,
        disclosure: false,
      },
      signature: ' ',
    });
    expect(keys).toEqual({
      reference: 'contentClaim.counterNotice.errors.reference',
      claimId: 'contentClaim.counterNotice.errors.claimId',
      fileIds: 'contentClaim.counterNotice.errors.fileIds',
      'subscriber.name': 'contentClaim.counterNotice.errors.name',
      'subscriber.address': 'contentClaim.counterNotice.errors.address',
      'subscriber.phone': 'contentClaim.counterNotice.errors.phone',
      'subscriber.email': 'contentClaim.counterNotice.errors.email',
      'material.description': 'contentClaim.counterNotice.errors.materialDescription',
      'material.location': 'contentClaim.counterNotice.errors.materialLocation',
      explanation: 'contentClaim.counterNotice.errors.explanation',
      'statements.perjury': 'contentClaim.counterNotice.errors.perjury',
      'statements.jurisdiction': 'contentClaim.counterNotice.errors.jurisdiction',
      'statements.serviceOfProcess': 'contentClaim.counterNotice.errors.serviceOfProcess',
      'statements.disclosure': 'contentClaim.counterNotice.errors.disclosure',
      signature: 'contentClaim.counterNotice.errors.signature',
    });
    for (const key of Object.values(keys)) {
      expect(CONTENT_CLAIM_COUNTER_NOTICE_VALIDATION_KEYS).toContain(key);
    }
  });

  it('is strict and bounded', () => {
    expect(contentClaimCounterNoticeSchema.safeParse({ ...notice, extra: 1 }).success).toBe(false);
    expect(
      noticeKeys({
        ...notice,
        fileIds: Array.from(
          { length: CONTENT_CLAIM_COUNTER_NOTICE_LIMITS.maxFileIds + 1 },
          (_, i) => `f${i}`,
        ),
      }),
    ).toEqual({ fileIds: 'contentClaim.counterNotice.errors.fileIds' });
  });

  it('carries its statements, their version and its limits on the client entry', () => {
    expect(Object.keys(client.COUNTER_NOTICE_STATEMENTS).sort()).toEqual([
      'disclosure',
      'jurisdiction',
      'perjury',
      'serviceOfProcess',
    ]);
    expect(client.COUNTER_NOTICE_STATEMENTS.perjury).toMatch(/penalty of perjury/);
    expect(client.COUNTER_NOTICE_STATEMENTS.jurisdiction).toMatch(/Federal District Court/);
    expect(client.COUNTER_NOTICE_STATEMENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(client.CONTENT_CLAIM_COUNTER_NOTICE_LIMITS).toBe(CONTENT_CLAIM_COUNTER_NOTICE_LIMITS);
    expect(client.CONTENT_CLAIM_REFERENCE_PATTERN.test('OXY-7K3M-9Q2D')).toBe(true);
    expect(client.CONTENT_CLAIM_REFERENCE_PATTERN.test('OXY-7K3M-9Q2U')).toBe(false);
  });
});
