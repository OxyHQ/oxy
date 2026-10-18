/**
 * `@oxy.so/contracts/client` — the contracts without Zod, for client bundles.
 *
 * The root entry is the contract: Zod schemas the API parses with, and the
 * types inferred from them. Zod's runtime is ~120 KB of JavaScript, evaluated
 * at startup, that a client only needed to answer "does this response have
 * the shape its type promises". This entry answers that with small structural
 * checks (`*Check`, used through {@link checkContract} / {@link parseContract}),
 * and carries the constants and pure helpers clients use, so an app or SDK
 * that imports only from here ships no Zod at all.
 *
 * Every check is the twin of one schema in the root entry: it is tied to the
 * schema's type at compile time (`exact` in `./check.ts`) and to its runtime
 * behaviour by `__tests__/clientChecks.parity.test.ts`. Types are not repeated
 * here; import them from `@oxy.so/contracts` with `import type`.
 */

export {
  type Check,
  type CheckIssue,
  type CheckPath,
  type CheckResult,
  ContractCheckError,
  checkContract,
  formatCheckPath,
  parseContract,
} from './check';

export {
  ACCOUNT_CATEGORY_IDS,
  ACCOUNT_CATEGORY_KINDS,
  ACCOUNT_KINDS,
  CHILD_ACCOUNT_KINDS,
  MAX_ACCOUNT_CATEGORIES,
  RETIRED_ACCOUNT_CATEGORY_IDS,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  isAccountKind,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
  isSelectableAccountCategoryId,
  kindAcceptsAccountCategories,
  newlyAddedRetiredCategories,
} from './accountGraph';

export {
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  EMAIL_TICKET_TTL_MS,
  EMAIL_VERIFICATION_ERROR_CODES,
  EMAIL_VERIFICATION_PURPOSES,
  emailAddressCheck,
  emailTicketCheck,
  emailVerificationConfirmResponseCheck,
  emailVerificationStartResponseCheck,
} from './accountEmail';

export {
  ACCOUNT_AUTH_METHODS,
  AGENT_PROOF_ACTIONS,
  AGENT_PROOF_AUDIENCE,
  AGENT_PROOF_TTL_MS,
  agentChallengeRequestCheck,
  agentKeyListResponseCheck,
  agentKeyOperationChallengeCheck,
  agentKeyOperationCheck,
  agentKeyOperationResultCheck,
  agentProofClaimsCheck,
  agentVerifyRequestCheck,
  executeAgentKeyOperationCheck,
} from './agentKeys';

export { isLoopbackOrigin } from '../capabilityBindings';

export { loginResultCheck } from './deviceBoot';

export { externalIdentityReferenceCheck } from './externalIdentity';

export { signedRecordEnvelopeCheck } from './identity';

export {
  deviceActivateResponseCheck,
  deviceDirectoryCheck,
  deviceDirectorySyncCheck,
} from './deviceDirectory';

export {
  SESSION_ACCOUNTS_CHANGED_EVENT,
  activeTokenCheck,
  deviceBackgroundCredentialResponseCheck,
  deviceJoinCodeResponseCheck,
  deviceJoinResponseCheck,
  deviceRegisterResponseCheck,
  deviceSessionStateCheck,
  deviceSessionSyncCheck,
  deviceTokenMintResponseCheck,
  sessionAccountsChangedEventCheck,
} from './deviceSession';

export {
  IDENTITY_LINK_QR_PREFIX,
  IDENTITY_LINK_STATUSES,
  buildIdentityLinkQrPayload,
  identityLinkCreateResponseCheck,
  identityLinkStateCheck,
  parseIdentityLinkQrPayload,
} from './identityLink';

export {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_PROOF_ACTION_VALUES,
  IDENTITY_PROOF_AUDIENCE,
  IDENTITY_PROOF_CHALLENGE_TTL_MS,
  IDENTITY_PROOF_DOMAIN,
  IDENTITY_PROOF_VERSION,
  buildIdentityProofMessage,
  canonicalJson,
} from './identityProof';

export {
  ORGANIZATION_ALIAS_KINDS,
  ORGANIZATION_CLAIM_DECISIONS,
  ORGANIZATION_CLAIM_STATUSES,
  ORGANIZATION_ERROR_CODES,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  createOrganizationCheck,
  organizationBatchCheck,
  organizationCheck,
  organizationClaimCheck,
  organizationClaimDetailCheck,
  organizationClaimInputCheck,
  organizationClaimListCheck,
  organizationClaimReviewCheck,
  organizationCurationResultCheck,
  organizationExternalCheck,
  organizationExternalResolutionCheck,
  organizationImportBatchResultCheck,
  organizationListCheck,
  organizationNameCheck,
  updateOrganizationCheck,
} from './organizations';

export {
  cancelProductSubscriptionCheck,
  personalPlanCatalogueCheck,
  personalPlanCheckoutRequestCheck,
  personalPlanCheckoutResultCheck,
  productPlanCatalogueCheck,
  productPlanCheckoutRequestCheck,
  productSubscriptionCancellationResultCheck,
  productSubscriptionRenewalRequestCheck,
  productSubscriptionsResponseCheck,
  subjectProductAccessCheck,
  subjectProductAccessQueryCheck,
  subscriptionCreditGrantsResponseCheck,
} from './products';

export { recommendationRequestCheck } from './recommendations';

export { isFullReputationBalance } from './reputation';

export {
  PURCHASE_APPROVAL_STATUSES,
  SAFETY_POLICY_VERSION,
  SUPERVISED_ACTIONS,
  SUPERVISION_CONSENT_VERSION,
  SUPERVISION_INVITATION_STATUSES,
  SUPERVISION_STATUSES,
  profileAccessDecisionCheck,
  profileAccessInputCheck,
  purchaseApprovalCheck,
  purchaseApprovalListCheck,
  purchaseReviewInputCheck,
  safetyOrganizationsInputCheck,
  safetyOrganizationsResponseCheck,
  safetyPeopleInputCheck,
  safetyPeopleResponseCheck,
  supervisionAcceptInputCheck,
  supervisionContactInputCheck,
  supervisionContactsResponseCheck,
  supervisionInvitationCheck,
  supervisionInviteInputCheck,
  supervisionReviewInputCheck,
  supervisionStateCheck,
} from './safety';

export { publicApplicationCheck } from './sessionStatus';

export {
  EMAIL_ACCOUNTS_MAX,
  EMAIL_SIGNIN_CHOICE_TTL_MS,
  EMAIL_SIGNIN_LINK_TTL_MS,
  EMAIL_SIGNIN_LONG_CODE_ALPHABET,
  EMAIL_SIGNIN_LONG_CODE_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REAUTH_ACTIONS,
  SIGNIN_SECOND_FACTOR_MAX_ATTEMPTS,
  SIGNIN_SECOND_FACTOR_TTL_MS,
  SIGN_IN_ERROR_CODES,
  TOTP_BACKUP_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  emailSignInChooseAccountCheck,
  emailSignInLinkResponseCheck,
  emailSignInPendingCheck,
  emailSignInStartResponseCheck,
  isEmailSignInChooseAccount,
  isSecondFactorRequired,
  normalizeEmailSignInCode,
  reauthProofCheck,
  secondFactorRequiredCheck,
  signInMethodsCheck,
  totpBackupCodesResponseCheck,
  totpEnrollResponseCheck,
} from './signIn';

export {
  BOT_USERNAME_INVALID_MESSAGE,
  BOT_USERNAME_SUFFIX,
  NUMERIC_USERNAME_MESSAGE,
  RESERVED_USERNAMES,
  RESERVED_USERNAME_MESSAGE,
  USERNAME_INVALID_MESSAGE,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN_SOURCE,
  applyBotUsernameSuffix,
  botUsernameCheck,
  stripDisallowedUsernameCharacters,
  usernameCheck,
  usernameCheckForAccountKind,
} from './username';

export { userNameCheck } from './userResponse';

export {
  CLAIMANT_RELATIONSHIPS,
  CLOSED_CONTENT_CLAIM_STATES,
  CONTENT_CLAIM_COUNTER_NOTICE_LIMITS,
  CONTENT_CLAIM_ERROR_CODES,
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_LIMITS,
  CONTENT_CLAIM_REFERENCE_PATTERN,
  CONTENT_CLAIM_STATES,
  COUNTER_NOTICE_STATEMENT_VERSION,
  COUNTER_NOTICE_STATEMENTS,
  ERASURE_REQUEST_DEADLINE_DAYS,
  OPEN_CONTENT_CLAIM_STATES,
  isErasureRequest,
  isRightsClaim,
} from './contentClaims';

export {
  APP_ASSERTION_CHALLENGE_PURPOSES,
  APP_ASSERTION_ERROR_CODES,
  APP_ASSERTION_PLATFORMS,
  OXY_APP_ASSERTION_AUDIENCE,
  OXY_APP_ASSERTION_HEADER,
  OXY_APP_ASSERTION_TTL_SECONDS,
  OXY_APP_ASSERTION_TYPE,
  appAssertionChallengeResponseCheck,
  appAssertionResponseCheck,
  appAttestKeyResponseCheck,
} from './appAssertions';

export * from '../products/one';
