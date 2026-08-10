/**
 * @oxyhq/contracts — single source of truth for API request/response contracts.
 *
 * Zod schemas plus their inferred types, shared by the backend (`@oxyhq/api`)
 * and the client SDKs (`@oxyhq/core`, `@oxyhq/services`). The
 * producer validates its output and every consumer validates its input against
 * exactly the same definitions, so the wire shape cannot drift.
 *
 * Platform-agnostic — zod is the only runtime dependency. No react/react-native/
 * expo, no `require()` in the ESM build.
 */

export {
    ACCOUNT_KINDS,
    accountKindSchema,
    CHILD_ACCOUNT_KINDS,
    childAccountKindSchema,
    isAccountKind,
    isActAsEligibleKind,
    ACCOUNT_CATEGORY_IDS,
    ACCOUNT_CATEGORY_KINDS,
    accountCategoriesSchema,
    accountCategoryIdSchema,
    isSelectableAccountCategoryId,
    kindAcceptsAccountCategories,
    MAX_ACCOUNT_CATEGORIES,
    newlyAddedRetiredCategories,
    RETIRED_ACCOUNT_CATEGORY_IDS,
    SELECTABLE_ACCOUNT_CATEGORY_IDS,
    createAccountRequestSchema,
} from './accountGraph';

export type {
    AccountKind,
    AccountCategoryId,
    AccountCategoryKind,
    ChildAccountKind,
    CreateAccountRequest,
} from './accountGraph';

export {
    // Schemas
    userNameSchema,
    userRelationshipSchema,
    themePreferenceSchema,
    userResponseSchema,
    userProfileUpdateSchema,
    currentUserResponseSchema,
    deviceLinkedSessionSchema,
    deviceLinkedSessionsResponseSchema,
    // Helpers
    resolveUserId,
    safeParseContract,
} from './userResponse';

export type {
    UserNameResponse,
    UserRelationship,
    ThemePreference,
    UserResponse,
    UserProfileUpdate,
    CurrentUserResponseContract,
    DeviceLinkedSessionResponse,
    DeviceLinkedSessionsResponseContract,
} from './userResponse';

export {
    // Schemas
    applicationTypeSchema,
    publicApplicationSchema,
    sessionStatusSchema,
} from './sessionStatus';

export type {
    ApplicationTypeContract,
    PublicApplicationResponse,
    SessionStatusResponse,
} from './sessionStatus';

export {
    // Closed set of denial reasons for POST /auth/session/deny/:authorizeCode —
    // shared by the API request schema, the persisted `AuthSession.deniedReason`
    // enum, and the SDK's `denyCommonsSignIn`.
    COMMONS_DENY_REASONS,
    commonsDenyReasonSchema,
    IDENTITY_APPROVAL_PUSH_CHANNEL,
} from './commonsSignIn';

export type { CommonsDenyReason } from './commonsSignIn';

export {
    INBOX_EMAIL_PUSH_CHANNEL,
    INBOX_EMAIL_PUSH_TYPE,
    inboxEmailPushDataSchema,
} from './inboxPush';

export type { InboxEmailPushData } from './inboxPush';

export {
    OXY_USER_INVALIDATION_CHANNEL,
    OXY_USER_CHANGE_REASONS,
    OXY_PUBLISHED_USER_CHANGE_REASONS,
    isPublishedOxyUserChangeReason,
    oxyUserInvalidationEventSchema,
} from './userInvalidation';

export type {
    OxyUserChangeReason,
    PublishedOxyUserChangeReason,
    OxyUserInvalidationEvent,
} from './userInvalidation';

export {
    // Schemas
    recommendationExcludeTypeSchema,
    recommendationBoostSchema,
    recommendationSignalWeightsSchema,
    recommendationRequestSchema,
    recommendationCountSchema,
    recommendationItemSchema,
    recommendationResponseSchema,
    appEndorsementInputSchema,
    appInterestInputSchema,
    appUserSignalIngestSchema,
    appAffinityEventTypeSchema,
    appAffinityEventSchema,
    appAffinityEventsIngestSchema,
} from './recommendations';

export type {
    RecommendationExcludeType,
    RecommendationBoost,
    RecommendationSignalWeights,
    RecommendationRequest,
    RecommendationCount,
    RecommendationItem,
    RecommendationResponse,
    AppEndorsementInput,
    AppInterestInput,
    AppUserSignalIngest,
    AppAffinityEventType,
    AppAffinityEvent,
    AppAffinityEventsIngest,
} from './recommendations';

export {
    // Schemas
    verificationMethodSchema,
    didServiceSchema,
    didDocumentSchema,
    signedRecordEnvelopeSchema,
    verifiedDomainSchema,
    domainVerificationRequestSchema,
    domainVerificationInstructionsSchema,
    authMethodEntrySchema,
    authMethodsResponseSchema,
    exportAttestationSchema,
    exportBundleSchema,
} from './identity';

export type {
    VerificationMethod,
    Secp256k1VerificationMethod,
    MultikeyVerificationMethod,
    DidService,
    DidDocument,
    SignedRecordEnvelope,
    VerifiedDomain,
    DomainVerificationRequest,
    DomainVerificationInstructions,
    AuthMethodEntry,
    AuthMethodsResponse,
    ExportAttestation,
    ExportBundle,
} from './identity';

export {
    // Schemas
    oxySignedRecordTypeSchema,
} from './oxyRecordTypes';

export type {
    OxySignedRecordType,
} from './oxyRecordTypes';

export {
    // Schemas
    chainHeadResponseSchema,
    logPageResponseSchema,
} from './protocol';

export type {
    LexiconRecord,
    ChainHeadResponse,
    LogPageResponse,
} from './protocol';

export {
    // Schemas
    publicCardSchema,
    signedPublicCardSchema,
    realLifeAttestationRecordSchema,
    realLifeAttestationResultSchema,
    validationVerdictRecordSchema,
    validationOpenRequestSchema,
    validationOpenResultSchema,
    validationRequestSummarySchema,
    validationVoteResultSchema,
    personhoodVouchRecordSchema,
    personhoodBreakdownSchema,
    personhoodStatusResultSchema,
    vouchResultSchema,
    // Verifiable Credentials (Fase 4 — NEW)
    credentialRecordSchema,
    verifiableCredentialResponseSchema,
    credentialIssueResultSchema,
    credentialListResultSchema,
    credentialVerifyResultSchema,
} from './civic';

export type {
    CardTrustTier,
    PersonhoodStatus,
    PublicCard,
    SignedPublicCard,
    RealLifeAttestationRecord,
    RealLifeAttestationResult,
    ValidationVerdict,
    ValidationRequestStatus,
    ValidationVerdictRecord,
    ValidationOpenRequest,
    ValidationOpenResult,
    ValidationRequestSummary,
    ValidationVoteResult,
    PersonhoodVouchRecord,
    PersonhoodBreakdown,
    PersonhoodStatusResult,
    VouchResult,
    // Verifiable Credentials (Fase 4 — NEW)
    CredentialStatus,
    CredentialRecord,
    VerifiableCredentialResponse,
    CredentialIssueResult,
    CredentialListResult,
    CredentialVerifyResult,
} from './civic';

export {
    // Closed value sets — shared by the API's mongoose enums, the API's request
    // validation, and the SDK's unions, so a new category/tier/status cannot be
    // added on one side only.
    REPUTATION_CATEGORIES,
    REPUTATION_TRANSACTION_STATUSES,
    TRUST_TIERS,
    REPUTATION_TARGET_ENTITY_TYPES,
    REPUTATION_DISPUTE_STATUSES,
    REPUTATION_INFLUENCE_CONTEXTS,
    // Schemas — closed value sets
    reputationCategorySchema,
    reputationTransactionStatusSchema,
    trustTierSchema,
    reputationTargetEntityTypeSchema,
    reputationDisputeStatusSchema,
    reputationInfluenceContextSchema,
    // Schemas — responses
    reputationTransactionSchema,
    reputationBalanceBreakdownSchema,
    reputationInfluenceSchema,
    reputationReliabilitySchema,
    reputationBalanceSummarySchema,
    reputationBalanceSchema,
    reputationDisputeSchema,
    reputationRuleSchema,
    reputationLeaderboardUserSchema,
    reputationLeaderboardEntrySchema,
    reputationInfluenceResultSchema,
    reverseReputationTransactionResultSchema,
    // Schemas — request bodies
    awardReputationSchema,
    createReputationDisputeSchema,
    resolveReputationDisputeSchema,
    upsertReputationRuleSchema,
    reverseReputationTransactionSchema,
    // Narrows the two balance views apart at runtime.
    isFullReputationBalance,
} from './reputation';

export type {
    ReputationCategory,
    ReputationTransactionStatus,
    TrustTier,
    ReputationTargetEntityType,
    ReputationDisputeStatus,
    ReputationInfluenceContext,
    ReputationTransaction,
    ReputationBalanceBreakdown,
    ReputationInfluence,
    ReputationReliability,
    ReputationBalanceSummary,
    ReputationBalance,
    ReputationBalanceView,
    ReputationDispute,
    ReputationRule,
    ReputationLeaderboardUser,
    ReputationLeaderboardEntry,
    ReputationInfluenceResult,
    ReverseReputationTransactionResult,
    AwardReputationInput,
    CreateReputationDisputeInput,
    ResolveReputationDisputeInput,
    UpsertReputationRuleInput,
    UpsertReputationRuleRequest,
    ReverseReputationTransactionInput,
} from './reputation';

export {
    // Closed value sets — the moderation reputation bridge (CrowdSource → Oxy Trust).
    MODERATION_SEVERITIES,
    MODERATION_FINDING_SCOPES,
    MODERATION_ATTRIBUTIONS,
    MODERATION_DECISION_STATUSES,
    MODERATION_EFFECT_TYPES,
    MODERATION_EFFECT_STATUSES,
    MODERATION_EFFECT_SKIP_REASONS,
    CONDUCT_STRIKE_STATUSES,
    CONDUCT_STANDINGS,
    CONTRIBUTION_TIERS,
    PERSONHOOD_STATUSES,
    IDENTITY_BINDING_TYPES,
    IDENTITY_BINDING_STATUSES,
    APPLICATION_MODERATION_STANDINGS,
    // Schemas — closed value sets
    moderationSeveritySchema,
    moderationFindingScopeSchema,
    moderationAttributionSchema,
    moderationDecisionStatusSchema,
    moderationEffectTypeSchema,
    moderationEffectStatusSchema,
    moderationEffectSkipReasonSchema,
    conductStrikeStatusSchema,
    conductStandingSchema,
    contributionTierSchema,
    personhoodStatusSchema,
    identityBindingTypeSchema,
    identityBindingStatusSchema,
    applicationModerationStandingSchema,
    // Schemas — the event and its receipt
    moderationFindingSchema,
    moderationDecisionEventSubjectSchema,
    moderationPolicyVersionsSchema,
    moderationDecisionEventSchema,
    finalizeModerationDecisionSchema,
    reverseModerationEffectSchema,
    moderationEffectSchema,
    applyModerationDecisionResultSchema,
    reverseModerationEffectResultSchema,
    // Schemas — identity binding
    registerIdentityBindingSchema,
    identityBindingSchema,
    // Schemas — the derived V2 axes
    reputationPersonhoodSchema,
    reputationContributionSchema,
    reputationConductSchema,
    reputationReportingSchema,
    reputationReviewingSchema,
    reputationContextualInfluenceSchema,
    applicationModerationTrustSchema,
} from './moderationReputation';

export type {
    ModerationSeverity,
    ModerationFindingScope,
    ModerationAttribution,
    ModerationDecisionStatus,
    ModerationEffectType,
    ModerationEffectStatus,
    ModerationEffectSkipReason,
    ConductStrikeStatus,
    ConductStanding,
    ContributionTier,
    PersonhoodStatusValue,
    IdentityBindingType,
    IdentityBindingStatus,
    ApplicationModerationStanding,
    ModerationFinding,
    ModerationDecisionEventSubject,
    ModerationPolicyVersions,
    ModerationDecisionEvent,
    FinalizeModerationDecisionInput,
    ReverseModerationEffectInput,
    ModerationEffect,
    ApplyModerationDecisionResult,
    ReverseModerationEffectResult,
    RegisterIdentityBindingInput,
    IdentityBinding,
    ReputationPersonhood,
    ReputationContribution,
    ReputationConduct,
    ReputationReporting,
    ReputationReviewing,
    ReputationContextualInfluence,
    ApplicationModerationTrust,
} from './moderationReputation';

export {
    // Schemas
    linkPreviewSchema,
    linkPreviewBatchRequestSchema,
    linkPreviewBatchResponseSchema,
    linkPreviewResponseSchema,
} from './links';

export type {
    LinkPreviewStatus,
    LinkPreview,
    LinkPreviewBatchRequest,
    LinkPreviewBatchResponse,
} from './links';

export type {
    FollowTargetKind,
    FollowState,
    FollowEffectiveState,
    FollowApplicationMode,
    FollowTarget,
    FollowRecord,
    FollowStatus,
    FollowMutation,
    UnfollowMutation,
    FollowListPage,
    FollowOptions,
} from './followGraph';

export {
    sessionAccountSchema,
    deviceSessionStateSchema,
    activeTokenSchema,
    deviceSessionSyncSchema,
    deviceTokenMintRequestSchema,
    deviceTokenMintResponseSchema,
    deviceBackgroundCredentialResponseSchema,
    deviceBackgroundTokenRequestSchema,
    deviceBackgroundTokenResponseSchema,
    SESSION_ACCOUNTS_CHANGED_EVENT,
    sessionAccountsChangedReasonSchema,
    sessionAccountsChangedEventSchema,
} from './deviceSession';

export type {
    SessionAccount,
    DeviceSessionState,
    ActiveToken,
    DeviceSessionSync,
    DeviceTokenMintRequest,
    DeviceTokenMintResponse,
    DeviceBackgroundCredentialResponse,
    DeviceBackgroundTokenRequest,
    DeviceBackgroundTokenResponse,
    SessionAccountsChangedReason,
    SessionAccountsChangedEvent,
} from './deviceSession';

export {
    deviceContextRelationshipSchema,
    deviceDirectoryProfileSchema,
    deviceAccountContextSchema,
    devicePrincipalSchema,
    deviceDirectorySchema,
    deviceActivateRequestSchema,
    deviceActivateResponseSchema,
} from './deviceDirectory';

export type {
    DeviceContextRelationship,
    DeviceDirectoryProfile,
    DeviceAccountContext,
    DevicePrincipal,
    DeviceDirectory,
    DeviceActivateRequest,
    DeviceActivateResponse,
} from './deviceDirectory';

export {
    // Schemas
    loginResultSchema,
} from './deviceBoot';

export type {
    LoginSessionResult,
    LoginResult,
    SecurityAlert,
    SecurityAlertAnomaly,
} from './deviceBoot';

export {
    // Schemas
    rotateKeyChallengeResponseSchema,
    rotateKeyCompleteRequestSchema,
    rotateKeyCompleteResponseSchema,
} from './keyRotation';

export type {
    RotateKeyChallengeResponse,
    RotateKeyCompleteRequest,
    RotateKeyCompleteResponse,
} from './keyRotation';

export {
    // Schemas — encrypted off-device identity backup (b3 Feature 1)
    backupLookupIdSchema,
    encryptedBackupEnvelopeSchema,
    backupUploadRequestSchema,
    backupStatusResponseSchema,
} from './keyRecovery';

export type {
    EncryptedBackupEnvelope,
    BackupUploadRequest,
    BackupStatusResponse,
} from './keyRecovery';

export {
    // Shared primitives
    updatePlatformSchema,
    updateStatusSchema,
    updateAssetStatusSchema,
    sha256HexSchema,
    channelNameSchema,
    runtimeVersionSchema,
    rolloutPercentSchema,
    // Assets: init + complete
    assetInitItemSchema,
    assetInitRequestSchema,
    assetUploadTicketSchema,
    assetInitResponseSchema,
    assetCompleteRequestSchema,
    assetCompleteResultItemSchema,
    assetCompleteResponseSchema,
    // Create update
    updateAssetRefSchema,
    createUpdateRequestSchema,
    // Read models
    updateSchema,
    createUpdateResponseSchema,
    rollbackToEmbeddedEntrySchema,
    channelSchema,
    channelListResponseSchema,
    updateListResponseSchema,
    // Rollback / promote / rollout
    rollbackRequestSchema,
    rollbackToEmbeddedRequestSchema,
    promoteRequestSchema,
    updateRolloutPatchSchema,
} from './updates';

export type {
    UpdatePlatform,
    UpdateStatus,
    UpdateAssetStatus,
    AssetInitItem,
    AssetInitRequest,
    AssetUploadTicket,
    AssetInitResponse,
    AssetCompleteRequest,
    AssetCompleteResultItem,
    AssetCompleteResponse,
    UpdateAssetRef,
    CreateUpdateRequest,
    Update,
    CreateUpdateResponse,
    RollbackToEmbeddedEntry,
    Channel,
    ChannelListResponse,
    UpdateListResponse,
    RollbackRequest,
    RollbackToEmbeddedRequest,
    PromoteRequest,
    UpdateRolloutPatch,
} from './updates';

export {
    // Schemas
    webauthnRegisterOptionsRequestSchema,
    webauthnLoginOptionsRequestSchema,
    webauthnRegisterVerifyRequestSchema,
    webauthnLoginVerifyRequestSchema,
} from './webauthn';

export type {
    WebauthnRegisterOptionsRequest,
    WebauthnLoginOptionsRequest,
    WebauthnRegisterVerifyRequest,
    WebauthnLoginVerifyRequest,
} from './webauthn';

export {
    // Schemas
    devicePairingStatusSchema,
    deviceTransferInitRequestSchema,
    deviceTransferInitResponseSchema,
    deviceTransferInfoResponseSchema,
    deviceTransferApproveRequestSchema,
    deviceTransferApproveResponseSchema,
    deviceTransferDenyResponseSchema,
} from './devicePairing';

export type {
    DevicePairingStatus,
    DeviceTransferInitRequest,
    DeviceTransferInitResponse,
    DeviceTransferInfoResponse,
    DeviceTransferApproveRequest,
    DeviceTransferApproveResponse,
    DeviceTransferDenyResponse,
} from './devicePairing';

export {
    // Schemas — transparency log (checkpoints + inclusion proofs)
    transparencyCheckpointSignatureSchema,
    transparencyAnchorSchema,
    transparencyCheckpointSchema,
    transparencyInclusionProofSchema,
    transparencyCheckpointListSchema,
} from './transparency';

export type {
    TransparencyCheckpointSignature,
    TransparencyAnchor,
    TransparencyCheckpoint,
    TransparencyInclusionProof,
    TransparencyCheckpointList,
} from './transparency';
