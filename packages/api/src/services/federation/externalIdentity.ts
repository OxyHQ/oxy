/**
 * The shapes an external-identity resolve passes around, and the resolve answer
 * it ends in.
 */

import {
  getCanonicalUserRedirects,
  getExternalIdentitiesForUser,
} from '../externalIdentityRegistry.service';
import { userService, type AccountDocument } from '../user.service';
import { externalProfileKind, type ExternalActorProfile } from './externalIdentityPolicy';

/** A source profile fetched now, with the document it was derived from. */
export interface SourceObservation {
  profile: ExternalActorProfile;
  document?: Record<string, unknown>;
}

/**
 * Filled by a resolve whose source answered an HTTP error: the status it
 * answered, so a caller can tell a gone actor (410) from one that is not there.
 */
export interface SourceFailure {
  sourceStatus?: number;
}

/** One source actor of an external identity, as the registry stores it. */
export interface StoredExternalSource {
  canonicalAcct: string;
  network: string;
  protocol: string;
  actorUri: string;
  transportAcct: string;
}

export interface WebFingerResolution {
  actorUri: string;
  subjectAcct?: string;
}

/**
 * The text a source profile hands the identity registry: the name UNCLEANED
 * (the registry cleans it by kind) and the kind the source declares.
 */
export function federatedProfile(profile: ExternalActorProfile) {
  return { displayName: profile.displayName, bio: profile.bio, kind: externalProfileKind(profile) };
}

/** The resolve answer for one verified source of a canonical person. */
export async function identityResponse(
  user: AccountDocument,
  canonicalUserId: string,
  source: StoredExternalSource,
  fallbackSourceUserId: string,
  identityProof?: { state: string; reason?: string },
  sourceDocument?: Record<string, unknown>,
) {
  const [externalIdentities, redirectedUserIds] = await Promise.all([
    getExternalIdentitiesForUser(canonicalUserId),
    getCanonicalUserRedirects(canonicalUserId),
  ]);
  const sourceUserId =
    externalIdentities.find((identity) => identity.actorUri === source.actorUri)?.sourceUserId ??
    fallbackSourceUserId;
  return {
    user: { ...userService.formatUserResponse(user), externalIdentities, redirectedUserIds },
    externalIdentity: { ...source, userId: canonicalUserId, sourceUserId },
    externalIdentities,
    redirectedUserIds,
    identityProof,
    ...(sourceDocument ? { sourceDocument } : {}),
  };
}
