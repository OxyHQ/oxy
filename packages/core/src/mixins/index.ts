/**
 * Centralized mixin exports and composition helper
 *
 * This module provides a clean way to compose all mixins
 * and ensures consistent ordering for better maintainability
 */

import { OxyServicesBase } from '../OxyServices.base';
import { OxyServicesAuthMixin } from './OxyServices.auth';
import { OxyServicesUserMixin } from './OxyServices.user';
import { OxyServicesIdentityMixin } from './OxyServices.identity';
import { OxyServicesIdentityBackupMixin } from './OxyServices.identityBackup';
import { OxyServicesPrivacyMixin } from './OxyServices.privacy';
import { OxyServicesLanguageMixin } from './OxyServices.language';
import { OxyServicesPaymentMixin } from './OxyServices.payment';
import { OxyServicesReputationMixin } from './OxyServices.reputation';
import { OxyServicesAssetsMixin } from './OxyServices.assets';
import { OxyServicesAccountsMixin } from './OxyServices.accounts';
import { OxyServicesConnectedAppsMixin } from './OxyServices.connectedApps';
import { OxyServicesAgencyMixin } from './OxyServices.agency';
import { OxyServicesStoreMixin } from './OxyServices.store';
import { OxyServicesLocationMixin } from './OxyServices.location';
import { OxyServicesAnalyticsMixin } from './OxyServices.analytics';
import { OxyServicesDevicesMixin } from './OxyServices.devices';
import { OxyServicesSecurityMixin } from './OxyServices.security';
import { OxyServicesUtilityMixin } from './OxyServices.utility';
import { OxyServicesFeaturesMixin } from './OxyServices.features';
import { OxyServicesTopicsMixin } from './OxyServices.topics';
import { OxyServicesContactsMixin } from './OxyServices.contacts';
import { OxyServicesNotificationsMixin } from './OxyServices.notifications';
import { OxyServicesAppDataMixin } from './OxyServices.appData';
import { OxyServicesCivicMixin } from './OxyServices.civic';
import { OxyServicesChainsMixin } from './OxyServices.chains';
import { OxyServicesNodesMixin } from './OxyServices.nodes';
import { OxyServicesLinksMixin } from './OxyServices.links';
import { OxyServicesFollowGraphMixin } from './OxyServices.followGraph';
import { OxyServicesInferenceMixin } from './OxyServices.inference';
import { OxyServicesDeviceBootMixin } from './OxyServices.deviceBoot';
import { OxyServicesDeviceTransferMixin } from './OxyServices.deviceTransfer';

/**
 * Instance shape of every mixin in the pipeline, intersected. The runtime
 * `composeOxyServices()` produces a class whose instances expose all of
 * these methods; we surface that to TypeScript via this intersection so the
 * `extends` site in `OxyServices.ts` can avoid an `as any` cast.
 *
 * If you add a new mixin to `MIXIN_PIPELINE`, add it here too so its methods
 * are visible without a cast.
 */
type AllMixinInstances =
  & InstanceType<ReturnType<typeof OxyServicesAuthMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesUserMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesIdentityMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesIdentityBackupMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesPrivacyMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesLanguageMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesPaymentMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesReputationMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesAssetsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesAccountsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesConnectedAppsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesAgencyMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesStoreMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesLocationMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesAnalyticsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesDevicesMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesSecurityMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesFeaturesMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesTopicsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesContactsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesNotificationsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesAppDataMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesCivicMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesChainsMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesNodesMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesLinksMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesFollowGraphMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesInferenceMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesDeviceBootMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesDeviceTransferMixin<typeof OxyServicesBase>>>
  & InstanceType<ReturnType<typeof OxyServicesUtilityMixin<typeof OxyServicesBase>>>;

/**
 * Constructor type for the fully composed mixin pipeline. Each mixin returns
 * a new constructor that augments its input; reducing across the pipeline
 * yields an instance with every mixin's methods.
 */
export type ComposedOxyServicesConstructor = new (config: import('../OxyServices.base').OxyConfig) => AllMixinInstances;

/**
 * A mixin function: takes a constructor and returns an augmented constructor.
 * Each individual mixin uses a `<T extends typeof OxyServicesBase>` generic
 * to preserve its specific augmentations, but those refinements are
 * intentionally collapsed across the `reduce` call below.
 */
type MixinFunction = (Base: new (...args: unknown[]) => OxyServicesBase) => new (...args: unknown[]) => OxyServicesBase;

/**
 * Mixin pipeline - applied in order from first to last.
 *
 * Order matters for dependencies:
 * 1. Base auth mixin first (required by all others)
 * 2. User mixin (requires auth)
 * 3. Feature mixins (can depend on user)
 * 4. Utility mixin last (augments all)
 *
 * To add a new mixin: insert it at the appropriate position in this array.
 */
const MIXIN_PIPELINE: MixinFunction[] = [
    // Base authentication
    OxyServicesAuthMixin,

    // User management (requires auth)
    OxyServicesUserMixin,
    // Self-sovereign identity (DID, signed records, auth-method ↔ VM mapping)
    OxyServicesIdentityMixin,
    // Encrypted off-device identity backup (b3 Feature 1): store/restore an
    // encrypted copy of the self-custody key, keyed off the recovery phrase.
    OxyServicesIdentityBackupMixin,
    OxyServicesPrivacyMixin,

    // Feature mixins
    OxyServicesLanguageMixin,
    OxyServicesPaymentMixin,
    OxyServicesReputationMixin,
    OxyServicesAssetsMixin,
    // Unified account graph + the applications owned within it. The clean-cut
    // replacement for the former managedAccounts + workspaces + applications
    // (account-management) mixins.
    OxyServicesAccountsMixin,
    // OAuth-consent surface (public app identity + connected-app grants). Kept
    // separate from account ownership.
    OxyServicesConnectedAppsMixin,
    // Oxy-owned delegated authority for Alia and digital-agent accounts.
    OxyServicesAgencyMixin,
    // The app store: the public storefront, the reviews on it, and the listing a
    // publisher edits. A module OVER the platform — turn it off and OAuth still
    // works — so it is its own surface rather than more of `accounts`.
    OxyServicesStoreMixin,
    OxyServicesLocationMixin,
    OxyServicesAnalyticsMixin,
    OxyServicesDevicesMixin,
    OxyServicesSecurityMixin,
    OxyServicesFeaturesMixin,
    OxyServicesTopicsMixin,
    OxyServicesContactsMixin,
    // Push-token registration: the one SDK-owned register/unregister pair every
    // Oxy app uses, and what lets a "Sign in with Oxy" request be delivered to a
    // known Commons installation instead of falling back to a QR.
    OxyServicesNotificationsMixin,
    OxyServicesAppDataMixin,
    // Civic / Commons "Oxy ID" (public signed cards, Oxy ID QR payload)
    OxyServicesCivicMixin,
    OxyServicesChainsMixin,
    // User nodes / decentralization (Fase 5): register/read/revoke/manage the
    // caller's personal data node + ingest hint.
    OxyServicesNodesMixin,
    // Link previews / unfurls: SDK-owned link-metadata resolution via oxy-api,
    // so apps stop scraping link metadata locally.
    OxyServicesLinksMixin,
    // The user-owned follow graph (#809). One relationship per user and target,
    // shared across applications, with per-application context on top.
    OxyServicesFollowGraphMixin,

    // The inference model catalogue (#972). Reads only, and deliberately no
    // request/stream/receipt methods — the public inference edge those would
    // call is workstream 4 and does not exist yet. See
    // `docs/inference/README.md` for what is and is not built.
    OxyServicesInferenceMixin,

    // Device-first token mint: the client half of the zero-cookie transport
    // (`mintFromDeviceSecret` → `POST /session/device/token`).
    OxyServicesDeviceBootMixin,

    // Device-to-device identity transfer ("add a device"): E2E-encrypted key
    // clone over a short-lived relay (b3 Feature 2).
    OxyServicesDeviceTransferMixin,

    // Utility (last, can use all above)
    OxyServicesUtilityMixin,
];

/**
 * Composes all OxyServices mixins using a pipeline pattern.
 *
 * This is equivalent to the nested calls but more readable and maintainable.
 * Adding a new mixin: add it to MIXIN_PIPELINE at the appropriate position
 * AND extend `AllMixinInstances` so its methods are visible to consumers.
 *
 * The cast through `unknown` carries the runtime augmentation chain into the
 * static type system. `Array.reduce` cannot track each mixin's generic
 * refinement, so we assert the final shape exposed by all mixins together.
 *
 * @returns The fully composed OxyServices constructor with all mixins applied
 */
export function composeOxyServices(): ComposedOxyServicesConstructor {
    const composed = MIXIN_PIPELINE.reduce(
        (Base, mixin) => mixin(Base),
        OxyServicesBase as unknown as new (...args: unknown[]) => OxyServicesBase
    );
    return composed as unknown as ComposedOxyServicesConstructor;
}

// Export the pipeline for testing/debugging
export { MIXIN_PIPELINE };
