import type {
  ProfileAccessInput,
  PurchaseReviewInput,
  SafetyOrganizationsInput,
  SafetyPeopleInput,
  SupervisionAcceptInput,
  SupervisionContactInput,
  SupervisionInviteInput,
  SupervisionReviewInput,
} from '@oxy.so/contracts';
import {
  parseContract,
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
} from '@oxy.so/contracts/client';
import type { OxyContext } from '../client/context';

/**
 * Authoritative policy reads and supervision management for the signed-in
 * person; no persistent decision cache and no inferred app identity.
 *
 * The consumer-service decision lanes (`messageAccessBatch`, `deliveryAccess`,
 * purchase reservation, …) are on `OxyServer`'s `safety`, from
 * `@oxy.so/core/server`.
 */
export class SafetyApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** The signed-in person's read, or explicit anonymous access (`{ accessToken: null }`). */
  async profileAccess(input: ProfileAccessInput, options?: { accessToken: string | null }) {
    if (this.ctx.service && options === undefined)
      throw new Error('Server profile access requires an explicit requester bearer or null');
    return parseContract(
      profileAccessDecisionCheck,
      await this.ctx.request(
        'GET',
        '/safety/profile-access',
        parseContract(profileAccessInputCheck, input),
        {
          cache: false,
          ...(options
            ? {
                skipAuth: true,
                headers: options.accessToken
                  ? { Authorization: `Bearer ${options.accessToken}` }
                  : {},
              }
            : {}),
        },
      ),
    );
  }

  /** Minimal existing employer identities for the person's own Experience. */
  async organizations(input: SafetyOrganizationsInput) {
    return parseContract(
      safetyOrganizationsResponseCheck,
      await this.ctx.request(
        'POST',
        '/safety/supervision/organizations',
        parseContract(safetyOrganizationsInputCheck, input),
        { cache: false },
      ),
    );
  }

  /** Account ID, handle and display name only, for choosing a guardian or contact. */
  async people(input: SafetyPeopleInput) {
    return parseContract(
      safetyPeopleResponseCheck,
      await this.ctx.request(
        'POST',
        '/safety/supervision/people',
        parseContract(safetyPeopleInputCheck, input),
        { cache: false },
      ),
    );
  }

  async supervisionState() {
    return parseContract(
      supervisionStateCheck,
      await this.ctx.request('GET', '/safety/supervision', undefined, { cache: false }),
    );
  }

  async inviteGuardian(input: SupervisionInviteInput) {
    return parseContract(
      supervisionInvitationCheck,
      await this.ctx.request(
        'POST',
        '/safety/supervision/invitations',
        parseContract(supervisionInviteInputCheck, input),
        { cache: false, retry: false },
      ),
    );
  }

  async acceptGuardianInvitation(id: string, input: SupervisionAcceptInput) {
    return parseContract(
      supervisionStateCheck,
      await this.ctx.request(
        'POST',
        `/safety/supervision/invitations/${encodeURIComponent(id)}/accept`,
        parseContract(supervisionAcceptInputCheck, input),
        { cache: false, retry: false },
      ),
    );
  }

  async cancelGuardianInvitation(id: string) {
    await this.ctx.request(
      'DELETE',
      `/safety/supervision/invitations/${encodeURIComponent(id)}`,
      undefined,
      { cache: false },
    );
  }

  async contacts(childAccountId: string) {
    return parseContract(
      supervisionContactsResponseCheck,
      await this.ctx.request(
        'GET',
        `/safety/supervision/contacts/${encodeURIComponent(childAccountId)}`,
        undefined,
        { cache: false },
      ),
    );
  }

  async approveContact(input: SupervisionContactInput) {
    await this.ctx.request(
      'PUT',
      '/safety/supervision/contacts',
      parseContract(supervisionContactInputCheck, input),
      { cache: false, retry: false },
    );
  }

  async revokeContact(input: SupervisionContactInput) {
    await this.ctx.request(
      'DELETE',
      '/safety/supervision/contacts',
      parseContract(supervisionContactInputCheck, input),
      { cache: false, retry: false },
    );
  }

  async reviewSupervision(input: SupervisionReviewInput) {
    await this.ctx.request(
      'POST',
      '/safety/supervision/review',
      parseContract(supervisionReviewInputCheck, input),
      { cache: false, retry: false },
    );
  }

  async purchaseApproval(id: string) {
    return parseContract(
      purchaseApprovalCheck,
      await this.ctx.request(
        'GET',
        `/safety/supervision/purchases/${encodeURIComponent(id)}`,
        undefined,
        { cache: false },
      ),
    );
  }

  async purchaseApprovals(input: { cursor?: string } = {}) {
    return parseContract(
      purchaseApprovalListCheck,
      await this.ctx.request('GET', '/safety/supervision/purchases', input, { cache: false }),
    );
  }

  async reviewPurchaseApproval(id: string, input: PurchaseReviewInput) {
    return parseContract(
      purchaseApprovalCheck,
      await this.ctx.request(
        'POST',
        `/safety/supervision/purchases/${encodeURIComponent(id)}/review`,
        parseContract(purchaseReviewInputCheck, input),
        { cache: false, retry: false },
      ),
    );
  }
}
