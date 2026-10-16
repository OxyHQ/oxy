/**
 * Every `@oxy.so/contracts/client` check against the Zod schema it mirrors.
 *
 * The client entry answers "does this value have its contract's shape" without
 * Zod, and the SDK's runtime trusts those answers. This runs each check and its
 * schema over the same inputs — a valid sample, then that sample with every
 * field replaced, removed, padded, emptied and retyped, and with an unknown
 * key added — and requires the same verdict, the same output (keys stripped or
 * kept, values trimmed or lower-cased, defaults filled) and the same first
 * issue Zod reports — its path, code and message (and the type names of an
 * `invalid_type`), so copy a form shows from `issues[0].message`, and a log
 * that records `issues[0].code`, do not change either.
 *
 * The compile-time half — each check produces exactly its contract type — is
 * `exact<T>()` in `client/check.ts`, checked by `tsc`.
 */
import type { z } from 'zod';
import * as client from '../client';
import type { Check } from '../client/check';
import * as contracts from '../index';

type Sample = Record<string, unknown> | unknown[] | string | number;

interface Pair {
  name: string;
  check: Check<unknown>;
  schema: z.ZodTypeAny;
  samples: Sample[];
}

const HEX64 = 'a'.repeat(64);
const TICKET = 'A'.repeat(43);
const ISO = '2026-10-16T12:00:00.000Z';
const ISO_LATER = '2026-11-16T12:00:00Z';

const sessionState = {
  deviceId: 'dev-1',
  accounts: [
    { accountId: 'acc-1', sessionId: 'ses-1', authuser: 0 },
    { accountId: 'acc-2', sessionId: 'ses-2', authuser: 1, operatedByUserId: 'u-1' },
  ],
  activeAccountId: 'acc-1',
  revision: 3,
  updatedAt: 1_760_000_000_000,
};
const activeToken = { accessToken: 'tok', expiresAt: ISO };
const profile = { id: 'u-1', username: 'nate', name: { first: 'Nate', extra: 1 }, avatar: null };
const directory = {
  deviceId: 'dev-1',
  revision: 2,
  activeContextId: 'ctx-1',
  principals: [
    {
      id: 'p-1',
      userId: 'u-1',
      authuser: 0,
      user: profile,
      contexts: [
        {
          id: 'ctx-1',
          accountId: 'u-1',
          kind: 'personal',
          relationship: 'self',
          account: { id: 'u-1', username: 'nate', color: 'teal' },
          onDevice: true,
          available: true,
          active: true,
          lastUsedAt: null,
        },
      ],
    },
  ],
  updatedAt: 1_760_000_000_000,
};
const claims = {
  version: 1,
  audience: 'oxy-api/agent',
  action: 'agent_signin',
  accountId: 'acc-1',
  actorId: 'acc-1',
  authMethodId: null,
  publicKey: '04ab',
  payloadDigest: HEX64,
  challenge: HEX64,
  expiresAt: 1_760_000_000_000,
};
const reauth = { password: 'correct horse', totpCode: ' 123456 ' };
const organization = {
  name: '  Oxy  ',
  organizationType: 'business',
  legalName: null,
  websiteUrl: 'https://oxy.so',
  countryCode: 'ES',
  aliases: [{ alias: ' Oxy HQ ', kind: 'name_variant', language: 'en' }],
  accountId: 'org-1',
  username: 'oxy',
  avatar: null,
  verifiedDomains: ['oxy.so'],
  claimStatus: 'claimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: ISO,
  updatedAt: ISO,
};
const claim = {
  id: 'c-1',
  accountId: 'org-1',
  claimantUserId: 'u-1',
  status: 'pending',
  createdAt: ISO,
};
const claimDetail = {
  ...claim,
  evidenceReference: 'ticket-1',
  reviewEvidenceReference: null,
  reviewedAt: null,
};
const period = { start: ISO, end: ISO_LATER };
const benefit = {
  kind: 'quota',
  productId: 'p',
  key: 'k',
  unit: 'u',
  included: 5,
  combination: 'sum',
};

const supervision = {
  childAccountId: 'child',
  guardianAccountId: 'guardian',
  status: 'active',
  policyVersion: '2',
  consentVersion: '1',
  createdAt: ISO,
};
const invitation = {
  id: 'inv-1',
  childAccountId: 'child',
  guardianAccountId: 'guardian',
  status: 'pending',
  expiresAt: ISO_LATER,
  consentVersion: '1',
  createdAt: ISO,
};
const purchaseApproval = {
  operationId: 'op-1',
  resourceId: 'order-1',
  cartFingerprint: HEX64,
  summary: ' Two books ',
  merchantAccountIds: ['merchant-b', 'merchant-a'],
  lineItems: [
    {
      itemReference: 'sku-1',
      title: 'Book',
      optionsText: ' Paperback ',
      merchantAccountId: 'merchant-a',
      quantity: 2,
      unitAmountMinor: 400,
      lineAmountMinor: 800,
    },
    {
      itemReference: 'sku-2',
      title: 'Map',
      optionsText: '',
      merchantAccountId: 'merchant-b',
      quantity: 1,
      unitAmountMinor: 250,
      lineAmountMinor: 250,
    },
  ],
  shippingMinor: 150,
  taxMinor: 0,
  discountMinor: 50,
  roundingAdjustmentMinor: 0,
  paymentFingerprint: HEX64,
  amountMinor: 1150,
  currency: 'EUR',
  expiresAt: ISO_LATER,
  id: 'approval-1',
  childAccountId: 'child',
  applicationId: 'app-1',
  status: 'pending',
  createdAt: ISO,
  receiptReference: null,
};
const { lineItems: _lineItems, ...purchaseApprovalSummary } = purchaseApproval;

const PAIRS: Pair[] = [
  {
    name: 'deviceSessionState',
    check: client.deviceSessionStateCheck,
    schema: contracts.deviceSessionStateSchema,
    samples: [sessionState, { ...sessionState, accounts: [], activeAccountId: null }],
  },
  {
    name: 'deviceSessionSync',
    check: client.deviceSessionSyncCheck,
    schema: contracts.deviceSessionSyncSchema,
    samples: [
      { state: sessionState, activeToken },
      { state: sessionState, activeToken: null },
    ],
  },
  {
    name: 'deviceTokenMintResponse',
    check: client.deviceTokenMintResponseCheck,
    schema: contracts.deviceTokenMintResponseSchema,
    samples: [{ accessToken: 't', expiresAt: ISO, nextDeviceSecret: 's', state: sessionState }],
  },
  {
    name: 'sessionAccountsChangedEvent',
    check: client.sessionAccountsChangedEventCheck,
    schema: contracts.sessionAccountsChangedEventSchema,
    samples: [{ userId: 'u-1', revision: 0, reason: 'login' }],
  },
  {
    name: 'deviceBackgroundCredentialResponse',
    check: client.deviceBackgroundCredentialResponseCheck,
    schema: contracts.deviceBackgroundCredentialResponseSchema,
    samples: [{ deviceId: 'd', secret: 's', accountId: 'a', expiresAt: ISO }],
  },
  {
    name: 'deviceRegisterResponse',
    check: client.deviceRegisterResponseCheck,
    schema: contracts.deviceRegisterResponseSchema,
    samples: [{ deviceId: 'd', deviceSecret: 's' }],
  },
  {
    name: 'deviceJoinResponse',
    check: client.deviceJoinResponseCheck,
    schema: contracts.deviceJoinResponseSchema,
    samples: [{ deviceId: 'd', deviceSecret: 's' }],
  },
  {
    name: 'deviceJoinCodeResponse',
    check: client.deviceJoinCodeResponseCheck,
    schema: contracts.deviceJoinCodeResponseSchema,
    samples: [{ code: 'c', expiresIn: 60 }],
  },
  {
    name: 'deviceDirectory',
    check: client.deviceDirectoryCheck,
    schema: contracts.deviceDirectorySchema,
    samples: [directory, { ...directory, principals: [], activeContextId: null }],
  },
  {
    name: 'deviceActivateResponse',
    check: client.deviceActivateResponseCheck,
    schema: contracts.deviceActivateResponseSchema,
    samples: [{ directory, activeToken }],
  },
  {
    name: 'deviceDirectorySync',
    check: client.deviceDirectorySyncCheck,
    schema: contracts.deviceDirectorySyncSchema,
    samples: [{ directory, state: sessionState, activeToken: null }],
  },
  {
    name: 'userName',
    check: client.userNameCheck,
    schema: contracts.userNameSchema,
    samples: [{ first: 'Nate', full: 'Nate I', custom: { nested: true } }, {}],
  },
  {
    name: 'loginResult',
    check: client.loginResultCheck,
    schema: contracts.loginResultSchema,
    samples: [
      {
        sessionId: 's',
        deviceId: 'd',
        expiresAt: ISO,
        accessToken: 't',
        deviceSecret: 'x',
        securityAlert: { message: 'm', anomalies: [{ type: 't', reason: 'r', details: 'd' }] },
        user: { id: 'u', username: 'nate', avatar: 'a' },
      },
      { sessionId: 's', deviceId: 'd', expiresAt: ISO, user: { id: 'u' } },
    ],
  },
  {
    name: 'emailAddress',
    check: client.emailAddressCheck,
    schema: contracts.emailAddressSchema,
    samples: [' Nate@Oxy.SO ', 'a.b+c@sub.example.org', 'bad@', '.x@y.co', 'a..b@y.co', 'x@y.c'],
  },
  {
    name: 'emailTicket',
    check: client.emailTicketCheck,
    schema: contracts.emailTicketSchema,
    samples: [TICKET, ` ${TICKET} `, `${TICKET}=`],
  },
  {
    name: 'emailVerificationStartResponse',
    check: client.emailVerificationStartResponseCheck,
    schema: contracts.emailVerificationStartResponseSchema,
    samples: [{ verificationId: 'v', expiresAt: 1 }],
  },
  {
    name: 'emailVerificationConfirmResponse',
    check: client.emailVerificationConfirmResponseCheck,
    schema: contracts.emailVerificationConfirmResponseSchema,
    samples: [{ ticket: ` ${TICKET}`, expiresAt: 1 }],
  },
  {
    name: 'emailSignInStartResponse',
    check: client.emailSignInStartResponseCheck,
    schema: contracts.emailSignInStartResponseSchema,
    samples: [
      { requestId: 'r', requestSecret: TICKET, expiresAt: 5 },
      { requestId: 'r', requestSecret: TICKET, expiresAt: 5, retryLater: true },
    ],
  },
  {
    name: 'emailSignInLinkResponse',
    check: client.emailSignInLinkResponseCheck,
    schema: contracts.emailSignInLinkResponseSchema,
    samples: [{ approved: true }],
  },
  {
    name: 'secondFactorRequired',
    check: client.secondFactorRequiredCheck,
    schema: contracts.secondFactorRequiredSchema,
    samples: [{ secondFactorRequired: true, challengeId: TICKET, expiresAt: 9 }],
  },
  {
    name: 'emailSignInPending',
    check: client.emailSignInPendingCheck,
    schema: contracts.emailSignInPendingSchema,
    samples: [{ status: 'pending', expiresAt: 9 }],
  },
  {
    name: 'emailSignInChooseAccount',
    check: client.emailSignInChooseAccountCheck,
    schema: contracts.emailSignInChooseAccountSchema,
    samples: [
      {
        chooseAccount: true,
        accounts: [{ id: 'a', username: 'nate', displayName: 'Nate', avatar: 'x' }, { id: 'b' }],
        expiresAt: 9,
      },
    ],
  },
  {
    name: 'signInMethods',
    check: client.signInMethodsCheck,
    schema: contracts.signInMethodsSchema,
    samples: [{ hasEmail: true, hasPassword: false, totpEnabled: true, backupCodesRemaining: 4 }],
  },
  {
    name: 'totpEnrollResponse',
    check: client.totpEnrollResponseCheck,
    schema: contracts.totpEnrollResponseSchema,
    samples: [{ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Oxy:nate?secret=x' }],
  },
  {
    name: 'totpBackupCodesResponse',
    check: client.totpBackupCodesResponseCheck,
    schema: contracts.totpBackupCodesResponseSchema,
    samples: [{ backupCodes: Array.from({ length: 10 }, () => 'abcde-fghjk') }],
  },
  {
    name: 'reauthProof',
    check: client.reauthProofCheck,
    schema: contracts.reauthProofSchema,
    samples: [
      reauth,
      { emailCode: { verificationId: ' v ', code: ' 123456 ' } },
      { totpCode: '123456' },
    ],
  },
  {
    name: 'agentProofClaims',
    check: client.agentProofClaimsCheck,
    schema: contracts.agentProofClaimsSchema,
    samples: [claims],
  },
  {
    name: 'agentChallengeRequest',
    check: client.agentChallengeRequestCheck,
    schema: contracts.agentChallengeRequestSchema,
    samples: [{ publicKey: ' 04ab ' }],
  },
  {
    name: 'agentVerifyRequest',
    check: client.agentVerifyRequestCheck,
    schema: contracts.agentVerifyRequestSchema,
    samples: [{ challenge: HEX64, signature: 'ABCdef01', timestamp: 5, publicKey: '04ab' }],
  },
  {
    name: 'agentKeyOperation',
    check: client.agentKeyOperationCheck,
    schema: contracts.agentKeyOperationSchema,
    samples: [
      { operation: 'enroll', publicKey: ' 04ab ', label: ' bot key ' },
      { operation: 'recover', publicKey: '04ab', label: 'k' },
      { operation: 'rotate', publicKey: '04ab', label: 'k', retireCurrent: true },
      { operation: 'revoke', methodId: 'm-1' },
    ],
  },
  {
    name: 'executeAgentKeyOperation',
    check: client.executeAgentKeyOperationCheck,
    schema: contracts.executeAgentKeyOperationSchema,
    samples: [
      {
        operation: { operation: 'revoke', methodId: 'm-1' },
        proof: { challenge: HEX64, timestamp: 1, keySignature: 'ab', reauth },
      },
      {
        operation: { operation: 'enroll', publicKey: '04ab', label: 'k' },
        proof: { challenge: HEX64, timestamp: 1, governorSignature: 'CD' },
      },
    ],
  },
  {
    name: 'agentKeyOperationChallenge',
    check: client.agentKeyOperationChallengeCheck,
    schema: contracts.agentKeyOperationChallengeSchema,
    samples: [{ claims, governorPublicKey: null }],
  },
  {
    name: 'agentKeyOperationResult',
    check: client.agentKeyOperationResultCheck,
    schema: contracts.agentKeyOperationResultSchema,
    samples: [{ methodId: 'm', revokedMethodIds: ['a', 'b'] }],
  },
  {
    name: 'agentKeyListResponse',
    check: client.agentKeyListResponseCheck,
    schema: contracts.agentKeyListResponseSchema,
    samples: [
      {
        keys: [
          {
            id: 'k',
            publicKey: '04ab',
            label: 'l',
            enrolledByUserId: null,
            enrollmentMethod: 'governor',
            linkedAt: ISO,
            lastUsedAt: '2024-02-29T23:59:59.1Z',
            revokedAt: null,
          },
        ],
      },
      { keys: [] },
    ],
  },
  {
    name: 'identityLinkCreateResponse',
    check: client.identityLinkCreateResponseCheck,
    schema: contracts.identityLinkCreateResponseSchema,
    samples: [
      {
        linkId: ` ${'b'.repeat(32)} `,
        challenge: HEX64,
        expiresAt: 3,
        qrPayload: `oxycommons://link?id=${'b'.repeat(32)}&c=${HEX64}`,
      },
    ],
  },
  {
    name: 'identityLinkState',
    check: client.identityLinkStateCheck,
    schema: contracts.identityLinkStateSchema,
    samples: [
      {
        status: 'signed',
        userId: 'u',
        username: null,
        publicKey: '04ab',
        audience: 'mention',
        expiresAt: 4,
      },
    ],
  },
  {
    name: 'profileAccessInput',
    check: client.profileAccessInputCheck,
    schema: contracts.profileAccessInputSchema,
    samples: [{ subjectAccountId: 'acc-1' }],
  },
  {
    name: 'profileAccessDecision',
    check: client.profileAccessDecisionCheck,
    schema: contracts.profileAccessDecisionSchema,
    samples: [{ allowed: false, reason: 'blocked', policyVersion: '1' }],
  },
  {
    name: 'supervisionState',
    check: client.supervisionStateCheck,
    schema: contracts.supervisionStateSchema,
    samples: [
      {
        self: supervision,
        children: [{ ...supervision, guardianAccountId: null }],
        invitations: [invitation],
      },
      { self: null, children: [], invitations: [] },
    ],
  },
  {
    name: 'supervisionInvitation',
    check: client.supervisionInvitationCheck,
    schema: contracts.supervisionInvitationSchema,
    samples: [invitation],
  },
  {
    name: 'supervisionContactsResponse',
    check: client.supervisionContactsResponseCheck,
    schema: contracts.supervisionContactsResponseSchema,
    samples: [
      { items: [{ childAccountId: 'child', contactAccountId: 'friend', approvedAt: ISO }] },
    ],
  },
  {
    name: 'supervisionInviteInput',
    check: client.supervisionInviteInputCheck,
    schema: contracts.supervisionInviteInputSchema,
    samples: [{ guardianAccountId: 'guardian', consentVersion: '1', reauth }],
  },
  {
    name: 'supervisionAcceptInput',
    check: client.supervisionAcceptInputCheck,
    schema: contracts.supervisionAcceptInputSchema,
    samples: [{ consentVersion: '1', reauth }],
  },
  {
    name: 'supervisionContactInput',
    check: client.supervisionContactInputCheck,
    schema: contracts.supervisionContactInputSchema,
    samples: [{ childAccountId: 'child', contactAccountId: 'friend', reauth }],
  },
  {
    name: 'supervisionReviewInput',
    check: client.supervisionReviewInputCheck,
    schema: contracts.supervisionReviewInputSchema,
    samples: [
      {
        childAccountId: 'child',
        action: 'transfer',
        guardianAccountId: 'guardian-2',
        evidenceReference: ' case-1 ',
        reauth,
      },
      { childAccountId: 'child', action: 'end', evidenceReference: 'case-2', reauth },
    ],
  },
  {
    name: 'safetyPeopleInput',
    check: client.safetyPeopleInputCheck,
    schema: contracts.safetyPeopleInputSchema,
    samples: [{ query: ' na ' }, { accountIds: ['a', 'b'] }],
  },
  {
    name: 'safetyPeopleResponse',
    check: client.safetyPeopleResponseCheck,
    schema: contracts.safetyPeopleResponseSchema,
    samples: [{ items: [{ accountId: 'a', username: 'nate', displayName: null }] }, { items: [] }],
  },
  {
    name: 'safetyOrganizationsInput',
    check: client.safetyOrganizationsInputCheck,
    schema: contracts.safetyOrganizationsInputSchema,
    samples: [{ query: ' Acme ', limit: 5 }, { query: 'A' }, { ids: ['org-1', 'org-2'] }],
  },
  {
    name: 'safetyOrganizationsResponse',
    check: client.safetyOrganizationsResponseCheck,
    schema: contracts.safetyOrganizationsResponseSchema,
    samples: [
      {
        items: [
          {
            requestedAccountId: 'old',
            organization: {
              accountId: 'org',
              username: null,
              name: 'Acme',
              organizationType: 'business',
            },
          },
        ],
        missingIds: ['gone'],
      },
    ],
  },
  {
    name: 'purchaseApproval',
    check: client.purchaseApprovalCheck,
    schema: contracts.purchaseApprovalSchema,
    samples: [
      purchaseApproval,
      { ...purchaseApproval, roundingAdjustmentMinor: -1, amountMinor: 1149 },
    ],
  },
  {
    name: 'purchaseApprovalList',
    check: client.purchaseApprovalListCheck,
    schema: contracts.purchaseApprovalListSchema,
    samples: [
      { items: [purchaseApprovalSummary], nextCursor: 'next' },
      { items: [], nextCursor: null },
    ],
  },
  {
    name: 'purchaseReviewInput',
    check: client.purchaseReviewInputCheck,
    schema: contracts.purchaseReviewInputSchema,
    samples: [{ decision: 'approved', reauth }],
  },
  {
    name: 'recommendationRequest',
    check: client.recommendationRequestCheck,
    schema: contracts.recommendationRequestSchema,
    samples: [
      {
        clientId: ' mention ',
        limit: 20,
        offset: 0,
        excludeTypes: ['agent'],
        excludeIds: [' a '],
        boosts: [{ userIds: ['u'], weight: -2.5, reason: ' r ' }],
        signalWeights: { graph: 1, affinity: 9.5 },
      },
      {},
    ],
  },
  {
    name: 'signedRecordEnvelope',
    check: client.signedRecordEnvelopeCheck,
    schema: contracts.signedRecordEnvelopeSchema,
    samples: [
      {
        version: 1,
        type: 'profile',
        subject: 'did:oxy:u',
        issuer: 'did:oxy:u',
        record: { name: 'Nate', nested: { a: [1] } },
        issuedAt: 1,
        publicKey: '04ab',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
      },
      {
        version: 2,
        type: 'identity',
        subject: 's',
        issuer: 'i',
        record: {},
        issuedAt: 2,
        seq: 0,
        prev: null,
        collection: 'app.oxy.identity',
        rkey: 'self',
        publicKey: '04ab',
        alg: 'ES256K-DER-SHA256',
        signature: 'sig',
        extra: true,
      },
    ],
  },
  {
    name: 'externalIdentityReference',
    check: client.externalIdentityReferenceCheck,
    schema: contracts.externalIdentityReferenceSchema,
    samples: [
      {
        canonicalAcct: 'nate@mastodon.social',
        network: 'mastodon',
        protocol: 'activitypub',
        actorUri: 'https://mastodon.social/users/nate',
        transportAcct: 'nate@mastodon.social',
        sourceUserId: 'u-9',
      },
    ],
  },
  {
    name: 'publicApplication',
    check: client.publicApplicationCheck,
    schema: contracts.publicApplicationSchema,
    samples: [
      {
        id: 'app',
        name: 'Mention',
        description: 'd',
        type: 'first_party',
        isOfficial: true,
        isInternal: false,
        scopes: ['user:read'],
        developerName: 'Oxy',
      },
    ],
  },
  {
    name: 'username',
    check: client.usernameCheck,
    schema: contracts.usernameSchema,
    samples: [
      ' nate ',
      'ab',
      'a'.repeat(31),
      'na--te',
      '12345',
      'admin',
      'my-admin',
      'Alia',
      'ok_name1',
    ],
  },
  {
    name: 'botUsername',
    check: client.botUsernameCheck,
    schema: contracts.usernameSchemaForAccountKind('bot'),
    samples: ['helperbot', 'helper', 'admin-bot', 'x'],
  },
  {
    name: 'organizationName',
    check: client.organizationNameCheck,
    schema: contracts.organizationNameSchema,
    samples: [' Oxy ', '<b>', 'tab\there', '', 'a'.repeat(301)],
  },
  {
    name: 'createOrganization',
    check: client.createOrganizationCheck,
    schema: contracts.createOrganizationSchema,
    samples: [
      {
        name: ' Oxy ',
        organizationType: 'nonprofit',
        legalName: ' Oxy SL ',
        websiteUrl: 'http://oxy.so',
        countryCode: null,
        aliases: [{ alias: 'O', kind: 'former_name' }],
      },
      { name: 'Oxy', organizationType: 'other', websiteUrl: 'ftp://oxy.so' },
      { name: 'Oxy', organizationType: 'other', websiteUrl: 'not a url' },
    ],
  },
  {
    name: 'updateOrganization',
    check: client.updateOrganizationCheck,
    schema: contracts.updateOrganizationSchema,
    samples: [{ legalName: 'x' }, {}, { name: ' New ', countryCode: 'FR' }],
  },
  {
    name: 'organization',
    check: client.organizationCheck,
    schema: contracts.organizationSchema,
    samples: [organization],
  },
  {
    name: 'organizationList',
    check: client.organizationListCheck,
    schema: contracts.organizationListSchema,
    samples: [{ items: [organization], nextCursor: null }],
  },
  {
    name: 'organizationBatch',
    check: client.organizationBatchCheck,
    schema: contracts.organizationBatchSchema,
    samples: [{ items: [{ requestedAccountId: 'org-1', organization }], missingIds: ['x'] }],
  },
  {
    name: 'organizationClaimInput',
    check: client.organizationClaimInputCheck,
    schema: contracts.organizationClaimInputSchema,
    samples: [{ evidenceReference: ' ref ' }],
  },
  {
    name: 'organizationClaim',
    check: client.organizationClaimCheck,
    schema: contracts.organizationClaimSchema,
    samples: [claim],
  },
  {
    name: 'organizationClaimDetail',
    check: client.organizationClaimDetailCheck,
    schema: contracts.organizationClaimDetailSchema,
    samples: [claimDetail, { ...claimDetail, reviewedAt: ISO, reviewEvidenceReference: 'r' }],
  },
  {
    name: 'organizationClaimList',
    check: client.organizationClaimListCheck,
    schema: contracts.organizationClaimListSchema,
    samples: [{ items: [claimDetail], nextCursor: 'n' }],
  },
  {
    name: 'organizationClaimReview',
    check: client.organizationClaimReviewCheck,
    schema: contracts.organizationClaimReviewSchema,
    samples: [{ decision: 'approved', evidenceReference: 'e' }],
  },
  {
    name: 'organizationImportBatchResult',
    check: client.organizationImportBatchResultCheck,
    schema: contracts.organizationImportBatchResultSchema,
    samples: [{ items: [{ externalId: 'e', accountId: 'a', created: true }] }],
  },
  {
    name: 'organizationExternal',
    check: client.organizationExternalCheck,
    schema: contracts.organizationExternalSchema,
    samples: [{ accountId: 'a', created: false }],
  },
  {
    name: 'organizationExternalResolution',
    check: client.organizationExternalResolutionCheck,
    schema: contracts.organizationExternalResolutionSchema,
    samples: [{ accountId: 'a' }],
  },
  {
    name: 'organizationCurationResult',
    check: client.organizationCurationResultCheck,
    schema: contracts.organizationCurationResultSchema,
    samples: [{ accountId: 'a', status: 'suppressed' }],
  },
  {
    name: 'subjectProductAccessQuery',
    check: client.subjectProductAccessQueryCheck,
    schema: contracts.subjectProductAccessQuerySchema,
    samples: [{ schemaVersion: 1, subjectAccountId: 'acc', productId: 'mention' }],
  },
  {
    name: 'subjectProductAccess',
    check: client.subjectProductAccessCheck,
    schema: contracts.subjectProductAccessSchema,
    samples: [
      {
        schemaVersion: 1,
        subjectAccountId: 'acc',
        productId: 'mention',
        evaluatedAt: ISO,
        capabilities: [{ key: 'k', grantIds: ['g'] }],
        quotas: [{ key: 'k', unit: 'u', included: 3, combination: 'maximum', grantIds: [] }],
        conflicts: [{ key: 'k', reason: 'unit_mismatch', grantIds: ['g'] }],
      },
    ],
  },
  {
    name: 'personalPlanCatalogue',
    check: client.personalPlanCatalogueCheck,
    schema: contracts.personalPlanCatalogueSchema,
    samples: [
      { schemaVersion: 1, state: 'unconfigured', purchase: 'unavailable', plans: [] },
      {
        schemaVersion: 1,
        state: 'configured',
        purchase: 'available',
        plans: [
          {
            offerId: 'o',
            offerVersion: 1,
            displayName: 'Oxy One',
            audience: 'personal',
            kind: 'oxy_one',
            price: {
              currency: 'EUR',
              amountMinorUnits: 499,
              interval: 'month',
              trial: 'none',
              taxTreatment: 'inclusive',
              merchantTotal: 'final',
            },
            benefits: [
              { displayName: 'Cap', benefit: { kind: 'capability', productId: 'p', key: 'k' } },
              { displayName: 'Quota', benefit },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'personalPlanCheckoutRequest',
    check: client.personalPlanCheckoutRequestCheck,
    schema: contracts.personalPlanCheckoutRequestSchema,
    samples: [
      {
        expectedSubjectAccountId: 'acc',
        offerId: 'o',
        offerVersion: 2,
        idempotencyKey: 'key_1234',
      },
    ],
  },
  {
    name: 'productPlanCatalogue',
    check: client.productPlanCatalogueCheck,
    schema: contracts.productPlanCatalogueSchema,
    samples: [
      {
        schemaVersion: 1,
        productId: 'alia',
        purchase: 'available',
        plans: [
          {
            productId: 'alia',
            offerId: 'o',
            offerVersion: 1,
            displayName: 'Alia Pro',
            price: {
              currency: 'USD',
              amountMinorUnits: 9590,
              interval: 'year',
              trial: 'none',
              taxTreatment: 'inclusive',
              merchantTotal: 'final',
            },
          },
        ],
      },
    ],
  },
  {
    name: 'productPlanCheckoutRequest',
    check: client.productPlanCheckoutRequestCheck,
    schema: contracts.productPlanCheckoutRequestSchema,
    samples: [
      {
        expectedSubjectAccountId: 'acc',
        offerId: 'o',
        offerVersion: 2,
        idempotencyKey: 'key_1234',
        productId: 'alia',
      },
    ],
  },
  {
    name: 'productSubscriptionRenewalRequest',
    check: client.productSubscriptionRenewalRequestCheck,
    schema: contracts.productSubscriptionRenewalRequestSchema,
    samples: [{ expectedSubjectAccountId: 'acc', sourceId: 's', idempotencyKey: 'key_1234' }],
  },
  {
    name: 'personalPlanCheckoutResult',
    check: client.personalPlanCheckoutResultCheck,
    schema: contracts.personalPlanCheckoutResultSchema,
    samples: [
      { state: 'unconfigured', reason: 'price_unconfigured' },
      { state: 'pending', intentId: 'i', checkoutUrl: 'https://pay.oxy.so/x' },
      { state: 'pending', intentId: 'i', checkoutUrl: 'http://pay.oxy.so/x' },
      { state: 'closed', intentId: 'i' },
      { state: 'fulfilled', intentId: 'i' },
    ],
  },
  {
    name: 'productSubscriptionsResponse',
    check: client.productSubscriptionsResponseCheck,
    schema: contracts.productSubscriptionsResponseSchema,
    samples: [
      {
        subscriptions: [
          {
            sourceId: 's',
            status: 'active',
            period,
            cancelAtPeriodEnd: false,
            canCancel: true,
            canRenew: true,
            offers: [
              {
                segmentId: 'g',
                offerId: 'o',
                offerVersion: 1,
                displayName: 'One',
                origin: 'bundle',
                period,
                current: true,
                products: [{ id: 'p', displayName: 'Mention' }],
              },
            ],
          },
        ],
      },
      { subscriptions: [] },
    ],
  },
  {
    name: 'subscriptionCreditGrantsResponse',
    check: client.subscriptionCreditGrantsResponseCheck,
    schema: contracts.subscriptionCreditGrantsResponseSchema,
    samples: [
      {
        grants: [
          {
            id: 'g',
            invoiceId: 'i',
            origin: 'subscription_payment',
            period,
            granted: 10,
            consumed: 3,
            clawed: 2,
            remaining: 5,
            promotionId: null,
            createdAt: ISO,
          },
        ],
      },
    ],
  },
  {
    name: 'cancelProductSubscription',
    check: client.cancelProductSubscriptionCheck,
    schema: contracts.cancelProductSubscriptionSchema,
    samples: [
      { sourceId: 's' },
      { sourceId: 's', actionId: 'action-1', expectedSubjectAccountId: 'a' },
    ],
  },
  {
    name: 'productSubscriptionCancellationResult',
    check: client.productSubscriptionCancellationResultCheck,
    schema: contracts.productSubscriptionCancellationResultSchema,
    samples: [
      { sourceId: 's', cancelAtPeriodEnd: true },
      { sourceId: 's', reconciliationPending: true },
      { sourceId: 's', cancelAtPeriodEnd: true, reconciliationPending: true },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/*  Input generation                                                          */
/* -------------------------------------------------------------------------- */

const REPLACEMENTS: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  'x',
  'Mixed Case',
  'a'.repeat(400),
  0,
  -1,
  1.5,
  2 ** 60,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  [],
  ['x'],
  {},
  { unexpected: 1 },
];

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** Paths to every node of `value` below the root. */
function paths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => [
      [...prefix, index],
      ...paths(entry, [...prefix, index]),
    ]);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      [...prefix, key],
      ...paths(entry, [...prefix, key]),
    ]);
  }
  return [];
}

function read(root: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root);
}

/** `root` with the node at `path` replaced (`undefined` removes an object key). */
function replaced(root: unknown, path: (string | number)[], next: unknown): unknown {
  if (path.length === 0) return next;
  const copy = clone(root) as Record<string | number, unknown>;
  const parent = read(copy, path.slice(0, -1)) as Record<string | number, unknown>;
  const key = path[path.length - 1];
  if (next === undefined && !Array.isArray(parent)) delete parent[key];
  else parent[key] = next;
  return copy;
}

/** Variants of one leaf that stay close to valid: padded, re-cased, shortened, shifted. */
function nearby(value: unknown): unknown[] {
  if (typeof value === 'string') {
    return [` ${value} `, value.toUpperCase(), value.toLowerCase(), value.slice(1), `${value}!`];
  }
  if (typeof value === 'number') return [value + 0.5, -value, value + 1, 0];
  if (Array.isArray(value)) return [[], [...value, ...value], value.slice(1)];
  if (value && typeof value === 'object') return [{ ...value, unexpected: 1 }];
  return [];
}

function* inputs(sample: Sample): Generator<unknown> {
  yield sample;
  for (const replacement of [...REPLACEMENTS, ...nearby(sample)]) yield clone(replacement);
  for (const path of paths(sample)) {
    const current = read(sample, path);
    for (const replacement of [...REPLACEMENTS, ...nearby(current)]) {
      yield replaced(sample, path, clone(replacement));
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Comparison                                                                */
/* -------------------------------------------------------------------------- */

interface Outcome {
  ok: boolean;
  value?: unknown;
  /** The first issue: path, code, message, and the type names of an `invalid_type`. */
  issue?: Record<string, unknown>;
  threw?: boolean;
}

function firstIssue(issue: {
  path: (string | number)[];
  code: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}): Record<string, unknown> {
  return {
    path: issue.path,
    code: issue.code,
    message: issue.message,
    ...(issue.code === 'invalid_type'
      ? { expected: String(issue.expected), received: String(issue.received) }
      : {}),
  };
}

function viaZod(schema: z.ZodTypeAny, input: unknown): Outcome {
  try {
    const result = schema.safeParse(input);
    if (result.success) return { ok: true, value: result.data };
    const [issue] = result.error.issues;
    return { ok: false, issue: firstIssue(issue as Parameters<typeof firstIssue>[0]) };
  } catch (error) {
    // A refinement that throws on a value an earlier rule already rejected
    // (`BigInt(1.5)`); Zod surfaces the exception, the check reports a failure.
    if (error instanceof RangeError) return { ok: false, threw: true };
    throw error;
  }
}

function viaCheck(check: Check<unknown>, input: unknown): Outcome {
  const result = check(input, []);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, issue: firstIssue(result.issue) };
}

it('pairs every check with a schema the root entry exports', () => {
  for (const { name, check, schema } of PAIRS) {
    expect({ name, check: typeof check }).toEqual({ name, check: 'function' });
    expect({ name, schema: typeof schema?.safeParse }).toEqual({ name, schema: 'function' });
  }
});

describe.each(PAIRS)('$name check matches its Zod schema', ({ check, schema, samples }) => {
  it('gives the same verdict, output and failing path on every input', () => {
    let compared = 0;
    for (const sample of samples) {
      for (const input of inputs(sample)) {
        const expected = viaZod(schema, input);
        const actual = viaCheck(check, input);
        const context = JSON.stringify(input, (_key, value) =>
          value === undefined ? '<undefined>' : Number.isNaN(value) ? '<NaN>' : value,
        );
        expect({ input: context, ok: actual.ok }).toEqual({ input: context, ok: expected.ok });
        if (expected.ok) {
          expect(actual.value).toStrictEqual(expected.value);
        } else if (!expected.threw) {
          expect({ input: context, issue: actual.issue }).toEqual({
            input: context,
            issue: expected.issue,
          });
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(samples.length);
  });
});

it('covers both outcomes across the suite (the inputs are not all valid or all invalid)', () => {
  let passed = 0;
  let failed = 0;
  for (const { schema, samples } of PAIRS) {
    for (const sample of samples) {
      for (const input of inputs(sample)) {
        if (viaZod(schema, input).ok) passed++;
        else failed++;
      }
    }
  }
  expect(passed).toBeGreaterThan(500);
  expect(failed).toBeGreaterThan(5000);
});
