import {
  messagingSessionsInputSchema,
  messagingSessionsResponseSchema,
  type MessagingSessionsInput,
  safetyOrganizationsInputSchema,
  safetyOrganizationsResponseSchema,
  type SafetyOrganizationsInput,
  safetyPeopleInputSchema,
  safetyPeopleResponseSchema,
  type SafetyPeopleInput,
  publicationPolicySchema,
  publicationPoliciesInputSchema,
  publicationPoliciesResponseSchema,
  type PublicationPoliciesInput,
  profileAccessInputSchema,
  profileAccessDecisionSchema,
  profileAccessBatchInputSchema,
  profileAccessBatchResponseSchema,
  messageAccessInputSchema,
  messageAccessBatchInputSchema,
  deliveryAccessBatchInputSchema,
  messageAccessBatchResponseSchema,
  type MessageAccessBatchInput,
  type DeliveryAccessBatchInput,
  contactAccessInputSchema,
  contactAccessResponseSchema,
  contentAccessInputSchema,
  contentAccessBatchInputSchema,
  contentAccessBatchResponseSchema,
  deliveryAccessInputSchema,
  safetyDecisionSchema,
  safetyRequesterSchema,
  supervisionStateSchema,
  supervisionInviteInputSchema,
  supervisionAcceptInputSchema,
  supervisionInvitationSchema,
  supervisionContactInputSchema,
  supervisionContactsResponseSchema,
  supervisionReviewInputSchema,
  purchaseEffectsSchema,
  purchaseApprovalSchema,
  purchaseApprovalListSchema,
  purchaseReviewInputSchema,
  reservePurchaseSchema,
  confirmPurchaseSchema,
  cancelPurchaseSchema,
  type ProfileAccessInput,
  type ProfileAccessBatchInput,
  type SafetyRequester,
  type MessageAccessInput,
  type ContactAccessInput,
  type ContentAccessInput,
  type ContentAccessBatchInput,
  type DeliveryAccessInput,
  type SupervisionInviteInput,
  type SupervisionAcceptInput,
  type SupervisionContactInput,
  type SupervisionReviewInput,
  type PurchaseEffects,
  type PurchaseReviewInput,
  type ReservePurchase,
  type ConfirmPurchase,
  type CancelPurchase,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

/** Authoritative policy decisions; no persistent decision cache and no inferred app identity. */
export class SafetyApi {
  constructor(private readonly ctx: OxyContext) {}
  private service(path: string, input: unknown) {
    if (!this.ctx.service?.available)
      throw new Error('Safety policy requires an authenticated consumer service');
    return this.ctx.service.request('POST', `/safety/service/${path}`, input, {
      cache: false,
      retry: false,
      serviceTokenScopes: ['safety:decide'],
    });
  }
  private decision(path: string, input: unknown, requester: SafetyRequester) {
    return this.service(path, { input, requester: safetyRequesterSchema.parse(requester) });
  }
  /** Server callers supply the original personal bearer, verified MCP connection proof or explicit anonymous access. */
  async profileAccess(input: ProfileAccessInput, options?: SafetyRequester) {
    const parsed = profileAccessInputSchema.parse(input);
    if (this.ctx.service) {
      if (!options)
        throw new Error('Server profile access requires an explicit requester proof or null');
      return profileAccessDecisionSchema.parse(
        await this.decision('profile-access', parsed, options),
      );
    }
    if (options && 'connectionToken' in options)
      throw new Error('Connection policy reads require a consumer service');
    return profileAccessDecisionSchema.parse(
      await this.ctx.request('GET', '/safety/profile-access', parsed, {
        cache: false,
        ...(options
          ? {
              skipAuth: true,
              headers: options.accessToken
                ? { Authorization: `Bearer ${options.accessToken}` }
                : {},
            }
          : {}),
      }),
    );
  }
  async profileAccessBatch(input: ProfileAccessBatchInput, options: SafetyRequester) {
    return profileAccessBatchResponseSchema.parse(
      await this.decision(
        'profile-access-batch',
        profileAccessBatchInputSchema.parse(input),
        options,
      ),
    );
  }
  async messageAccess(input: MessageAccessInput, options: SafetyRequester) {
    return safetyDecisionSchema.parse(
      await this.decision('message-access', messageAccessInputSchema.parse(input), options),
    );
  }
  async messageAccessBatch(input: MessageAccessBatchInput, options: SafetyRequester) {
    return messageAccessBatchResponseSchema.parse(
      await this.decision(
        'message-access-batch',
        messageAccessBatchInputSchema.parse(input),
        options,
      ),
    );
  }
  async messagingSessions(input: MessagingSessionsInput) {
    return messagingSessionsResponseSchema.parse(
      await this.service('messaging-sessions', messagingSessionsInputSchema.parse(input)),
    );
  }
  async deliveryAccessBatch(input: DeliveryAccessBatchInput) {
    return messageAccessBatchResponseSchema.parse(
      await this.service('delivery-access-batch', deliveryAccessBatchInputSchema.parse(input)),
    );
  }
  async contactAccess(input: ContactAccessInput, options: SafetyRequester) {
    return contactAccessResponseSchema.parse(
      await this.decision('contact-access', contactAccessInputSchema.parse(input), options),
    );
  }
  async publicationPolicies(input: PublicationPoliciesInput) {
    return publicationPoliciesResponseSchema.parse(
      await this.service('publication-policies', publicationPoliciesInputSchema.parse(input)),
    );
  }
  async publicationPolicy(options: SafetyRequester) {
    return publicationPolicySchema.parse(await this.decision('publication-policy', {}, options));
  }
  async contentAccess(input: ContentAccessInput, options: SafetyRequester) {
    return safetyDecisionSchema.parse(
      await this.decision('content-access', contentAccessInputSchema.parse(input), options),
    );
  }
  async contentAccessBatch(input: ContentAccessBatchInput, options: SafetyRequester) {
    return contentAccessBatchResponseSchema.parse(
      await this.decision(
        'content-access-batch',
        contentAccessBatchInputSchema.parse(input),
        options,
      ),
    );
  }
  async deliveryAccess(input: DeliveryAccessInput) {
    return safetyDecisionSchema.parse(
      await this.service('delivery-access', deliveryAccessInputSchema.parse(input)),
    );
  }
  async organizations(input: SafetyOrganizationsInput) {
    return safetyOrganizationsResponseSchema.parse(
      await this.ctx.request(
        'POST',
        '/safety/supervision/organizations',
        safetyOrganizationsInputSchema.parse(input),
        { cache: false },
      ),
    );
  }
  async people(input: SafetyPeopleInput) {
    return safetyPeopleResponseSchema.parse(
      await this.ctx.request(
        'POST',
        '/safety/supervision/people',
        safetyPeopleInputSchema.parse(input),
        { cache: false },
      ),
    );
  }
  async supervisionState() {
    return supervisionStateSchema.parse(
      await this.ctx.request('GET', '/safety/supervision', undefined, { cache: false }),
    );
  }
  async inviteGuardian(input: SupervisionInviteInput) {
    return supervisionInvitationSchema.parse(
      await this.ctx.request(
        'POST',
        '/safety/supervision/invitations',
        supervisionInviteInputSchema.parse(input),
        { cache: false, retry: false },
      ),
    );
  }
  async acceptGuardianInvitation(id: string, input: SupervisionAcceptInput) {
    return supervisionStateSchema.parse(
      await this.ctx.request(
        'POST',
        `/safety/supervision/invitations/${encodeURIComponent(id)}/accept`,
        supervisionAcceptInputSchema.parse(input),
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
    return supervisionContactsResponseSchema.parse(
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
      supervisionContactInputSchema.parse(input),
      { cache: false, retry: false },
    );
  }
  async revokeContact(input: SupervisionContactInput) {
    await this.ctx.request(
      'DELETE',
      '/safety/supervision/contacts',
      supervisionContactInputSchema.parse(input),
      { cache: false, retry: false },
    );
  }
  async reviewSupervision(input: SupervisionReviewInput) {
    await this.ctx.request(
      'POST',
      '/safety/supervision/review',
      supervisionReviewInputSchema.parse(input),
      { cache: false, retry: false },
    );
  }
  async requestPurchaseApproval(input: PurchaseEffects, options: { accessToken: string }) {
    return purchaseApprovalSchema.parse(
      await this.decision('purchases', purchaseEffectsSchema.parse(input), options),
    );
  }
  async purchaseApproval(id: string) {
    return purchaseApprovalSchema.parse(
      await this.ctx.request(
        'GET',
        `/safety/supervision/purchases/${encodeURIComponent(id)}`,
        undefined,
        { cache: false },
      ),
    );
  }
  async purchaseApprovals(input: { cursor?: string } = {}) {
    return purchaseApprovalListSchema.parse(
      await this.ctx.request('GET', '/safety/supervision/purchases', input, { cache: false }),
    );
  }
  async reviewPurchaseApproval(id: string, input: PurchaseReviewInput) {
    return purchaseApprovalSchema.parse(
      await this.ctx.request(
        'POST',
        `/safety/supervision/purchases/${encodeURIComponent(id)}/review`,
        purchaseReviewInputSchema.parse(input),
        { cache: false, retry: false },
      ),
    );
  }
  async reservePurchase(input: ReservePurchase) {
    return purchaseApprovalSchema.parse(
      await this.service('purchases/reserve', reservePurchaseSchema.parse(input)),
    );
  }
  async confirmPurchase(input: ConfirmPurchase) {
    return purchaseApprovalSchema.parse(
      await this.service('purchases/confirm', confirmPurchaseSchema.parse(input)),
    );
  }
  async cancelPurchase(input: CancelPurchase) {
    return purchaseApprovalSchema.parse(
      await this.service('purchases/cancel', cancelPurchaseSchema.parse(input)),
    );
  }
}
