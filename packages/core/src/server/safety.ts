/**
 * The consumer-service safety lanes (ADR 0041).
 *
 * A reviewed consumer backend asks Oxy for each live decision with its own
 * service identity — a token narrowed to exactly `safety:decide` — plus the
 * original requester's proof. Nothing here is cached: a revoked contact, a new
 * enrollment or a removed capability takes effect on the next call.
 *
 * Server-only, so the Zod schemas parse here; the browser half of the API is
 * `../api/safety.ts`, on the Zod-free checks.
 */
import {
  cancelPurchaseSchema,
  confirmPurchaseSchema,
  contactAccessInputSchema,
  contactAccessResponseSchema,
  contentAccessBatchInputSchema,
  contentAccessBatchResponseSchema,
  contentAccessInputSchema,
  deliveryAccessBatchInputSchema,
  deliveryAccessInputSchema,
  messageAccessBatchInputSchema,
  messageAccessBatchResponseSchema,
  messageAccessInputSchema,
  messagingSessionsInputSchema,
  messagingSessionsResponseSchema,
  profileAccessBatchInputSchema,
  profileAccessBatchResponseSchema,
  profileAccessDecisionSchema,
  profileAccessInputSchema,
  publicationPoliciesInputSchema,
  publicationPoliciesResponseSchema,
  publicationPolicySchema,
  purchaseApprovalSchema,
  purchaseEffectsSchema,
  reservePurchaseSchema,
  safetyDecisionSchema,
  safetyRequesterSchema,
  type CancelPurchase,
  type ConfirmPurchase,
  type ContactAccessInput,
  type ContentAccessBatchInput,
  type ContentAccessInput,
  type DeliveryAccessBatchInput,
  type DeliveryAccessInput,
  type MessageAccessBatchInput,
  type MessageAccessInput,
  type MessagingSessionsInput,
  type ProfileAccessBatchInput,
  type ProfileAccessInput,
  type PublicationPoliciesInput,
  type PurchaseEffects,
  type ReservePurchase,
  type SafetyRequester,
} from '@oxy.so/contracts';
import { SafetyApi } from '../api/safety';

export class ServerSafetyApi extends SafetyApi {
  private service(path: string, input: unknown) {
    if (!this.ctx.service?.available)
      throw new Error('Safety policy requires an authenticated consumer service');
    return this.ctx.service.request('POST', `/safety/service/${path}`, input, {
      cache: false,
      retry: false,
    });
  }

  private decision(path: string, input: unknown, requester: SafetyRequester) {
    return this.service(path, { input, requester: safetyRequesterSchema.parse(requester) });
  }

  /** The original personal bearer, a verified MCP connection proof, or explicit anonymous access. */
  override async profileAccess(input: ProfileAccessInput, options?: SafetyRequester) {
    if (!options)
      throw new Error('Server profile access requires an explicit requester proof or null');
    return profileAccessDecisionSchema.parse(
      await this.decision('profile-access', profileAccessInputSchema.parse(input), options),
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

  async requestPurchaseApproval(input: PurchaseEffects, options: { accessToken: string }) {
    return purchaseApprovalSchema.parse(
      await this.decision('purchases', purchaseEffectsSchema.parse(input), options),
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
