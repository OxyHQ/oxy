import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  MESSAGE_ACCESS_MAX_SUPERVISED_PARTICIPANTS,
  type DeliveryAccessInput,
  type ContentAccessInput,
  type SafetyDecision,
  type SupervisedAction,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users, blocks, supervisionProfiles, supervisionContacts } from '../db/schema';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import { visibleOrganizationIdentityPredicate } from '../utils/profileQuery';

export const safetyDecision = (
  allowed: boolean,
  reason: SafetyDecision['reason'],
): SafetyDecision => ({ allowed, reason, policyVersion: '2' });
export function consumerSupports(
  principal: LiveAgencyServicePrincipal | null,
  action: SupervisedAction | 'messaging-delivery' | 'content-publication',
): boolean {
  return (
    !!principal &&
    principal.scopes.includes('safety:decide') &&
    principal.capabilities.includes(`safety:${action}:v1`)
  );
}
/** Always live: cached pre-enrollment identities and revoked consumer grants cannot suppress this policy. */
export async function isSupervised(accountId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: supervisionProfiles.childAccountId })
    .from(supervisionProfiles)
    .where(
      and(
        eq(supervisionProfiles.childAccountId, accountId),
        ne(supervisionProfiles.status, 'ended'),
      ),
    )
    .limit(1);
  return !!row;
}
export async function loadSafetyGraph(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length)
    return {
      accounts: new Map<string, never>(),
      profiles: new Map<string, never>(),
      blocks: new Set<string>(),
      contacts: new Set<string>(),
    };
  const db = getDb();
  const [accounts, profiles, blockRows, contacts] = await Promise.all([
    db
      .select({
        id: users.id,
        status: users.accountStatus,
        kind: users.kind,
        reputation: users.reputationTier,
        private: users.privacyIsPrivateAccount,
        visible: users.privacyProfileVisibility,
      })
      .from(users)
      .where(and(inArray(users.id, unique), visibleOrganizationIdentityPredicate())),
    db
      .select({
        childAccountId: supervisionProfiles.childAccountId,
        guardianAccountId: supervisionProfiles.guardianAccountId,
        status: supervisionProfiles.status,
      })
      .from(supervisionProfiles)
      .where(
        and(
          inArray(supervisionProfiles.childAccountId, unique),
          ne(supervisionProfiles.status, 'ended'),
        ),
      ),
    db
      .select({ from: blocks.userId, to: blocks.blockedId })
      .from(blocks)
      .where(and(inArray(blocks.userId, unique), inArray(blocks.blockedId, unique))),
    db
      .select({
        child: supervisionContacts.childAccountId,
        contact: supervisionContacts.contactAccountId,
      })
      .from(supervisionContacts)
      .where(
        and(
          inArray(supervisionContacts.childAccountId, unique),
          inArray(supervisionContacts.contactAccountId, unique),
        ),
      ),
  ]);
  // Guardians are authorization dependencies even when they are not conversation participants.
  const guardianIds = [
    ...new Set(
      profiles.flatMap((profile) => (profile.guardianAccountId ? [profile.guardianAccountId] : [])),
    ),
  ].filter((id) => !unique.includes(id));
  const guardians = guardianIds.length
    ? await db
        .select({
          id: users.id,
          status: users.accountStatus,
          kind: users.kind,
          reputation: users.reputationTier,
          private: users.privacyIsPrivateAccount,
          visible: users.privacyProfileVisibility,
        })
        .from(users)
        .where(inArray(users.id, guardianIds))
    : [];
  return {
    accounts: new Map([...accounts, ...guardians].map((a) => [a.id, a])),
    profiles: new Map(profiles.map((p) => [p.childAccountId, p])),
    blocks: new Set(blockRows.flatMap((b) => [`${b.from}:${b.to}`, `${b.to}:${b.from}`])),
    contacts: new Set(contacts.map((c) => `${c.child}:${c.contact}`)),
  };
}
type Graph = Awaited<ReturnType<typeof loadSafetyGraph>>;
function available(graph: Graph, id: string) {
  const account = graph.accounts.get(id);
  return account?.status === 'active' && account.reputation !== 'restricted';
}
function approved(graph: Graph, child: string, other: string) {
  const profile = graph.profiles.get(child);
  return (
    !profile ||
    (!!profile.guardianAccountId &&
      profile.status === 'active' &&
      available(graph, profile.guardianAccountId) &&
      graph.accounts.get(profile.guardianAccountId)?.kind === 'personal' &&
      (profile.guardianAccountId === other || graph.contacts.has(`${child}:${other}`)))
  );
}
function pair(
  graph: Graph,
  left: string,
  right: string,
  principal: LiveAgencyServicePrincipal | null,
  action: SupervisedAction,
): SafetyDecision {
  if (!available(graph, left) || !available(graph, right))
    return safetyDecision(false, 'unavailable');
  if (graph.blocks.has(`${left}:${right}`)) return safetyDecision(false, 'blocked');
  if (
    (graph.profiles.has(left) || graph.profiles.has(right)) &&
    !consumerSupports(principal, action)
  )
    return safetyDecision(false, 'unsupported_consumer');
  if (!approved(graph, left, right) || !approved(graph, right, left))
    return safetyDecision(false, 'contact_not_approved');
  return safetyDecision(true, 'allowed');
}
function decideMessageGraph(
  participantIds: string[],
  senderId: string,
  principal: LiveAgencyServicePrincipal | null,
  graph: Graph,
): SafetyDecision {
  if (!participantIds.includes(senderId) || !available(graph, senderId))
    return safetyDecision(false, 'unavailable');
  const supervised = participantIds.filter((id) => graph.profiles.has(id));
  if (
    supervised.length &&
    (!consumerSupports(principal, 'messaging') ||
      participantIds.length > MESSAGE_ACCESS_MAX_SUPERVISED_PARTICIPANTS)
  )
    return safetyDecision(false, 'unsupported_consumer');
  for (const child of supervised) {
    const profile = graph.profiles.get(child);
    if (
      !profile?.guardianAccountId ||
      profile.status !== 'active' ||
      !available(graph, profile.guardianAccountId) ||
      graph.accounts.get(profile.guardianAccountId)?.kind !== 'personal'
    )
      return safetyDecision(false, 'contact_not_approved');
    for (const other of participantIds) {
      if (child === other) continue;
      const decision = pair(graph, child, other, principal, 'messaging');
      if (!decision.allowed) return decision;
    }
  }
  // Adult group membership and blocking semantics remain the consumer's existing policy.
  return safetyDecision(true, 'allowed');
}
export async function decideMessagesBatch(
  items: DeliveryAccessInput[],
  principal: LiveAgencyServicePrincipal | null,
) {
  const graph = await loadSafetyGraph(items.flatMap((item) => item.participantAccountIds));
  return {
    items: items.map((item) => ({
      resourceId: item.resourceId,
      decision: decideMessageGraph(
        item.participantAccountIds,
        item.senderAccountId,
        principal,
        graph,
      ),
    })),
  };
}
export async function decideMessages(
  participantIds: string[],
  senderId: string,
  principal: LiveAgencyServicePrincipal | null,
): Promise<SafetyDecision> {
  return decideMessageGraph(
    participantIds,
    senderId,
    principal,
    await loadSafetyGraph(participantIds),
  );
}
export async function decideContacts(
  targetIds: string[],
  requester: string,
  principal: LiveAgencyServicePrincipal | null,
) {
  const graph = await loadSafetyGraph([...targetIds, requester]);
  return {
    items: targetIds.map((targetAccountId) => ({
      targetAccountId,
      decision:
        targetAccountId === requester
          ? safetyDecision(available(graph, requester), 'owner')
          : pair(graph, requester, targetAccountId, principal, 'messaging'),
    })),
  };
}
export async function decideProfiles(
  subjectIds: string[],
  requester: string | null,
  principal: LiveAgencyServicePrincipal | null,
) {
  const graph = await loadSafetyGraph(requester ? [...subjectIds, requester] : subjectIds);
  return {
    items: subjectIds.map((subjectAccountId) => {
      let decision: SafetyDecision;
      const subject = graph.accounts.get(subjectAccountId);
      if (!available(graph, subjectAccountId) || (requester && !available(graph, requester)))
        decision = safetyDecision(false, 'unavailable');
      else if (requester && graph.blocks.has(`${subjectAccountId}:${requester}`))
        decision = safetyDecision(false, 'blocked');
      else if (
        (graph.profiles.has(subjectAccountId) || (requester && graph.profiles.has(requester))) &&
        !consumerSupports(principal, 'profile')
      )
        decision = safetyDecision(false, 'unsupported_consumer');
      else if (subjectAccountId === requester) decision = safetyDecision(true, 'owner');
      else if (!subject?.visible) decision = safetyDecision(false, 'private');
      else if (graph.profiles.has(subjectAccountId))
        decision =
          requester &&
          approved(graph, subjectAccountId, requester) &&
          approved(graph, requester, subjectAccountId)
            ? safetyDecision(true, 'allowed')
            : safetyDecision(false, 'private');
      else if (subject?.private || !subject?.visible) decision = safetyDecision(false, 'private');
      else decision = safetyDecision(true, 'public');
      return { subjectAccountId, decision };
    }),
  };
}
export async function decideContent(
  items: ContentAccessInput[],
  requester: string | null,
  principal: LiveAgencyServicePrincipal | null,
) {
  const graph = await loadSafetyGraph([
    ...(requester ? [requester] : []),
    ...items.flatMap((item) => (item.authorAccountId ? [item.authorAccountId] : [])),
  ]);
  const supervisedViewer = !!requester && graph.profiles.has(requester);
  return {
    items: items.map((item) => {
      const author = item.authorAccountId;
      const supervisedAuthor = !!author && graph.profiles.has(author);
      let decision: SafetyDecision = safetyDecision(true, 'allowed');
      if ((requester && !available(graph, requester)) || (author && !available(graph, author)))
        decision = safetyDecision(false, 'unavailable');
      else if ((supervisedViewer || supervisedAuthor) && !consumerSupports(principal, 'content'))
        decision = safetyDecision(false, 'unsupported_consumer');
      else if (author && requester && graph.blocks.has(`${author}:${requester}`))
        decision = safetyDecision(false, 'blocked');
      else if (
        author &&
        requester !== author &&
        !supervisedAuthor &&
        (graph.accounts.get(author)?.private || !graph.accounts.get(author)?.visible) &&
        !item.applicationResourceGrant
      )
        decision = safetyDecision(false, 'private');
      else if (
        author &&
        requester &&
        supervisedViewer &&
        requester !== author &&
        (item.audience === 'private' ||
          item.audience === 'followers' ||
          graph.accounts.get(author)?.private) &&
        !approved(graph, requester, author)
      )
        decision = safetyDecision(false, 'contact_not_approved');
      else if (item.operation === 'manage_own' && author !== requester)
        decision = safetyDecision(false, 'private');
      else if (
        supervisedViewer &&
        item.classification !== 'general' &&
        !(item.operation === 'manage_own' && author === requester)
      )
        decision = safetyDecision(
          false,
          item.classification === 'mature' ? 'mature_content' : 'unrated_content',
        );
      else if (author && author !== requester && supervisedAuthor) {
        // This is the explicit private-content decision; applications must not infer it from profile visibility.
        decision =
          supervisedAuthor &&
          requester &&
          approved(graph, author, requester) &&
          approved(graph, requester, author)
            ? safetyDecision(true, 'allowed')
            : safetyDecision(false, 'private');
      } else if (!supervisedAuthor && item.applicationAudienceAllowed === false)
        decision = safetyDecision(false, 'private');
      return { resourceId: item.resourceId, decision };
    }),
  };
}

/** Media has no trusted general-rating producer yet. Own-file management is distinct from consumption. */
export async function decideSupervisedAsset(
  owner: string | null,
  viewer: string | undefined,
): Promise<SafetyDecision | null> {
  const graph = await loadSafetyGraph([...(owner ? [owner] : []), ...(viewer ? [viewer] : [])]);
  return supervisedAssetDecision(graph, owner, viewer);
}

function supervisedAssetDecision(
  graph: Graph,
  owner: string | null,
  viewer: string | undefined,
): SafetyDecision | null {
  const ownerSupervised = owner !== null && graph.profiles.has(owner);
  const viewerSupervised = viewer !== undefined && graph.profiles.has(viewer);
  if (!ownerSupervised && !viewerSupervised) return null;
  if (viewer && !available(graph, viewer)) return safetyDecision(false, 'unavailable');
  if (owner && !available(graph, owner)) return safetyDecision(false, 'unavailable');
  if (owner === viewer) return safetyDecision(true, 'owner');
  if (viewerSupervised) return safetyDecision(false, 'unrated_content');
  if (!owner || !viewer) return safetyDecision(false, 'private');
  if (graph.blocks.has(`${owner}:${viewer}`)) return safetyDecision(false, 'blocked');
  return approved(graph, owner, viewer)
    ? safetyDecision(true, 'allowed')
    : safetyDecision(false, 'contact_not_approved');
}

/** Request-local bulk authority, never accepted from request metadata or cached across requests. */
export type SupervisedAssetPolicy = (
  owner: string | null,
  viewer: string | undefined,
) => SafetyDecision | null;
export async function createSupervisedAssetPolicy(
  owners: Array<string | null>,
  viewer: string | undefined,
): Promise<SupervisedAssetPolicy> {
  const ownerSet = new Set(owners);
  const graph = await loadSafetyGraph([
    ...owners.filter((id): id is string => id !== null),
    ...(viewer ? [viewer] : []),
  ]);
  return (owner, actualViewer) =>
    actualViewer !== viewer || !ownerSet.has(owner)
      ? safetyDecision(false, 'unavailable')
      : supervisedAssetDecision(graph, owner, viewer);
}

export async function publicationPolicies(
  authorIds: string[],
  principal: LiveAgencyServicePrincipal,
) {
  const graph = await loadSafetyGraph(authorIds);
  return {
    items: authorIds.map((authorAccountId) => {
      const supervised = graph.profiles.has(authorAccountId);
      return {
        authorAccountId,
        policy: {
          publicationAllowed:
            available(graph, authorAccountId) &&
            (!supervised || consumerSupports(principal, 'content')),
          requiredAudience: supervised ? ('private' as const) : null,
          collaborationAllowed: !supervised,
          federationAllowed: !supervised,
          policyVersion: '2' as const,
        },
      };
    }),
  };
}
