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
    isDelegatedActAsEligibleKind,
    isOperatorSwitchTargetKind,
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
    usernameSchema,
    usernameSchemaForAccountKind,
    isValidUsername,
    stripDisallowedUsernameCharacters,
    applyBotUsernameSuffix,
    USERNAME_MIN_LENGTH,
    USERNAME_MAX_LENGTH,
    USERNAME_INVALID_MESSAGE,
    BOT_USERNAME_INVALID_MESSAGE,
} from './username';

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
    exportUsageReceiptSchema,
    exportLedgerEntrySchema,
    exportUsageReservationSchema,
    exportFinancialSectionSchema,
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
    ExportUsageReceipt,
    ExportLedgerEntry,
    ExportUsageReservation,
    ExportFinancialSection,
    ExportBundle,
} from './identity';

export {
    // Schemas
    oxySignedRecordTypeSchema,
} from './oxyRecordTypes';

export type { OxySignedRecordType } from './oxyRecordTypes';

export {
    // Schemas
    chainHeadResponseSchema,
    logPageResponseSchema,
} from './protocol';

export type { LexiconRecord, ChainHeadResponse, LogPageResponse } from './protocol';

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
    deviceDirectorySyncSchema,
} from './deviceDirectory';

export type {
    DeviceContextRelationship,
    DeviceDirectoryProfile,
    DeviceAccountContext,
    DevicePrincipal,
    DeviceDirectory,
    DeviceActivateRequest,
    DeviceActivateResponse,
    DeviceDirectorySync,
} from './deviceDirectory';

export {
    oauthConsentDecisionSchema,
    oauthAuthorizeCodeResponseSchema,
    mcpOAuthClientApplicationSchema,
    mcpOAuthWriteActionSchema,
    mcpOAuthConsentContextSchema,
    mcpOAuthClientInfoResponseSchema,
    mcpOAuthConsentResponseSchema,
} from './oauth';

export type {
    OauthConsentDecision,
    OauthAuthorizeCodeResponse,
    McpOAuthClientApplication,
    McpOAuthWriteAction,
    McpOAuthConsentContext,
    McpOAuthClientInfoResponse,
    McpOAuthConsentResponse,
} from './oauth';

export {
    BROWSER_HUB_COOKIE_NAME,
    BROWSER_HUB_COOKIE_ATTRIBUTES,
    BROWSER_HUB_HANDLE_TTL_MS,
    browserHubHandleSchema,
    browserHubHandleRequestSchema,
    browserHubHandleResponseSchema,
    browserHubResolveResponseSchema,
    browserHubErrorSchema,
    browserHubRevokeResponseSchema,
    hubSessionSchema,
    hubClaimRequestSchema,
    hubActivateRequestSchema,
    hubAuthorizeRequestSchema,
    hubAuthorizeResultSchema,
} from './browserHub';

export type {
    BrowserHubHandleRequest,
    BrowserHubHandleResponse,
    BrowserHubResolveResponse,
    BrowserHubError,
    BrowserHubRevokeResponse,
    HubSession,
    HubClaimRequest,
    HubActivateRequest,
    HubAuthorizeRequest,
    HubAuthorizeResult,
} from './browserHub';

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

/* -------------------------------------------------------------------------- */
/*  Inference (Oxy↔data-plane) — issue #972                                        */
/* -------------------------------------------------------------------------- */

export {
    // The version of the contract SET; per-shape versions live in the data.
    INFERENCE_CONTRACT_VERSION,
} from './inference/version';

export {
    // Principal identifiers. `oxyAccountIdSchema` and `delegatedUserIdSchema`
    // are branded apart so a delegated end user can never become the payer.
    oxyAccountIdSchema,
    delegatedUserIdSchema,
    oxyApplicationIdSchema,
    oxyCredentialIdSchema,
    requestIdSchema,
    generationIdSchema,
    idempotencyKeySchema,
    inferenceEnvironmentSchema,
    // Wire primitives
    inferenceTimestampSchema,
    inferenceDateSchema,
    inferenceHttpsUrlSchema,
    sha256DigestSchema,
    // Catalogue references
    publisherSlugSchema,
    modelSlugSchema,
    modelIdSchema,
    modelRevisionLabelSchema,
    modelReferenceSchema,
    routingProfileIdSchema,
    routingProfileSlugSchema,
    inferenceProviderSlugSchema,
    deploymentIdSchema,
    inferenceRegionSchema,
    RESERVED_ALIA_PUBLISHER,
} from './inference/identifiers';

export type {
    OxyAccountId,
    DelegatedUserId,
    InferenceEnvironment,
    ModelReference,
    ModelId,
} from './inference/identifiers';

export {
    // Exact money and metered units — never floats, units never money.
    currencyCodeSchema,
    INFERENCE_MONEY_SCALE,
    exactDecimalSchema,
    moneySchema,
    USAGE_UNITS,
    usageUnitSchema,
    USAGE_SOURCES,
    usageSourceSchema,
    usageQuantitySchema,
    unitPriceSchema,
} from './inference/money';

export type {
    CurrencyCode,
    ExactDecimal,
    Money,
    UsageUnit,
    UsageSource,
    UsageQuantity,
    UnitPrice,
} from './inference/money';

export {
    // Canonical attribution: who pays, which app, which credential, which user.
    INFERENCE_SCOPES,
    inferenceScopeSchema,
    billingPrincipalSchema,
    authenticatedPrincipalSchema,
    inferenceAttributionSchema,
} from './inference/attribution';

export type {
    InferenceScope,
    BillingPrincipal,
    AuthenticatedPrincipal,
    InferenceAttribution,
} from './inference/attribution';

export {
    // Closed error vocabulary + retryability + a leak-proof provider passthrough.
    INFERENCE_ERROR_CODES,
    NON_RETRYABLE_INFERENCE_ERROR_CODES,
    inferenceErrorCodeSchema,
    upstreamErrorCategorySchema,
    safeErrorTextSchema,
    providerErrorPassthroughSchema,
    inferenceErrorSchema,
} from './inference/errors';

export type {
    InferenceErrorCode,
    UpstreamErrorCategory,
    ProviderErrorPassthrough,
    InferenceError,
} from './inference/errors';

export {
    // Price versions and the snapshot a settled receipt keeps.
    priceVersionStatusSchema,
    priceVersionSchema,
    priceSnapshotSchema,
} from './inference/priceVersion';

export type { PriceVersionStatus, PriceVersion, PriceSnapshot } from './inference/priceVersion';

export {
    // The six distinct catalogue objects + the customer-safe projection.
    inferenceModalitySchema,
    modelCapabilitiesSchema,
    modelLicenseSchema,
    modelProvenanceSchema,
    inferenceDataPolicySchema,
    availabilityScopeSchema,
    commercialPermissionSchema,
    modelDeprecationSchema,
    modelEvaluationResultSchema,
    modelSafetyMetadataSchema,
    modelPublisherSchema,
    catalogueModelSchema,
    modelRevisionSchema,
    inferenceProviderSchema,
    modelDeploymentSchema,
    routingProfileCandidateSchema,
    routingProfileSchema,
    cataloguePublisherSummarySchema,
    catalogueServingProviderSummarySchema,
    modelCatalogueEntrySchema,
} from './inference/catalogue';

export type {
    InferenceModality,
    ModelCapabilities,
    ModelLicense,
    ModelProvenance,
    InferenceDataPolicy,
    AvailabilityScope,
    CommercialPermission,
    ModelDeprecation,
    ModelEvaluationResult,
    ModelSafetyMetadata,
    ModelPublisher,
    CatalogueModel,
    ModelRevision,
    InferenceProvider,
    ModelDeployment,
    RoutingProfileCandidate,
    RoutingProfile,
    CataloguePublisherSummary,
    CatalogueServingProviderSummary,
    ModelCatalogueEntry,
} from './inference/catalogue';

export {
    // Routing policy: every control, plus the refinement that rejects a policy
    // no route could ever satisfy.
    routingTargetSchema,
    routingPolicyScopeSchema,
    routingFallbackPolicySchema,
    routingPolicySchema,
    routingPolicyReferenceSchema,
    // What the data plane actually receives: the routes the policy authorized.
    authorizedRouteSchema,
} from './inference/routingPolicy';

export type {
    RoutingTarget,
    RoutingPolicyScope,
    RoutingFallbackPolicy,
    RoutingPolicy,
    RoutingPolicyReference,
    AuthorizedRoute,
} from './inference/routingPolicy';

export {
    // The signed Alia model release manifest (ingestion contract; no endpoint).
    aliaReleaseArtifactSchema,
    aliaReleaseSignatureSchema,
    aliaModelReleaseManifestSchema,
} from './inference/aliaModelRelease';

export type {
    AliaReleaseArtifact,
    AliaReleaseSignature,
    AliaModelReleaseManifest,
} from './inference/aliaModelRelease';

export {
    // Model documentation: the GPAI/EU AI Act record, the ingestion request that
    // accepts it beside a signed manifest, and the revision-scoped documentation
    // view a downstream developer reads.
    modelDistributionMethodSchema,
    modelSystemicRiskTierSchema,
    trainingComputeFlopsSchema,
    SYSTEMIC_RISK_COMPUTE_THRESHOLD_FLOPS,
    modelDownstreamDocumentationSchema,
    modelGpaiDocumentationSchema,
    modelLineDeclarationSchema,
    modelReleaseIngestionRequestSchema,
    modelReleaseIngestionResultSchema,
    modelDocumentationSchema,
} from './inference/modelDocumentation';

export type {
    ModelDistributionMethod,
    ModelSystemicRiskTier,
    ModelDownstreamDocumentation,
    ModelGpaiDocumentation,
    ModelLineDeclaration,
    ModelReleaseIngestionRequest,
    ModelReleaseIngestionResult,
    ModelDocumentation,
} from './inference/modelDocumentation';

export {
    // The normalized Oxy→data-plane request envelope.
    inferenceContentSourceSchema,
    inferenceContentPartSchema,
    inferenceToolCallSchema,
    inferenceMessageRoleSchema,
    inferenceMessageSchema,
    inferenceInputSchema,
    samplingParametersSchema,
    toolDefinitionSchema,
    toolChoiceSchema,
    responseFormatSchema,
    clientRequestMetadataSchema,
    inferenceRequestSchema,
} from './inference/request';

export type {
    InferenceContentSource,
    InferenceContentPart,
    InferenceToolCall,
    InferenceMessageRole,
    InferenceMessage,
    InferenceInput,
    SamplingParameters,
    ToolDefinition,
    ToolChoice,
    ResponseFormat,
    ClientRequestMetadata,
    InferenceRequest,
} from './inference/request';

export {
    // Normalized SSE events.
    inferenceStreamStartEventSchema,
    inferenceStreamDeltaEventSchema,
    inferenceStreamToolCallEventSchema,
    inferenceStreamUsageEventSchema,
    inferenceRouteSwitchDetailSchema,
    inferenceRouteSwitchReasonSchema,
    inferenceStreamRouteSwitchEventSchema,
    inferenceStreamErrorEventSchema,
    inferenceFinishReasonSchema,
    inferenceStreamDoneEventSchema,
    inferenceStreamEventSchema,
} from './inference/streamEvents';

export type {
    InferenceStreamStartEvent,
    InferenceStreamDeltaEvent,
    InferenceStreamToolCallEvent,
    InferenceStreamUsageEvent,
    InferenceRouteSwitchDetail,
    InferenceRouteSwitchReason,
    InferenceStreamRouteSwitchEvent,
    InferenceStreamErrorEvent,
    InferenceFinishReason,
    InferenceStreamDoneEvent,
    InferenceStreamEvent,
} from './inference/streamEvents';

export {
    // Reserve → settle → refund.
    usageReservationRequestSchema,
    usageReservationStatusSchema,
    usageReservationSchema,
    inferenceRequestOutcomeSchema,
    normalizedUsageReportSchema,
    usageReceiptSchema,
    usageRefundSubjectSchema,
    usageRefundReasonSchema,
    usageRefundSchema,
} from './inference/usage';

export type {
    UsageReservationRequest,
    UsageReservationStatus,
    UsageReservation,
    InferenceRequestOutcome,
    NormalizedUsageReport,
    UsageReceipt,
    UsageRefundSubject,
    UsageRefundReason,
    UsageRefund,
} from './inference/usage';

export {
    // BYOK connection metadata that structurally cannot carry a secret.
    providerConnectionScopeSchema,
    kaanaCredentialHandleSchema,
    kaanaCredentialOperationIdSchema,
    kaanaCredentialOperationActionSchema,
    kaanaCredentialIdentitySchema,
    kaanaCredentialCreateMutationSchema,
    kaanaCredentialRotateMutationSchema,
    kaanaCredentialRevokeMutationSchema,
    kaanaCredentialMutationSchema,
    kaanaCredentialCreateOutcomeRequestSchema,
    kaanaCredentialRotateOutcomeRequestSchema,
    kaanaCredentialRevokeOutcomeRequestSchema,
    kaanaCredentialOutcomeRequestSchema,
    kaanaCredentialAppliedOutcomeSchema,
    kaanaCredentialConflictOutcomeSchema,
    kaanaCredentialOutcomeSchema,
    kaanaCredentialValidationTaskSchema,
    kaanaCredentialValidationOutcomeStateSchema,
    kaanaCredentialValidationFailureCodeSchema,
    kaanaCredentialValidationOutcomeSchema,
    providerCredentialValidationOperationSchema,
    providerCredentialValidationDeploymentSchema,
    providerCredentialCustodyStateSchema,
    providerConnectionValidationSchema,
    providerConnectionStatusSchema,
    providerConnectionSchema,
} from './inference/providerConnection';

export type {
    ProviderConnectionScope,
    KaanaCredentialOperationAction,
    KaanaCredentialIdentity,
    KaanaCredentialMutation,
    KaanaCredentialOutcomeRequest,
    KaanaCredentialOutcome,
    KaanaCredentialValidationTask,
    KaanaCredentialValidationOutcome,
    ProviderCredentialValidationOperation,
    ProviderCredentialValidationDeployment,
    ProviderConnectionValidation,
    ProviderConnectionStatus,
    ProviderCredentialCustodyState,
    ProviderConnection,
} from './inference/providerConnection';

export {
    // Account-scoped billing: who pays, what they hold, what bounds them, and
    // how it reconciles against the payment processor. A grant and a purchase
    // are never one number — there is deliberately no total.
    BILLING_MODES,
    billingModeSchema,
    BILLING_PROFILE_STATUSES,
    billingProfileStatusSchema,
    autoRechargeSchema,
    billingProfileSchema,
    accountBillingStateSchema,
    BILLING_INVOICE_STATUSES,
    billingInvoiceStatusSchema,
    billingInvoiceSchema,
    EXTERNAL_PAYMENT_PROVIDERS,
    externalPaymentProviderSchema,
    EXTERNAL_PAYMENT_KINDS,
    externalPaymentKindSchema,
    externalPaymentSchema,
    AUTO_RECHARGE_STATUSES,
    autoRechargeStatusSchema,
    autoRechargeAttemptSchema,
    RECONCILIATION_DISCREPANCY_KINDS,
    reconciliationDiscrepancyKindSchema,
    RECONCILIATION_RUN_STATUSES,
    reconciliationRunStatusSchema,
    reconciliationDiscrepancySchema,
    reconciliationRunSchema,
    reconciliationReportSchema,
} from './inference/accountBilling';

export type {
    BillingMode,
    BillingProfileStatus,
    AutoRecharge,
    BillingProfile,
    AccountBillingState,
    BillingInvoiceStatus,
    BillingInvoice,
    ExternalPaymentProvider,
    ExternalPaymentKind,
    ExternalPayment,
    AutoRechargeStatus,
    AutoRechargeAttempt,
    ReconciliationDiscrepancyKind,
    ReconciliationRunStatus,
    ReconciliationDiscrepancy,
    ReconciliationRun,
    ReconciliationReport,
} from './inference/accountBilling';

export {
    // Product entitlements. Allowances are integer counts and money is an exact
    // decimal, so a plan allowance cannot be added to a balance.
    PRODUCT_PLAN_STATUSES,
    productPlanStatusSchema,
    LIVE_PRODUCT_PLAN_STATUSES,
    planAllowanceSchema,
    productPlanSchema,
    payAsYouGoEntitlementSchema,
    COST_CENTER_STATUSES,
    costCenterStatusSchema,
    costCenterSchema,
    costCenterSpendSchema,
    productEntitlementSchema,
} from './inference/entitlement';

export type {
    ProductPlanStatus,
    PlanAllowance,
    ProductPlan,
    PayAsYouGoEntitlement,
    CostCenterStatus,
    CostCenter,
    CostCenterSpend,
    ProductEntitlement,
} from './inference/entitlement';

export {
    AUTONOMY_LEVELS,
    CAPABILITY_PACKAGES,
    autonomyLevelSchema,
    capabilityPackageSchema,
    actorRefSchema,
    resourceRefSchema,
    toolGrantOverrideSchema,
    grantLimitSchema,
    capabilityCatalogBindingSchema,
    executionAuthorizationRefSchema,
    capabilityCoordinatorSchema,
    delegationGrantSchema,
    automationTriggerSchema,
    automationActorSelectionSchema,
    automationDataFlowSchema,
    automationDefinitionSchema,
    capabilityTicketClaimsSchema,
    policyDecisionSchema,
    auditResultSchema,
    auditEventSchema,
    catalogToolSchema,
    catalogEventSchema,
    appCapabilityCatalogSchema,
    catalogRegistrationSchema,
    normalizedAppEventSchema,
} from './agency';

export type {
    AutonomyLevel,
    CapabilityPackage,
    ActorRef,
    ResourceRef,
    ToolGrantOverride,
    GrantLimit,
    CapabilityCatalogBinding,
    ExecutionAuthorizationRef,
    CapabilityCoordinator,
    DelegationGrant,
    AutomationTrigger,
    AutomationActorSelection,
    AutomationDefinition,
    CapabilityTicketClaims,
    PolicyDecision,
    AuditEvent,
    CatalogTool,
    CatalogEvent,
    AppCapabilityCatalog,
    CatalogRegistration,
    NormalizedAppEvent,
} from './agency';

export {
    emailContextAddressSchema,
    emailContextMailboxSchema,
    emailContextMessageSchema,
    emailAgentContextSchema,
} from './emailAgentContext';

export type {
    EmailContextAddress,
    EmailContextMailbox,
    EmailContextMessage,
    EmailAgentContext,
} from './emailAgentContext';

export {
    inboxComposeRequestSchema,
    inboxDailyBriefRequestSchema,
    inboxNaturalSearchRequestSchema,
    inboxMessageInferenceParamsSchema,
    inboxInferenceTextResponseSchema,
    inboxNaturalSearchResponseSchema,
    inboxSmartRepliesResponseSchema,
    inboxThreadSummaryResponseSchema,
    inboxInferenceStreamEventSchema,
} from './inference/inbox';

export type {
    InboxComposeRequest,
    InboxInferenceTextResponse,
    InboxNaturalSearchResponse,
    InboxSmartRepliesResponse,
    InboxThreadSummaryResponse,
    InboxInferenceStreamEvent,
} from './inference/inbox';
