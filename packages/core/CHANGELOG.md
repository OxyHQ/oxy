# Changelog — `@oxy.so/core`

## 3.0.0

The client is organised by namespace, the server half is its own class, and
the transport is faster and correct under load. **Breaking:** every flat
method moved. Run the codemod, then fix what it marks:

```sh
bun <oxy-repo>/scripts/codemods/core-3/codemod.ts ./src
grep -rn "TODO(core-3)" ./src
```

### Changed

- **Namespaces.** `oxy.users.get(id)`, `oxy.assets.upload(file)`,
  `oxy.follows.follow(id)`, `oxy.session.accessToken`, … — one namespace per
  API area, each created on first access. Duplicates are gone: one way to read
  a user, one asset URL call, one delete that always clears the cache, one
  "mine" convention (omit the user id). See `docs/api.mdx`.
- **`OxyServer`** (`@oxy.so/core/server`) is the backend client: `OxyServices`
  plus `serviceAuth: { apiKey, apiSecret }` (or workload identity),
  `serviceToken()`, `serviceRequest(…, { actAs })`, `middleware.auth()` /
  `.socket()` / `.service()` / `.requireScope()`, and the service-only
  namespace methods. `OxyServices` no longer carries server code. 2.3.0's
  `serviceIdentity: 'when-anonymous'` is an `OxyServer` option now (a client
  has no service identity to offer): `new OxyServer({ …, serviceIdentity:
  'when-anonymous' })`.
- **Errors.** Every call rejects with `OxyApiError` (`status`, `code`,
  `details`, `cancelled`, `timeout`).
- **Entry points.** The root is the client; `@oxy.so/core/session`,
  `/crypto`, `/civic` and `/inference` hold the heavy parts, so an app that only
  calls the API no longer ships secp256k1, bip39, the session machinery or the
  inference client. Non-English dictionaries load on demand (`loadLocale`,
  `subscribeLocales`).
- Signature changes: extra positional arguments became options objects
  (`assets.upload(file, { visibility, onProgress })`, `assets.link`,
  `assets.delete(id, { force })`, `reputation.transactions(userId, { limit,
  offset })`, …) — each is listed below.

### Fixed

- A burst of 401s (a revoked session under load) could stall every request:
  the refresh retry waited for a queue slot while its original held one.
- Two concurrent uploads with different files were merged into one call (an
  opaque `FormData` body keyed as empty); only GETs are deduplicated now.
- POST/PATCH were re-sent on a 5xx or a dropped connection; only idempotent
  methods (GET, PUT, DELETE) retry.
- One caller cancelling a deduplicated GET cancelled it for every caller.
- A retry's backoff and a deduplicated caller held a queue slot doing nothing.
- `assets.delete(id, { force })` sent `force` in the body; the API reads the
  query.
- `notifications.create` and `reputation.award` sent the user bearer to
  routes that only accept a service token.

### Performance

- No request waits on the Cloudflare edge-region trace any more.
- The access token is decoded once per token, not several times per request;
  the cache/dedupe key is computed once per call.
- Cache invalidation after a write is one pass over the cache; the cache is
  bounded (LRU); `dispose()` releases a client's cache.
- `session.waitForAuth` is event-driven instead of polling.
- No client is constructed at import time (`oxyClient` is gone).

### Removed

- Methods whose routes never existed or were superseded (subscriptions,
  saves/collections, history, FAQs, achievements, feedback, location,
  analytics, chains, `registerDevice`, payment creation), the Oxy-staff
  reputation overrides and disputes, `checkEmailAvailability` (it disclosed
  whether an email has an account), channel provisioning, the passkey-only
  account deletion and identity link, and the default export.

### Method map

#### Client (`OxyServices`)

| 2.x | 3.0 |
|---|---|
| `makeRequest` | `oxy.request` |
| `getBaseURL` | `oxy.baseURL` — now a property: oxy.baseURL |
| `getCloudURL` | `oxy.cloudURL` — now a property: oxy.cloudURL |
| `getClient` | `oxy.http` — now a property: oxy.http |
| `httpService` | `oxy.http` |
| `createLinkedClient` | `oxy.createLinkedClient` |
| `healthCheck` | `oxy.health` |
| `getCacheStats` | `oxy.cache.stats` |
| `clearCache` | `oxy.cache.clear` |
| `clearCacheEntry` | `oxy.cache.delete` |
| `clearCacheByPrefix` | `oxy.cache.deletePrefix` |
| `setTokens` | `oxy.session.setAccessToken` |
| `clearTokens` | `oxy.session.clear` |
| `onTokensChanged` | `oxy.session.onChange` |
| `getAccessToken` | `oxy.session.accessToken` — now a getter: oxy.session.accessToken |
| `getAccessTokenExpiry` | `oxy.session.accessTokenExpiry` — now a getter |
| `getCurrentUserId` | `oxy.session.userId` — now a getter: oxy.session.userId |
| `hasValidToken` | `oxy.session.isAuthenticated` — now a getter |
| `waitForAuth` | `oxy.session.waitForAuth` |
| `validate` | `oxy.session.validateToken` |
| `validateSession` | `oxy.session.validate` |
| `setDeviceCredentialProvider` | `oxy.session.setDeviceCredentialProvider` |
| `readDeviceProof` | `oxy.session.readDeviceProof` |
| `getSessionsBySessionId` | `oxy.session.list` |
| `logoutSession` | `oxy.session.logout` |
| `logoutAllSessions` | `oxy.session.logoutAll` |
| `register` | `oxy.auth.registerKey` |
| `requestChallenge` | `oxy.auth.requestChallenge` |
| `verifyChallenge` | `oxy.auth.verifyChallenge` |
| `checkPublicKeyRegistered` | `oxy.auth.isKeyRegistered` |
| `claimSessionByToken` | `oxy.auth.claimSession` |
| `signInWithSharedIdentity` | `oxy.auth.signInWithSharedIdentity` |
| `checkUsernameAvailability` | `oxy.auth.checkUsername` |
| `startEmailVerification` | `oxy.auth.email.startVerification` |
| `confirmEmailVerification` | `oxy.auth.email.confirmVerification` |
| `startEmailSignIn` | `oxy.auth.email.start` |
| `confirmEmailSignIn` | `oxy.auth.email.confirm` |
| `collectEmailSignIn` | `oxy.auth.email.collect` |
| `approveEmailSignInLink` | `oxy.auth.email.approveLink` |
| `signInWithPassword` | `oxy.auth.password.signIn` |
| `setPassword` | `oxy.auth.password.set` |
| `completeSecondFactor` | `oxy.auth.completeSecondFactor` |
| `signUp` | `oxy.auth.signUp` |
| `getSignInMethods` | `oxy.auth.methods` |
| `requestReauthEmailCode` | `oxy.auth.requestReauthCode` |
| `enrollTotp` | `oxy.auth.totp.enroll` |
| `confirmTotp` | `oxy.auth.totp.confirm` |
| `disableTotp` | `oxy.auth.totp.disable` |
| `regenerateTotpBackupCodes` | `oxy.auth.totp.regenerateBackupCodes` |
| `exchangeOAuthCode` | `oxy.auth.oauth.exchangeCode` |
| `getOAuthUserInfo` | `oxy.auth.oauth.userInfo` |
| `startCommonsSignIn` | `oxy.auth.commons.start` |
| `pollCommonsSignIn` | `oxy.auth.commons.poll` |
| `deliverCommonsSignIn` | `oxy.auth.commons.deliver` |
| `markCommonsApprovalOpened` | `oxy.auth.commons.markOpened` |
| `finalizeCommonsOAuth` | `oxy.auth.commons.finalizeOAuth` |
| `getCommonsApprovalInfo` | `oxy.auth.commons.approvalInfo` |
| `approveCommonsSignIn` | `oxy.auth.commons.approve` |
| `denyCommonsSignIn` | `oxy.auth.commons.deny` |
| `getUserById` | `oxy.users.get` |
| `getUsersByIds` | `oxy.users.getMany` |
| `getCurrentUser` | `oxy.users.me` |
| `getProfileByUsername` | `oxy.users.byUsername` |
| `getUserByPublicKey` | `oxy.users.byPublicKey` |
| `getUserBySession` | `oxy.users.bySession` |
| `getUsersBySessions` | `oxy.users.bySessions` |
| `searchProfiles` | `oxy.users.search` |
| `resolveProfile` | `oxy.users.resolveHandle` |
| `resolveExternalUser` | `oxy.users.resolveExternal` |
| `getSimilarProfiles` | `oxy.users.similar` |
| `getProfileRecommendations` | `oxy.users.recommendations` |
| `updateProfile` | `oxy.users.updateMe` |
| `updateNotificationPreferences` | `oxy.users.updateMe` — (prefs) → ({ notificationPreferences: prefs }) |
| `updateUserPreferences` | `oxy.users.updateMe` — (prefs) → ({ preferences: prefs }) |
| `updateThemePreference` | `oxy.users.updateMe` — (theme) → ({ themePreference: theme }) |
| `requestAccountVerification` | `oxy.users.requestVerification` |
| `deleteAccount` | `oxy.users.deleteMe` — (confirmText) → (confirmText, { deviceKey: true }) |
| `deleteAccountWithEmailCode` | `oxy.users.deleteMe` — (confirmText, reauth) → (confirmText, { reauth }) |
| `downloadAccountData` | `oxy.identity.export` — now the signed export (GET /users/me/export) |
| `followUser` | `oxy.follows.follow` |
| `followUsers` | `oxy.follows.followMany` |
| `unfollowUser` | `oxy.follows.unfollow` |
| `unfollowUsers` | `oxy.follows.unfollowMany` |
| `getFollowStatus` | `oxy.follows.status` |
| `getFollowStatuses` | `oxy.follows.statuses` |
| `getUserFollowers` | `oxy.follows.followers` |
| `getUserFollowing` | `oxy.follows.following` |
| `getUserMutuals` | `oxy.follows.mutuals` |
| `getMutualUserIds` | `oxy.follows.mutualIds` |
| `getFollowsOfFollowsIds` | `oxy.follows.followsOfFollowsIds` |
| `getViewerGraph` | `oxy.follows.viewerGraph` |
| `followTarget` | `oxy.follows.followTarget` |
| `unfollowTarget` | `oxy.follows.unfollowTarget` |
| `getFollowTargetStatus` | `oxy.follows.targetStatus` |
| `setFollowApplicationMode` | `oxy.follows.setApplicationMode` |
| `restoreFollowInheritance` | `oxy.follows.restoreInheritance` |
| `ensureFollowTarget` | `oxy.follows.ensureTarget` |
| `claimFollowNamespace` | `oxy.follows.claimNamespace` |
| `releaseFollowNamespace` | `oxy.follows.releaseNamespace` |
| `registerFollowKind` | `oxy.follows.registerKind` |
| `listFollows` | `oxy.follows.list` |
| `getPrivacySettings` | `oxy.privacy.settings` |
| `updatePrivacySettings` | `oxy.privacy.updateSettings` |
| `getBlockedUsers` | `oxy.privacy.blocked` |
| `blockUser` | `oxy.privacy.block` |
| `unblockUser` | `oxy.privacy.unblock` |
| `isUserBlocked` | `oxy.privacy.isBlocked` |
| `getRestrictedUsers` | `oxy.privacy.restricted` |
| `restrictUser` | `oxy.privacy.restrict` |
| `unrestrictUser` | `oxy.privacy.unrestrict` |
| `isUserRestricted` | `oxy.privacy.isRestricted` |
| `getNotifications` | `oxy.notifications.list` |
| `getUnreadCount` | `oxy.notifications.unreadCount` |
| `markNotificationAsRead` | `oxy.notifications.markRead` |
| `markAllNotificationsAsRead` | `oxy.notifications.markAllRead` |
| `deleteNotification` | `oxy.notifications.delete` |
| `registerPushToken` | `oxy.notifications.registerPushToken` |
| `unregisterPushToken` | `oxy.notifications.unregisterPushToken` |
| `assetUpload` | `oxy.assets.upload` — (file, visibility, metadata, onProgress) → (file, { visibility, metadata, onProgress }); returns { file } |
| `uploadRawFile` | `oxy.assets.upload` — (file, visibility, metadata) → (file, { visibility, metadata }); returns { file } |
| `assetLink` | `oxy.assets.link` — (fileId, app, entityType, entityId, visibility, webhookUrl) → (fileId, { app, entityType, entityId }, { visibility, webhookUrl }) |
| `assetUnlink` | `oxy.assets.unlink` — (fileId, app, entityType, entityId) → (fileId, { app, entityType, entityId }) |
| `assetGet` | `oxy.assets.get` |
| `assetGetVariants` | `oxy.assets.get` — variants are on the asset: (await assets.get(id)).variants |
| `assetGetUrl` | `oxy.assets.url` — returns the URL string, not { url } |
| `getFileDownloadUrlAsync` | `oxy.assets.url` |
| `fetchAssetDownloadUrl` | `oxy.assets.url` |
| `getFileDownloadUrl` | `oxy.assets.publicUrl` |
| `getFileDownloadUrls` | `oxy.assets.urls` |
| `getBatchFileAccess` | `oxy.assets.access` |
| `getFileContentAsText` | `oxy.assets.text` |
| `getFileContentAsBlob` | `oxy.assets.blob` |
| `assetRestore` | `oxy.assets.restore` |
| `assetDelete` | `oxy.assets.delete` — (fileId, force) → (fileId, { force }) |
| `deleteFile` | `oxy.assets.delete` |
| `assetUpdateVisibility` | `oxy.assets.setVisibility` |
| `listUserFiles` | `oxy.assets.list` — (limit, offset) → ({ limit, offset }) |
| `getAccountStorageUsage` | `oxy.assets.usage` |
| `uploadAvatar` | `oxy.assets.uploadAvatar` |
| `resolveDid` | `oxy.identity.resolveDid` |
| `getMyDid` | `oxy.identity.did` — now a getter |
| `listAuthMethods` | `oxy.identity.authMethods` |
| `getIdentityRootStatus` | `oxy.identity.rootStatus` |
| `createIdentityLink` | `oxy.identity.links.create` |
| `getIdentityLink` | `oxy.identity.links.get` |
| `signIdentityLink` | `oxy.identity.links.sign` |
| `completeIdentityLinkWithEmailCode` | `oxy.identity.links.complete` |
| `cancelIdentityLink` | `oxy.identity.links.cancel` |
| `rotateKey` | `oxy.identity.rotateKey` |
| `exportMyData` | `oxy.identity.export` |
| `requestDomainVerification` | `oxy.identity.domains.requestVerification` |
| `verifyDomain` | `oxy.identity.domains.verify` |
| `listDomains` | `oxy.identity.domains.list` |
| `removeDomain` | `oxy.identity.domains.remove` |
| `createEncryptedBackup` | `oxy.identity.backup.create` |
| `getBackupStatus` | `oxy.identity.backup.status` |
| `deleteBackup` | `oxy.identity.backup.delete` |
| `restoreFromEncryptedBackup` | `oxy.identity.backup.restore` |
| `listAccounts` | `oxy.accounts.list` |
| `getAccount` | `oxy.accounts.get` |
| `switchToAccount` | `oxy.accounts.actAs` |
| `createAccount` | `oxy.accounts.create` |
| `updateAccount` | `oxy.accounts.update` |
| `archiveAccount` | `oxy.accounts.archive` |
| `listAccountMembers` | `oxy.accounts.members.list` |
| `inviteAccountMember` | `oxy.accounts.members.invite` |
| `updateAccountMember` | `oxy.accounts.members.update` |
| `removeAccountMember` | `oxy.accounts.members.remove` |
| `transferAccountOwnership` | `oxy.accounts.transferOwnership` |
| `listAccountApps` | `oxy.apps.list` |
| `createApp` | `oxy.apps.create` |
| `getApp` | `oxy.apps.get` |
| `updateApp` | `oxy.apps.update` |
| `deleteApp` | `oxy.apps.delete` |
| `getAppUsage` | `oxy.apps.usage` |
| `listAppCredentials` | `oxy.apps.credentials.list` |
| `createAppCredential` | `oxy.apps.credentials.create` |
| `rotateAppCredential` | `oxy.apps.credentials.rotate` |
| `revokeAppCredential` | `oxy.apps.credentials.revoke` |
| `getPublicApplication` | `oxy.apps.getPublic` |
| `listConnectedApps` | `oxy.apps.connected.list` |
| `revokeAppGrant` | `oxy.apps.connected.revoke` |
| `listConnectedMcpClients` | `oxy.apps.connected.mcpClients` |
| `revokeConnectedMcpClient` | `oxy.apps.connected.revokeMcpClient` |
| `startLinkedAccount` | `oxy.linkedAccounts.start` |
| `completeLinkedAccount` | `oxy.linkedAccounts.complete` |
| `listLinkedAccounts` | `oxy.linkedAccounts.list` |
| `revokeLinkedAccount` | `oxy.linkedAccounts.revoke` |
| `listAvailableCapabilityCatalogs` | `oxy.agency.catalogs` |
| `listDelegationGrants` | `oxy.agency.grants.list` |
| `createDelegationGrant` | `oxy.agency.grants.create` |
| `updateDelegationGrant` | `oxy.agency.grants.update` |
| `revokeDelegationGrant` | `oxy.agency.grants.revoke` |
| `listAccountCapabilityPolicies` | `oxy.agency.policies.list` |
| `putAccountCapabilityPolicy` | `oxy.agency.policies.put` |
| `deleteAccountCapabilityPolicy` | `oxy.agency.policies.delete` |
| `listCapabilityExecutionAuthorizations` | `oxy.agency.authorizations.list` |
| `revokeCapabilityExecutionAuthorization` | `oxy.agency.authorizations.revoke` |
| `listCapabilityAuditEvents` | `oxy.agency.auditEvents` |
| `listStoreCategories` | `oxy.store.categories` |
| `listStoreApps` | `oxy.store.apps` |
| `getStoreApp` | `oxy.store.app` |
| `listStoreReviews` | `oxy.store.reviews.list` |
| `getMyStoreReview` | `oxy.store.reviews.mine` |
| `writeStoreReview` | `oxy.store.reviews.write` |
| `deleteMyStoreReview` | `oxy.store.reviews.deleteMine` |
| `getAppListing` | `oxy.store.listing.get` |
| `writeAppListing` | `oxy.store.listing.write` |
| `submitAppListing` | `oxy.store.listing.submit` |
| `unpublishAppListing` | `oxy.store.listing.unpublish` |
| `listAppListingScreenshots` | `oxy.store.listing.screenshots.list` |
| `addAppListingScreenshot` | `oxy.store.listing.screenshots.add` |
| `updateAppListingScreenshot` | `oxy.store.listing.screenshots.update` |
| `deleteAppListingScreenshot` | `oxy.store.listing.screenshots.delete` |
| `reorderAppListingScreenshots` | `oxy.store.listing.screenshots.reorder` |
| `getUserPayments` | `oxy.billing.payments` |
| `getSubscription` | `oxy.billing.subscription` |
| `getCurrentUserSubscription` | `oxy.billing.subscription` |
| `getWallet` | `oxy.billing.wallet` |
| `getCurrentUserWallet` | `oxy.billing.wallet` |
| `getWalletTransactions` | `oxy.billing.walletTransactions` — (userId, options) → ({ userId, ...options }) |
| `getCurrentUserWalletTransactions` | `oxy.billing.walletTransactions` — (options) → (options) |
| `getReputationBalance` | `oxy.reputation.balance` |
| `getMyReputationBalance` | `oxy.reputation.balance` — no userId = mine |
| `getReputationLeaderboard` | `oxy.reputation.leaderboard` — (limit, offset) → ({ limit, offset }) |
| `getReputationRules` | `oxy.reputation.rules` |
| `getReputationTransactions` | `oxy.reputation.transactions` — (userId, limit, offset) → (userId, { limit, offset }) |
| `getReputationInfluence` | `oxy.reputation.influence` |
| `getPublicCard` | `oxy.civic.publicCard` |
| `getMyIdPayload` | `oxy.civic.idPayload` |
| `buildAttestQrPayload` | `oxy.civic.buildAttestQrPayload` |
| `submitRealLifeAttestation` | `oxy.civic.attest` |
| `getValidatorInbox` | `oxy.civic.validation.inbox` |
| `submitValidationVote` | `oxy.civic.validation.vote` |
| `denyValidation` | `oxy.civic.validation.deny` |
| `vouchForPerson` | `oxy.civic.vouch` |
| `withdrawVouch` | `oxy.civic.withdrawVouch` |
| `getPersonhood` | `oxy.civic.personhood` |
| `getMyPersonhood` | `oxy.civic.personhood` — no userId = mine |
| `issueCredential` | `oxy.civic.credentials.issue` |
| `listCredentials` | `oxy.civic.credentials.list` |
| `listMyCredentials` | `oxy.civic.credentials.list` — (opts) → (undefined, opts) |
| `verifyCredential` | `oxy.civic.credentials.verify` |
| `revokeCredential` | `oxy.civic.credentials.revoke` |
| `registerNode` | `oxy.nodes.register` |
| `getMyNode` | `oxy.nodes.mine` |
| `removeMyNode` | `oxy.nodes.removeMine` |
| `provisionManagedVault` | `oxy.nodes.provisionManagedVault` |
| `notifyNodeIngest` | `oxy.nodes.notifyIngest` |
| `getUserDevices` | `oxy.devices.list` |
| `removeDevice` | `oxy.devices.remove` |
| `getDeviceSessions` | `oxy.devices.sessions` |
| `logoutAllDeviceSessions` | `oxy.devices.logoutAll` |
| `updateDeviceName` | `oxy.devices.rename` |
| `getSecurityInfo` | `oxy.devices.securityInfo` |
| `getSecurityActivity` | `oxy.devices.securityActivity` |
| `getRecentSecurityActivity` | `oxy.devices.securityActivity` — (limit) → (limit, 0); returns the page, read .data |
| `logPrivateKeyExported` | `oxy.devices.logPrivateKeyExported` |
| `logBackupCreated` | `oxy.devices.logBackupCreated` |
| `mintFromDeviceSecret` | `oxy.devices.mintToken` |
| `registerBrowserDevice` | `oxy.devices.registerBrowser` |
| `requestDeviceJoinCode` | `oxy.devices.requestJoinCode` |
| `joinBrowserDevice` | `oxy.devices.joinBrowser` |
| `provisionBackgroundCredential` | `oxy.devices.provisionBackgroundCredential` |
| `listTopics` | `oxy.topics.list` |
| `searchTopics` | `oxy.topics.search` |
| `getTopicBySlug` | `oxy.topics.get` |
| `getTopicCategories` | `oxy.topics.categories` |
| `resolveTopicNames` | `oxy.topics.resolveNames` |
| `updateTopicMetadata` | `oxy.topics.update` |
| `getAppData` | `oxy.appData.get` |
| `setAppData` | `oxy.appData.set` |
| `deleteAppData` | `oxy.appData.delete` |
| `listAppData` | `oxy.appData.list` |
| `discoverContacts` | `oxy.contacts.discover` |

#### Server (`OxyServer`, `@oxy.so/core/server`)

| 2.x | 3.0 |
|---|---|
| `createNotification` | `server.notifications.create` |
| `getServiceAssetMetadataByIds` | `server.assets.metadataByIds` |
| `getServiceAssetMetadataBySha256` | `server.assets.metadataBySha256` |
| `getServiceLinkedDownloadUrls` | `server.assets.linkedDownloadUrls` |
| `getLinkedAccountsForUser` | `server.linkedAccounts.forUser` |
| `mintRequesterAssertion` | `server.agency.mintRequesterAssertion` |
| `introspectRequesterAssertion` | `server.agency.introspectRequesterAssertion` |
| `awardReputation` | `server.reputation.award` |
| `configureServiceAuth` | `server.configureServiceAuth` |
| `getServiceToken` | `server.serviceToken` |
| `invalidateServiceToken` | `server.invalidateServiceToken` |
| `makeServiceRequest` | `server.serviceRequest` |
| `verifyServiceActingAs` | `server.verifyActingAs` |
| `verifyAccountEvent` | `server.accountEvents.verify` |
| `listAccountEvents` | `server.accountEvents.list` |
| `auth` | `server.middleware.auth` |
| `authSocket` | `server.middleware.socket` |
| `serviceAuth` | `server.middleware.service` |
| `requireScope` | `server.middleware.requireScope` |

#### Removed

- `handleError`
- `getMetrics`
- `withAuthRetry` — call the method directly; the HTTP layer already refreshes on 401
- `__resetTokensForTests`
- `webauthnRegisterOptions` — passkeys are removed (ADR 0030)
- `webauthnRegisterVerify` — passkeys are removed (ADR 0030)
- `webauthnLoginOptions` — passkeys are removed (ADR 0030)
- `webauthnLoginVerify` — passkeys are removed (ADR 0030)
- `checkEmailAvailability`
- `getAccountDeletionOptions`
- `deleteAccountWithPasskey`
- `lookupUsername`
- `getUserStats`
- `invalidateFollowGraphCaches`
- `extractUserId`
- `isUserInList`
- `fetchAssetContent`
- `getAssetUrlCacheTTL`
- `uploadProfileBanner`
- `getMyDidDocument`
- `getIdentityLinkAssertionOptions`
- `completeIdentityLink`
- `removePasskey` — passkeys are removed (ADR 0030)
- `signRecord`
- `publishRecord`
- `getRecord`
- `verifyRecord`
- `listChildAccounts`
- `provisionChannelAccount`
- `provisionChannelMember`
- `revokeChannelMember`
- `replyToStoreReview`
- `deleteStoreReviewReply`
- `createPayment`
- `getPayment`
- `createReputationDispute`
- `getUserReputationDisputes`
- `upsertReputationRule`
- `reverseReputationTransaction`
- `voidReputationTransaction`
- `recalculateReputation`
- `getReputationDisputeQueue`
- `resolveReputationDispute`
- `registerDevice`
- `inference` — createInferenceClient(oxy) from '@oxy.so/core/inference'
- `getStorage`
- `getCurrentLanguage` — use getLanguageCode / the i18n helpers
- `getCurrentLanguageMetadata`
- `getCurrentLanguageName`
- `getCurrentNativeLanguageName`
- `submitFeedback`
- `getSubscriptionPlans`
- `getIndividualFeatures`
- `subscribe`
- `subscribeToFeature`
- `cancelSubscription`
- `reactivateSubscription`
- `getCurrentSubscription`
- `getSavedItems`
- `getCollections`
- `saveItem`
- `removeSavedItem`
- `createCollection`
- `deleteCollection`
- `getUserHistory`
- `clearUserHistory`
- `deleteHistoryItem`
- `getFAQs`
- `searchFAQs`
- `getUserAchievements`
- `getAllAchievements`
- `updateLocation`
- `getNearbyUsers`
- `trackEvent`
- `getAnalytics`
- `appendChainRecord`
- `readChainRecords`

## 2.3.0

A backend's reads that carry no user session can identify as the service.
Also released for 1.x as 1.18.1 from `release/core-1.18.x`.

### Added

- `OxyConfig.serviceIdentity: 'never' | 'when-anonymous'` (default `'never'`).
  With `'when-anonymous'`, a request made while the client holds no user
  session carries this process's service token — the `configureServiceAuth()`
  key pair, or workload attestation (ADR 0026) without one. A user session
  still wins, `skipAuth` requests stay unauthenticated, and a process that can
  mint no token (a local checkout) sends the request anonymous as before. A
  failed mint sends reads anonymous for 30 s (`ANONYMOUS_SERVICE_TOKEN_RETRY_MS`)
  before trying again, so a refusing Oxy is asked once per window, not once per
  read.

  Why: oxy-api charges anonymous traffic to its source address — `rl:general`
  and a +500 ms `slowDown` per request past 100 in 15 minutes — and a backend
  fleet shares one NAT address, so its public reads (`getUserById`,
  `getProfileByUsername`, …) paid the delay together once past the threshold.
  A first-party service token is exempt and charged to its own application.
  Measured from Mention's task: `GET /users/:id` 543–575 ms anonymous past the
  threshold; `POST /users/by-ids` 19–24 ms with the service token
  (OxyHQ/Mention#1173). `getUsersByIds` already chose the service path on its
  own (1.12.1); this extends the same identity to every call.
- `HttpService.setAnonymousAuthProvider(provider)`: the hook the option uses,
  consulted only when there is no access token.

## 2.2.0

### Changed

- Locales (all 11): the strings of the email sign-in dialog — `signin.identifier`,
  `signin.checkEmail`, `signin.password`, `signin.secondFactor`, `signin.link`
  (auth.oxy.so's `/email-signin`), new `signin.errors` —, account creation by
  email (`signup`), `reauth`, `signInSecurity` (password, authenticator app,
  backup codes) and `deleteAccount.keyless`; `linkCommons` no longer speaks of a
  recovery email.

### Removed

Passkeys are removed from Oxy (ADR 0030); 2.x is unreleased, so the removals
ship in this same major. Requires `@oxy.so/contracts` ^3.0.0.

- `OxyServices`: `webauthnRegisterOptions`, `webauthnRegisterVerify`,
  `webauthnLoginOptions`, `webauthnLoginVerify`, `removePasskey`,
  `getAccountDeletionOptions`, `deleteAccountWithPasskey`,
  `getIdentityLinkAssertionOptions` and `completeIdentityLink` (a Commons link
  completes with `completeIdentityLinkWithEmailCode`; a keyless account is
  deleted with `deleteAccountWithEmailCode`).
- `SecondFactorRequiredError`: only the passkey sign-ins threw it; the email
  and password sign-ins answer the second-factor step as a value
  (`SignInStepResult`).
- `isOxyRpOrigin` (`utils/webauthnOrigin`) and the `LinkAuthMethodResult` type.
- `startEmailVerification` takes the sign-up request only, and
  `confirmEmailVerification` resolves to `{ ticket, expiresAt }` (contracts 3).
- `buildOxyPagesHeaders` on a sensitive origin sends
  `publickey-credentials-get=()` and `publickey-credentials-create=()`:
  WebAuthn is off everywhere.
- `deleteAccount.handoff.elsewhereMessage` (all 11 locales) no longer points a
  passkey account at auth.oxy.so; the `{{site}}` variable is gone.
- The passkey strings no longer used: `signin.username`, `signin.methods`,
  `signin.recoverLink`, `signin.errors.passkey*`, `signup.passkey`,
  `signup.webSubtitle`, `signup.createAccount`, `signup.commonsInstead`,
  `recover`, `emailCode.sentIfAccount`, `deleteAccount.passkey`,
  `accountSwitcher.useIdentityOnDevice`.

## 2.1.0

Signing in without a passkey: an email code or link, an optional password, an
optional authenticator app (TOTP), and sign-up with a confirmed email.

### Added

- `startEmailSignIn(identifier)`, `confirmEmailSignIn({ requestId,
  requestSecret, code })`, `collectEmailSignIn({ requestId, requestSecret })`
  and, for auth.oxy.so's link page, `approveEmailSignInLink(token)` —
  `POST /auth/signin/email/{start,confirm,collect,link}`. One email carries a
  6-digit code and a one-use link; the link approves only in the browser that
  asked (it proves the same shared device), and only the caller holding the
  `requestSecret` collects the session.
- `signInWithPassword({ identifier, password })` and
  `completeSecondFactor({ challengeId, code })` — `POST /auth/signin/password`
  and `/auth/signin/second-factor`. When the account has an authenticator every
  first factor resolves to `{ secondFactorRequired, challengeId, expiresAt }`
  (no session, no token planted) and the second factor to the session.
- `signUp({ username, email, emailTicket })` — `POST /auth/signup`, with the
  ticket `confirmEmailVerification` returns for a `signup` code.
- Every one of them attaches this client's device proof (`readDeviceProof`,
  ADR 0029 D2) unless `device` is passed (`null` opts out), and plants the
  access token of a session.
- `getSignInMethods()`, `requestReauthEmailCode()`, `setPassword({ newPassword,
  reauth, revokeOtherSessions? })`, `enrollTotp()`, `confirmTotp(code, reauth)`,
  `disableTotp(reauth)`, `regenerateTotpBackupCodes(reauth)` — the signed-in
  account's password and authenticator, each change confirmed by a fresh
  `reauth` proof (the current password or an emailed code, plus the
  authenticator's code once it is on).
- `SecondFactorRequiredError` (`challengeId`, `expiresAt`): thrown by
  `webauthnLoginVerify` and `webauthnRegisterVerify` (recovery) when the
  account has an authenticator — a passkey is a first factor too; finish with
  `completeSecondFactor`.
- `requestReauthEmailCode(action)` names the one change the code confirms.

### Deprecated

- `getAccountDeletionOptions`, `deleteAccountWithPasskey`,
  `getIdentityLinkAssertionOptions`, `completeIdentityLink` and adding a passkey
  to a signed-in account (`webauthnRegisterOptions`/`webauthnRegisterVerify`
  with a bearer): the API refuses them now (a stolen bearer could otherwise
  plant a passkey and use it). Use `deleteAccountWithEmailCode` and
  `completeIdentityLinkWithEmailCode`. They go with passkeys.
- `deleteAccountWithEmailCode(confirmText, reauth)` and
  `completeIdentityLinkWithEmailCode(linkId, reauth)`: deleting an account
  without a key and linking Commons, confirmed by an emailed code instead of a
  passkey.
## 2.0.0

Includes everything in 1.19.0.

### Removed

- **Breaking:** the `jwtSecret` option is removed from `auth()` and
  `serviceAuth()` (and so from `createOxyRateLimit`'s forwarded `auth` options).
  HS256 service tokens are refused: service tokens verify only as Ed25519
  (`alg: EdDSA` with a `kid`) against Oxy's published JWKS at
  `/.well-known/jwks.json`, and the algorithm is pinned, never read from the
  token. The `SERVICE_TOKEN_NOT_CONFIGURED` (403) refusal is gone with it; an
  HS256, `none` or other header is `INVALID_SERVICE_TOKEN` (401) without any
  JWKS fetch. Production has signed only EdDSA since 2026-09-17 (ADR 0012,
  #877). Peable passes `jwtSecret` to `serviceAuth()`/`auth()` today: it keeps
  verifying EdDSA tokens on core 1.x, and must drop the option when it moves to
  core 2.

## 1.19.0

One browser, one session: the browser bridge (ADR 0029 D2).

### Added

- `registerBrowserDevice()`, `requestDeviceJoinCode(request)` and
  `joinBrowserDevice(request)` — `POST /session/device/{register,join-code,join}`,
  bearer-less and validated against the contracts. auth.oxy.so's bridge page
  registers or proves the browser's device and hands an official app a one-use,
  PKCE-bound code; the app redeems it for its own holder credential.
- `setDeviceCredentialProvider(provider)` and `readDeviceProof()`: tell a client
  how to read the device credential it holds, and `claimSessionByToken`,
  `webauthnLoginVerify` and `webauthnRegisterVerify` (sign-up, recovery) send it
  as `device`, so the new session is created on that device. An explicit
  `device: null` opts out. Type `DeviceCredentialProvider`.

### Changed

- The in-session re-mint on the web KEEPS a device credential that answers
  `no_active_session` (it drops only the session fields) instead of clearing the
  store: a joined, signed-out app stays a holder of the browser's device and never
  needs the bridge again. `invalid_device_secret` still clears it.

## 1.18.0

Web accounts are a username, a passkey and a recovery email (ADR 0029 D3). The
web identity carrier is deleted: Commons is the one place a key lives.

### Added

- `startEmailVerification({ purpose: 'signup', email } | { purpose: 'recovery', identifier })`
  and `confirmEmailVerification(verificationId, code)`: a 6-digit code to a
  recovery email, and the one-use ticket it confirms into.
- `webauthnRegisterOptions({ username?, recoveryTicket? })` (was a bare
  `username`) and `webauthnRegisterVerify`'s `email`, `emailTicket` and
  `recoveryTicket`: a sign-up is created with its confirmed recovery email, and
  a recovery registers a new passkey for the account its ticket names.
- `getAccountDeletionOptions()` and `deleteAccountWithPasskey(confirmText, assertion)`:
  a passkey account is deleted with an assertion by one of its passkeys.
- Linking Commons to a passkey account from two devices:
  `createIdentityLink()`, `getIdentityLink(linkId)`,
  `getIdentityLinkAssertionOptions(linkId, challenge)`,
  `completeIdentityLink(linkId, assertion)`, `cancelIdentityLink(linkId)` for
  auth.oxy.so, and `signIdentityLink(linkId, challenge)` for Commons (signs the
  `link_identity` proof with this device's key, native only).
  `deriveIdentityLinkCode(linkId, publicKey)`: the 6-digit code both devices
  show.
- Locale keys in all 11 locales: `signup.username.*`, `signup.email.*`,
  `signup.passkey.*`, `signup.commonsInstead`, `emailCode.*`, `recover.*`
  (replaced), `deleteAccount.passkey.*`, `linkCommons.*`. `signup.webSubtitle` and
  `deleteAccount.handoff.elsewhereMessage` say what a web account is now.

### Removed

- The web identity carrier (`crypto/webIdentityCarrier.ts`): `sealWebIdentity`,
  `openWebIdentity`, `unlockWebIdentity`, `addWrap`, `removeWrap`,
  `markWrapVerified`, `unwrapDataKey`, `deriveKeyEncryptionKey`,
  `generateDataKey`, `generateWebIdentity`, `deriveIdentityFromMnemonic`,
  `deriveIdentityFromPrivateKey`, `deriveIdentityFromRecoveryMaterial`,
  `parseRecoveryMaterial`, `normalizeMnemonic`, `isUsablePrfOutput`,
  `wipeBytes`, `wipeOpenedIdentity`, `WEB_IDENTITY_PRF_INPUT`,
  `WEB_IDENTITY_PRF_OUTPUT_LENGTH`, `WebIdentityUnlockError` and their types.
- The move to Commons (`crypto/identityMove.ts`): `buildMoveQrPayload`,
  `parseMoveQrPayload`, `createMoveCommitment`, `verifyMoveCommitment`,
  `deriveMoveKey`, `deriveMoveSas`, `digestMoveCiphertext`,
  `generateMoveEphemeralKeyPair`, `sealIdentityForMove`, `openMovedIdentity`,
  `signMoveReceipt`, `verifyMoveReceipt`, `MoveReceiptClaims`.
- `checkEmailAvailability`: nothing says whether an email is an account's.
- The `accountMenu.identity` locale key.

## 1.16.0

No identity popups (ADR 0028 D1b).

### Added

- `buildOAuthAuthorizeUrl({ screen })` and `OxyAuthScreen` (`signin`, `signup`,
  `recover`): the IdP screen a person with no session there lands on, for an
  Oxy app that sends them to auth.oxy.so in the same tab.
- `signin.recoverLink` in all 11 locales.

### Removed

- `AccountDialogController.startPasskeyHubSignIn`, the `openPopup` and
  `authOrigin` options, and `PopupWindowHandle`: the account dialog never opens
  a window. What only auth.oxy.so can do happens there, in the same tab.
- The `'cancelled'` `SignInFailureReason`, which only a closed popup produced.

## 1.15.0

The web identity carrier is `auth.oxy.so`; `id.oxy.so` is gone (ADR 0028).

### Added

- `AUTH_WEB_ORIGIN` (`https://auth.oxy.so`): the IdP's origin, which is also
  the web identity carrier. `OXY_AUTHORIZE_URL` is built from it.
- `buildOxyPagesHeaders({ sensitive: true })` serves the whole holder policy:
  `base-uri` and `form-action 'none'`, `Referrer-Policy: no-referrer`, a
  `Permissions-Policy` allowing passkeys for the origin only with every other
  powerful feature off, and `Cross-Origin-Resource-Policy: same-origin`. Never
  COOP: the identity window reports back to its opener.

### Changed

- The account dialog's passkey window opens `<authOrigin>/continue?user_code=…`
  (was `id.oxy.so/continue?code=…`). The parameter is `user_code` because the
  IdP's own `OxyProvider` cold boot consumes a `?code=` as an OAuth return.

### Removed

- `IDENTITY_WEB_ORIGIN`; use `AUTH_WEB_ORIGIN`.
- The controller's `identityOrigin` option; it is `authOrigin`.

## 1.14.0

### Added

- `AccountDialogController.startInlineQr()`: the sign-in screen's embedded
  Commons QR — a request whose only route is the QR, started without leaving
  the current view. It runs no delivery selection (no push to a phone, no
  Commons opened): the screen starts it by itself, so nobody asked for either.
  Any sign-in the person then chooses supersedes it and withdraws its request;
  `retrySignIn()` repeats it.
- `SignInFlowState.inline`: `true` while the attempt is that embedded QR, so a
  host does not report its failures (an expired code is renewed, not news).
- Sign-in copy for the shared sign-in screen in all 11 locales:
  `signin.orContinueWith`, `signin.subtitleToApp`, `signin.noAccount`,
  `signin.createAccount`, `signin.qr.*`, `signin.methods.passkey`,
  `signin.terms.*`, `signin.chooser.subtitleToApp`,
  `signin.errors.{rateLimited,passkeyCancelled,passkeyFailed}`,
  `signup.webSubtitle`. `signin.title`/`subtitle`/`addAccountTitle` and
  `signin.username.placeholder` now read as auth.oxy.so always did.

### Removed

- The `hubBaseUrl` controller option, the deprecated alias of
  `identityOrigin` from when the passkey popup opened `auth.oxy.so/hub-passkey`.
  Nothing passed it; pass `identityOrigin`.
- 102 dictionary keys no surface reads any more, in every locale — the password,
  2FA and email sign-up copy, and the old account switcher's and sign-in
  entry's (`accountSwitcher.passkeyHint`, `continueWithPasskey`,
  `otherDeviceCommons`, `signin.or`, …).

## 1.13.0

### Added

- `verifyAccountEvent(token, { audience?, jwksUrl? })`: verifies an account
  event from Oxy — the body of an account-event webhook, or an entry of the
  pull feed — and returns `{ eventId, type: 'account.deleted', userId,
  username, occurredAt, retained, applicationId, issuedAt }`. The token is a
  Security Event Token (`typ: secevent+jwt`) signed with Oxy's Ed25519 service
  key and checked against the same public JWKS as service tokens; the audience
  defaults to the `appId` of the configured service credential. A service
  token is refused as an event and vice versa. `username` is the handle at
  deletion time, `null` when absent (including tokens that predate the field).
  Refusals throw `OxyAccountEventError` (OxyHQ/Mention#1169).
- `listAccountEvents({ after?, limit? })`: one page of the calling
  application's account events from `GET /account-events`, the reconciliation
  path behind the webhook.

## 1.12.1

### Fixed

- `getUsersByIds` sent an attested backend (ADR 0026: an ECS task with no key
  pair) down the anonymous user path, because it asked only whether a key pair
  was configured. Every chunk then went out with no bearer, was charged to the
  shared NAT address's per-IP budget and paid its 500ms slow-down penalty:
  measured from Mention's task, 520ms per chunk against 20ms with the service
  token, which put Mention's 1.5s author-hydration deadline out of reach on
  every cache miss. A host that can attest now takes the service path.

## 1.12.0

### Added

- `AccountDialogController.chooseContext(contextId)`: the one entry point for
  a chosen device-account row. Signed in it is a switch (`'current'` for the
  active row, else `activateContext`). Signed out it is "Continue as
  @handle": the same `signInWithOxy()` path as the "Continue with Oxy" button
  (silent through the shared identity, else the request), and when the silent
  mint lands on a different pair from the chosen row, that row is activated
  under the new bearer. Resolves a `ContextChoiceOutcome`.
- `AccountDialogSnapshot.hasSession`: whether this client holds a bearer. The
  device directory can keep listing a shared identity (Commons') after the app
  signed out, so hosts must not infer "signed in" from its size.

### Fixed

- Signed out on a device that still lists a shared identity, choosing that
  account signed nobody in: hosts treated the directory's "active" row as
  already signed in and closed the sheet (OxyHQ/oxy#1375 item 20).

## 1.11.0

Requires `@oxy.so/contracts` 1.5.0.

### Added

- Linked accounts mixin: `startLinkedAccount(network, options)`,
  `completeLinkedAccount(code)` (the `link_code` the callback hands
  `returnTo`; only the user who started the flow can complete it),
  `listLinkedAccounts()`, `revokeLinkedAccount(id)`, and the service read
  `getLinkedAccountsForUser(userId)` (privileged `linked-accounts:read`).
- `User.alsoKnownAs`, as `GET /profiles/username/:username` returns it.
- `Notification` gains `type`, `title`, `url`, `entityType` and `entityId`;
  `createNotification` accepts a `CreateOxyNotificationRequest`.
- `ServiceAssetMetadata.ownerUserId`, present only for Oxy's own
  (`tier: 'internal'`) applications.
- The identity device backup (OxyHQ/oxy#1388). `KeyManager.setDeviceBackupStore()`
  registers a store that keeps the identity outside the app's keystore (Commons
  registers Android Block Store). Every identity write refreshes it, the
  verified recovery phrase rides along, every `deleteIdentity` clears it, and
  `KeyManager.ensureDeviceBackup()` backfills or repairs it. Type:
  `IdentityDeviceBackupStore`.
- `attemptIdentityRecovery` gains a third rung, `device-backup`, the only copy
  that survives a wipe of the shared-UID Android Keystore. With a store
  registered it also restores an `absent` identity (the app's own data was
  cleared) instead of reporting `not-lost`. Without a store nothing changes.

## 1.10.0

### Fixed

- A sign-out outranks a token refresh already in flight. `OxyServices.clearTokens()`
  now ends the local session (`HttpService.endSession()`): a re-mint that started
  before it — the device-secret arm, the native shared-keychain arm, or the
  handler's own plant — plants nothing, and the native shared-keychain arm does
  not run again until a token is planted. Before, a refresh that outlived the
  sign-out put the bearer back, and on native a 401 after sign-out re-signed the
  user in with the shared keychain. The device-secret arm still persists the
  rotated secret when the store kept the credential it presented, never refills a
  store the sign-out cleared, and still mints later from a credential the store
  holds (a sign-in made in another tab).

### Added

- `HttpService.endSession()`, `HttpService.getSessionEpoch()` and
  `HttpService.hasSessionEnded()`.
- `DeviceSecretMintOutcome` `session-ended`: the mint succeeded after the session
  was ended, and nothing was planted.

## 1.9.1

### Fixed

- A refresh that returns the SAME still-valid access token (the device mint
  hands back the stored token until it expires) no longer counts as a reason
  to ask again. The request-time preflight sends that token until `exp`, and
  the proactive scheduler waits until just past `exp`
  (`REMINT_AFTER_EXPIRY_MS`) instead of re-minting at its 1s floor. Before,
  every token's last minute cost ~30 mints, tripped the 30/min limit, and the
  429 cooldown outlived the token, so the next request 401'd and the app signed
  out (OxyHQ/Mention#1140). New: `HttpService.isAwaitingCurrentTokenExpiry()`.
- The scheduler no longer re-arms when the same token is planted again.

## 1.9.0

Requires `@oxy.so/protocol` 1.1.1. Includes the crypto-polyfill ordering fix
from #1377 (1.8.1).

### Added

- `AccountDialogController.back()` and `AccountDialogSnapshot.backView`: the
  controller owns where the account dialog's Back leads. `signup` and `qr`
  return to the sign-in entry (`'add'` when somebody is signed in, `'signin'`
  when nobody is), `add` returns to the account menu, and the first view
  reports `backView: null` so the host closes instead. Leaving an active
  request withdraws it.

### Fixed

- The account dialog never shows the `'accounts'` view (the signed-in account
  menu) without a session: `setView('accounts')`, a fresh controller and the
  signed-out edge all resolve to `'signin'`. Signed out, Back from "Create your
  account" used to open the menu, "Sign out" included, for nobody
  (OxyHQ/oxy#1375).
- `DeviceLinkedSession.deviceName` is optional: `GET
  /session/device/sessions/:sessionId` never sends it, and a required type let
  Services render "undefined (This device)".
- i18n: `accounts.manage.switch.countOne` ("1 account", not "1 accounts") and
  `manageAccount.sessions.otherSession` (en-US, es-ES).

## 1.8.0

Requires `@oxy.so/contracts` 1.4.0.

### Added

- `OxyResponsesRequest.reasoning` (`{ effort: 'low' | 'medium' | 'high' }`),
  forwarded to `POST /v1/responses`. The edge refuses an effort the resolved
  model does not list with `invalid_request`.
- `listModels()` / `getModel()` entries now carry
  `capabilities.reasoningEfforts` and, when a provider reported one,
  `releasedAt` (both from `@oxy.so/contracts` 1.4.0).

## 1.7.4

### Fixed

- The auth mixin loads the ADR 0026 workload-identity module through the
  package-private `#workload-identity` import (declared in the `dist/esm` and
  `dist/cjs` scope `package.json` files) instead of a self-reference to the
  `./internal/workload-identity` export, which is removed. A self-reference
  resolves only where `@oxy.so/core` is reachable through `node_modules`, so
  every Vite build inside this workspace failed on 1.7.3's `dist`. Published
  consumers of 1.7.3 were unaffected. `test:package` asserts the resolution
  per condition for both module formats.

## 1.7.3

### Fixed

- Native and browser bundles no longer reach `node:crypto`: the workload
  identity module is routed by package conditions to an inert client
  implementation that can never attest or request a token; only Node hosts get
  the signer.

## 1.5.1

Maintenance release: 1.5.0's `onRefusal` made reachable.

### Fixed

- `onRefusal` is declared on the `OxyServices` interface consumers see, not only
  on the mixin. `src/OxyServices.ts` re-declares `auth()` / `serviceAuth()` by
  hand and that hand-written list is what the published `.d.ts` carries, so a
  host passing the option 1.5.0 advertised got
  `TS2345 … has no properties in common with`.
  `src/__tests__/publicInterfaceParity.test.ts` compares the two declarations.

## 1.5.0

Maintenance release: `1.4.0` plus auth-refusal observability only. It
deliberately excludes the unreleased, breaking identity changes on `main`
(#1302), which ship in the next major.

### Added

- Auth refusals are observable to the host: `auth()` records
  `req.oxyAuthRefusal` (`{ code, stage, reason, status, optional }`), logs one
  `warn` per refusal with a stable code, and accepts an `onRefusal` observer.
  Read it with `getOxyAuthRefusal(req)` from `@oxy.so/core/server`, which also
  names the refusal in the log beside `requireOxyAuth`'s generic 401. Response
  bodies are unchanged, no reason reaches a client, and a credential-free
  request is not a refusal. Additive.

## 1.4.0

Maintenance release cut from the `1.3.1` release commit (`f435259d`) plus the
present-requester assertion work only. It deliberately excludes the unreleased,
breaking identity changes on `main` (#1302), which ship in the next major.

### Added

- Present-requester assertions (ADR 0025): `OxyServices.mintRequesterAssertion`
  lets a pinned first-party product backend trade a signed-in person's live
  session for a one-use, 120-second `OXY-REQUESTER+JWT`, and
  `OxyServices.introspectRequesterAssertion` lets its audience consume it.
  `@oxy.so/core/server` adds `createOxyRequesterAssertionAuth` (mount after
  `createOxyAuthMiddleware`; sets `req.userId` and `req.oxyRequester` only after
  local JWKS verification, presenter binding and live introspection),
  `signOxyRequesterAssertion`, `verifyOxyRequesterAssertion` and
  `createOxyJwksKeyResolver`. Additive.

## Unreleased

### Added

- Identity roots (ADR 0024): `signIdentityProof` / `digestIdentityPayload` sign
  the one payload-bound, one-use v2 root proof; web identity envelopes gain
  version 2 (12–24-word phrases or a raw private key, RP-bound wraps, holder
  `verifiedAt`) alongside `parseRecoveryMaterial`,
  `deriveIdentityFromPrivateKey`, `deriveIdentityFromRecoveryMaterial`,
  `markWrapVerified`, `isUsablePrfOutput` and `wipeOpenedIdentity`.
- `getIdentityRootStatus()` reads the account's root readiness (root linked, web
  holder passkeys, phrase saved, recovery verified) without anything that opens
  the root. `webauthnRegisterVerify` accepts the sign-up `identity` enrollment.

- Identity transfer (ADR 0024 D6): `createMoveCommitment`,
  `verifyMoveCommitment`, `deriveMoveSas({ moveId, initiatorEphemeralPublicKey,
  responderEphemeralPublicKey, initiatorCommitment })`, `digestMoveCiphertext`,
  `signMoveReceipt(sign, claims)`, `verifyMoveReceipt(claims, signature)`. The
  initiator commits to its ephemeral key before the responder joins, so an active
  relay cannot grind substituted keys into matching codes; the receipt binds the
  move, root, both keys and the relayed ciphertext. 12–24-word phrases move.

### Changed

- `OpenedWebIdentity` is now a union of `OpenedMnemonicIdentity` (`kind:
  'mnemonic'`) and `OpenedRawKeyIdentity` (`kind: 'raw-key'`, `mnemonic: null`).
  `openMovedIdentity` returns `OpenedMnemonicIdentity`.
- **Breaking:** web identity envelopes have one scheme. `sealWebIdentity` and
  `addWrap` require the wrap's `rpId`; there is no version-1 envelope.

### Removed

- **Breaking:** `linkIdentityKey`, `unlinkAuthMethod` (the API links a root first
  time only through the holder flow and never unlinks one).
- **Breaking:** the `deviceTransfer` mixin (`/device-transfer*` is gone from the
  API; it had no caller), the version-1 transfer (`deriveMoveSas(moveId, a, b)`,
  `signMoveAction`, `IDENTITY_MOVE_ACTIONS`, timestamped receipts) and the `V2`
  suffixed names, which are now the only ones.

- Native agency-authority methods for catalog discovery, resource-scoped agent
  grants, account autonomy policies, execution-authority revocation, and the
  correlated audit trail used by Oxy Settings.
- Resource-bound external MCP connections can now be listed and revoked without
  exposing access or refresh tokens to clients.

## 1.5.1

Published 2026-09-18 from the maintenance line (tag `@oxy.so/core@1.5.1`: the
1.5.0 release commit plus the interface declaration it was missing). Everything
under "Unreleased" above it did NOT ship; the breaking identity work makes the
next release from `main` a major.

### Fixed

- `onRefusal` is declared on the `OxyServices` interface consumers see, not only
  on the mixin. `src/OxyServices.ts` re-declares `auth()` / `serviceAuth()` by
  hand and that hand-written list is what the published `.d.ts` carries, so a
  host passing the option 1.5.0 advertised got
  `TS2345 … has no properties in common with`.
  `src/__tests__/publicInterfaceParity.test.ts` compares the two declarations.

## 1.5.0

Published 2026-09-18 from the maintenance line (tag `@oxy.so/core@1.5.0`).

### Added

- Auth refusals are observable to the host: `auth()` records
  `req.oxyAuthRefusal` (`{ code, stage, reason, status, optional }`), logs one
  `warn` per refusal with a stable code, and accepts an `onRefusal` observer.
  Read it with `getOxyAuthRefusal(req)` from `@oxy.so/core/server`, which also
  names the refusal in the log beside `requireOxyAuth`'s generic 401. Response
  bodies are unchanged and a credential-free request is not a refusal. (Passing
  `onRefusal` needs 1.5.1 — see above.)

## 1.4.0

Published 2026-09-17 from the maintenance line (tag `@oxy.so/core@1.4.0`: the
1.3.1 release commit plus ADR 0025 only). Everything under "Unreleased" above
it did NOT ship in 1.4.0; the breaking identity work makes the next release
from `main` a major.

### Added

- Present-requester assertions (ADR 0025): `OxyServices.mintRequesterAssertion`
  lets a pinned first-party product backend trade a signed-in person's live
  session for a one-use, 120-second `OXY-REQUESTER+JWT`, and
  `OxyServices.introspectRequesterAssertion` lets its audience consume it.
  `@oxy.so/core/server` adds `createOxyRequesterAssertionAuth` (mount after
  `createOxyAuthMiddleware`; sets `req.userId` and `req.oxyRequester` only after
  local JWKS verification, presenter binding and live introspection),
  `signOxyRequesterAssertion`, `verifyOxyRequesterAssertion` and
  `createOxyJwksKeyResolver`. Additive.

## 23.2.0

### Added

- `OxyResponsesRequest.routingProfileId` lets trusted product integrations name
  an exact opaque Oxy routing-profile primary key. The client serializes the ID
  byte-for-byte; Oxy resolves it before constructing the stable Kaana envelope.
  Existing `model` and public `routingProfile` slug selectors remain compatible.

## 23.0.1

### Added

- Ed25519 capability-ticket issue and verification helpers with key ids,
  strict audience/resource binding and per-action limit enforcement.

### Security: `oxy.auth()` authenticated forged tokens as any account

**Every backend mounting `oxy.auth()` could be authenticated as any user by an
unauthenticated attacker.** Upgrade as soon as a version carrying this ships.

`oxy.auth()` decodes the bearer JWT with `jwtDecode`, which does not verify a
signature — by design, since third-party backends do not hold the Oxy signing
secret. Two claims were nevertheless trusted:

1. **A token carrying no `sessionId` was accepted on its claims alone.** The
   middleware skipped the network entirely and set `req.userId` straight from
   the token's `userId`. Forging a JWT with a victim's id, a future `exp` and a
   garbage signature was enough. Victim ids are public — `GET
   /profiles/username/:handle` returns one without authentication.

2. **On the session path, the identity came from the token, not the session.**
   `GET /session/validate/:sessionId` is unauthenticated and returns whoever
   owns the session id it is handed; it does not bind the bearer token. A caller
   holding any live session id — their own, for instance — could pair it with a
   forged `userId` claim and be trusted as that user.

Both are closed. A user token must now carry a `sessionId`, that session is
validated server-side, and `req.userId` is taken from the validated session and
must match the token's claim.

`authSocket()` already required a session and already cross-checked the claimed
user, and is unaffected. Service tokens are unaffected: they are HMAC-verified
with `aud` / `iss` / `type` checked, and that path is unchanged.

#### New refusals

| Code | When |
| --- | --- |
| `SESSION_REQUIRED` | A user token carries no usable `sessionId`. |
| `SESSION_USER_MISMATCH` | The token's `userId` is not the user the validated session belongs to. |

`INVALID_SESSION` additionally now covers a validation that returns no user, or
a user with no usable id.

Under `optional: true` all of these resolve to anonymous (`req.userId = null`)
rather than to the claimed user.

#### Compatibility

Every user access token the Oxy API issues already carries a `sessionId`, so no
legitimate caller is affected. Anything that relied on a session-less user token
resolving to an identity was relying on the vulnerability.

### Fixed

- `oxy.rateLimit()` no longer erases an identity that a preceding middleware
  resolved. It resolves the session through `createOptionalOxyAuth`, which skips
  when a user is already present, instead of `oxy.auth({ optional: true })`,
  which writes `req.userId = null` on every request it cannot authenticate — a
  mutation of the shared `req` that was visible to every handler downstream of
  the limiter, not just to the bucket calculation.

- A cursor-paginated page now survives the response unwrap. `{ data, …,
  nextCursor }` was reduced to `data` — the convenience unwrap preserved only the
  offset-paginated `{ data, pagination }` envelope and silently discarded every
  other sibling key — so a caller received a bare array, read `undefined` for its
  next cursor, and pagination was dead past the first page with nothing at the
  call site to show it. Measured on `GET /accounts/:id/audit` and `GET
  /accounts/:id/billing/audit`. The rule is deliberately narrow: `data` beside
  `pagination` or `nextCursor` is a page and travels whole; `{ data, count }`,
  `{ data, source }` and the other sibling shapes still unwrap, because a dozen
  Console call sites type those as the bare payload. Linked clients get the fix
  too — they are `HttpService` instances.

## 20.0.0

### Licence: AGPL-3.0-only becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/core` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

This is a widening. Every right the AGPL granted you, Apache-2.0 grants too,
and Apache-2.0 additionally drops the network copyleft and adds an express
patent grant. Nobody has to do anything, and no existing use of this package
becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `19.1.2` stays AGPL-3.0-only for anyone who already has it. A licence
change binds future versions only.

The major is bumped rather than the change being slipped into a patch, so that
nobody on `^19.0.0` is moved to a new licence by a routine install. That is
exactly what happened at `12.5.4`, and it is not happening again.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.

## 17.0.2

### Fixes `17.0.0`, which could not be imported at all

`17.0.0` shipped `@oxy.so/core/server/userInvalidation`, which imports
`OXY_USER_INVALIDATION_CHANNEL`, `isPublishedOxyUserChangeReason` and
`oxyUserInvalidationEventSchema` from `@oxy.so/contracts` — but it pinned
`@oxy.so/contracts@^0.20.0`, and `0.20.0` exports none of them. A clean install of
`17.0.0` therefore failed on any import of `@oxy.so/core/server`:

```
The requested module '@oxy.so/contracts' does not provide an export named
'OXY_USER_INVALIDATION_CHANNEL'
```

That subpath carries `createOxyAuthMiddleware`, `safeFetch`, `createOxyCors` and
`verifySecret`, so a backend on `17.0.0` did not boot. `17.0.2` pins
`@oxy.so/contracts@^0.21.0`, which is the version that actually exports the symbols.
`17.0.0` is deprecated; no consumer had bumped to it. (`17.0.1` was versioned on
`main` but never published, so `17.0.2` is the first release carrying its changes.)

Nothing else changed. `17.0.1`'s wider cache sweep and `17.0.0`'s helpers are
unmodified — this release exists solely to correct the dependency range.

## 17.0.1

### `@oxy.so/core/server` — cross-service identity cache eviction

`evictOxyIdentityCache` now sweeps the same session-bound and `/users/me` prefixes
the user mixin clears after a local profile write, plus `GET:/auth/lookup/` (login-flow
lookup cache). Without these, a cross-service invalidation left stale identity in
session-scoped caches for up to five minutes.

New exports from `@oxy.so/core/server` (shipped in `17.0.0`, documented here):
`publishOxyUserInvalidation`, `createOxyUserInvalidationHandler`, `evictOxyIdentityCache`.

## 17.0.0

Shipped the invalidation publish/consume helpers on `@oxy.so/core/server` for Oxy backends
that cache identity via `OxyServices`. See `packages/core/src/server/userInvalidation.ts`.

## 16.1.0

### Display-name policy — separators admitted, swastika ideographs denied

`isValidDisplayName` / `cleanDisplayName` now admit four punctuation separators that
join real names (`·`, `־`, `་`, `・`) when flanked by letters, and reject the two
swastika ideographs (`卍`, `卐`) that slipped through the letter-only allowlist.

**Minor rather than patch:** the same input can return a different verdict than
`16.0.0` (e.g. `Codeur·euses` is now valid). No API surface changed beyond
`DISPLAY_NAME_INVALID_MESSAGE` (new export for shared client/server copy).

## 16.0.0

### BREAKING — `getServiceAssetMetadataByIds` fails closed by default

Failed chunks now throw `ServiceAssetMetadataError` instead of being swallowed.
A throttled or errored bulk lookup is no longer indistinguishable from “these ids
do not exist”. Pass `{ partial: true }` to keep the previous swallow behaviour as
an explicit opt-in.

### BREAKING — `express-rate-limit` peer range is `^8.0.0`

`server/rateLimit.ts` passes `validate: { keyGeneratorIpFallback: false }`, which
requires v8. The peer previously admitted v7, so nested installs could shadow the
root v8 devDependency and fail `tsc`.

## 15.0.0

### BREAKING — the reputation types moved to `@oxy.so/contracts`

`@oxy.so/core` no longer exports **any** reputation type, nor
`isFullReputationBalance`. The whole family now lives in `@oxy.so/contracts`
(`>= 0.20.0`), which the API's serializers are annotated and validated against —
so a server-side change to the wire shape fails the build instead of silently
diverging from the SDK type, which is what produced the view-split bug below.

**Migration:** change the import source, nothing else. The type names and their
meanings are unchanged.

```diff
-import type { ReputationBalance, TrustTier } from '@oxy.so/core';
-import { isFullReputationBalance } from '@oxy.so/core';
+import type { ReputationBalance, TrustTier } from '@oxy.so/contracts';
+import { isFullReputationBalance } from '@oxy.so/contracts';
```

Affected: `ReputationCategory`, `TrustTier`, `ReputationTransactionStatus`,
`ReputationTargetEntityType`, `ReputationDisputeStatus`,
`ReputationInfluenceContext`, `ReputationTransaction`,
`ReputationBalanceBreakdown`, `ReputationInfluence`, `ReputationReliability`,
`ReputationBalanceSummary`, `ReputationBalance`, `ReputationBalanceView`,
`ReputationDispute`, `ReputationRule`, `ReputationLeaderboardEntry`,
`ReputationInfluenceResult`, `ReverseReputationTransactionResult`,
`AwardReputationInput`, `CreateReputationDisputeInput`,
`ResolveReputationDisputeInput`, `UpsertReputationRuleInput`,
`ReverseReputationTransactionInput`, and `isFullReputationBalance`.

**One shape changed as well.** `ReputationLeaderboardEntry.user` was
`Pick<User, …> & Partial<User>`; it is now the pinned
**`ReputationLeaderboardUser`** (`id`, `username`, `name`, `avatar?`,
`publicKey?`). The API was emitting Mongo's `_id` on that object, so `user.id`
was `undefined` for every leaderboard row — it now really is the user id.

### BREAKING — reputation balance view split

`GET /reputation/:userId/balance` has always served two shapes (subject/staff vs
public), but the SDK type still declared the full `ReputationBalance` for every
caller. That let `balance.reliability.*` type-check on a stranger's balance and
throw at runtime.

- **`getReputationBalance(userId)`** now returns **`ReputationBalanceView`**
  (`ReputationBalance | ReputationBalanceSummary`). Only `userId`, `total`, and
  `trustTier` are reachable without narrowing.
- **`getMyReputationBalance()`** — new ergonomic path for the signed-in user's
  own balance; returns **`ReputationBalance`** directly and throws
  `OxyAuthenticationError` when the server answers with the public view (absent
  or lapsed token).
- **`isFullReputationBalance(balance)`** — type guard to narrow
  `ReputationBalanceView` to `ReputationBalance`.
- New types: **`ReputationBalanceSummary`**, **`ReputationBalanceView`**.

**Migration:** for your own balance, call `getMyReputationBalance()`. For a
third party's `total` / `trustTier`, keep `getReputationBalance(userId)`. For
private fields on an arbitrary id (subject or staff only), narrow with
`isFullReputationBalance()` before reading `breakdown`, `influence`, or
`reliability`.

## 14.0.0

Same content as 13.2.0, republished under a correct major. See the 13.2.0 entry
below for what actually changed — everything there applies here.

`13.2.0` is **deprecated on npm** and points at this version.

## 13.2.0 — DEPRECATED (shipped a breaking change under a MINOR)

> **Read this if you consume `@oxy.so/core` directly.** 13.2.0 contains a
> **runtime-breaking change to a publicly exported function** and was published
> as a MINOR, so a `^13.0.0` range could pick it up silently. It has since been
> deprecated, and npm now resolves `^13.0.0` to `13.0.0` rather than `13.2.0`;
> installing `13.2.0` explicitly still works but warns. The identical content is
> available as **14.0.0** under the correct major — prefer `^14.0.0`.

### BREAKING — `buildPaginationParams` return type

`buildPaginationParams(params)` now returns a plain **`Record<string, string>`**.
It previously returned a **`URLSearchParams`**.

**You are affected if** you call `URLSearchParams` methods on the result —
`.toString()`, `.get()`, `.append()`, `.set()`, `.has()`, `.entries()`,
`.forEach()`, or iterate it with `for...of`. Those now throw a `TypeError`,
because a plain object has none of them. This is a runtime failure, not a
compile error, so TypeScript will not necessarily catch it for you.

**Migration:** use `buildSearchParams(params)`, which is unchanged and still
returns a `URLSearchParams`.

```ts
// before
const qs = buildPaginationParams({ limit: 20 }).toString();
// after
const qs = buildSearchParams({ limit: 20 }).toString();
```

**You are NOT affected if** you passed the result to `makeRequest` /
`HttpService` — the overwhelmingly common use, and the one this change exists to
repair. That path was already broken; see below.

### Fixed — follow-graph pagination was silently ignored, and every page shared one cache entry

`buildPaginationParams` returned a `URLSearchParams`, which was then handed to
`makeRequest` as a GET's `params`. `HttpService` inspects that object with
`Object.keys(...)` in two places — `buildURL`, to decide whether to append a
query string, and `generateBaseCacheKey`, to build the request's cache key — and
`Object.keys(new URLSearchParams({ limit: '20' }))` is `[]`, because a
`URLSearchParams` exposes its entries through iterator methods rather than own
enumerable properties. Both guards therefore saw an empty object.

Two consequences, both silent at the call site:

- **No query string was ever sent.** `getUserFollowers`, `getUserFollowing`,
  `getUserMutuals`, `getMutualUserIds` and `getFollowsOfFollowsIds` all returned
  the server's default page no matter what `limit`/`offset` the caller passed.
- **Every page collapsed onto ONE cache key**, so a request for page 2 was served
  page 1's cached body without a network call.

```
before  GET /users/abc/followers
        cache key  GET:/users/abc/followers
after   GET /users/abc/followers?limit=20&offset=40
        cache key  GET:/users/abc/followers:{"limit":"20","offset":"40"}
```

`buildSearchParams` and `buildUrl` are unchanged in behaviour (their parameter
types were widened to a generic, which is strictly more permissive).

### Fixed — follow/unfollow did not invalidate the follower/following lists

`followUser`, `unfollowUser`, `followUsers` and `unfollowUsers` cleared
`follow-status`, `/users/:id`, the profile caches and `/users/me/graph`, but
never `/users/:id/followers`, `/users/:id/mutuals`, or the viewer's own
`/users/:id/following`. With the cache key fixed above, those lists became
properly content-addressed, so stale variants would have multiplied instead of
collapsing onto one entry.

All four mutation paths now funnel through a single
`invalidateFollowGraphCaches` helper, which clears the lists **by prefix** — one
logical list spans many keys (one per `limit`/`offset`/`sort` combination), so an
exact-key clear would only bust whichever page happened to be read last.

### Added — `sort` on the follow-graph reads

`getUserFollowers`, `getUserFollowing` and `getUserMutuals` accept
`sort?: 'recent' | 'oldest'` via the new `FollowGraphParams` type. Omitted leaves
the server default (`recent`). The shared `PaginationParams` is deliberately
unchanged — many endpoints have no `sort`.

New exports: `buildQueryParams`, and the types `FollowGraphSort` /
`FollowGraphParams`.
