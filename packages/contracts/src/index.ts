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
    ORGANIZATION_CATEGORIES,
    organizationCategorySchema,
    createAccountRequestSchema,
} from './accountGraph';

export type {
    OrganizationCategory,
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
} from './commonsSignIn';

export type { CommonsDenyReason } from './commonsSignIn';

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

export {
    sessionAccountSchema,
    deviceSessionStateSchema,
    activeTokenSchema,
    deviceSessionSyncSchema,
    deviceTokenMintRequestSchema,
    deviceTokenMintResponseSchema,
    deviceHubTicketIssueRequestSchema,
    deviceHubTicketIssueResponseSchema,
    deviceHubTicketRedeemRequestSchema,
    deviceHubTicketRedeemResponseSchema,
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
    DeviceHubTicketIssueRequest,
    DeviceHubTicketIssueResponse,
    DeviceHubTicketRedeemRequest,
    DeviceHubTicketRedeemResponse,
    SessionAccountsChangedReason,
    SessionAccountsChangedEvent,
} from './deviceSession';

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

export {
    AUTONOMY_LEVELS,
    CAPABILITY_PACKAGES,
    autonomyLevelSchema,
    capabilityPackageSchema,
    actorRefSchema,
    resourceRefSchema,
    toolGrantOverrideSchema,
    grantLimitSchema,
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

export type {
    AutonomyLevel,
    CapabilityPackage,
    ActorRef,
    ResourceRef,
    ToolGrantOverride,
    GrantLimit,
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
