/**
 * `oxy.contentClaims` — what a signed-in person does about a content claim
 * (ADR 0042 D10).
 *
 * The owner of content a claim took down disputes it with a counter-notice
 * (17 U.S.C. § 512(g)(3)). The form shows `COUNTER_NOTICE_STATEMENTS` from
 * `@oxy.so/contracts/client` word for word beside its four boxes, and can
 * validate with `contentClaimCounterNoticeSchema` before sending.
 */
import type {
  ContentClaimCounterNotice,
  ContentClaimCounterNoticeResponse,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

export class ContentClaimsApi {
  constructor(protected readonly ctx: OxyContext) {}

  /**
   * Send a counter-notice for files of yours a claim removed
   * (`POST /content-claims/counter-notices`). Name the claim by `reference`
   * (from the email you were sent), `claimId`, or the removed `fileIds`.
   *
   * Errors: 400 `CONTENT_CLAIM_COUNTER_NOTICE_INVALID` (a sentence per body
   * path in `fields`) or `…_AMBIGUOUS` (the files were removed after more
   * than one claim: name the reference); 404 when no claim removed files of
   * yours by that reference, id or file; 409 when the claim cannot be
   * disputed now (`CONTENT_CLAIM_STATE_CONFLICT`) or you already did
   * (`CONTENT_CLAIM_COUNTER_NOTICE_EXISTS`); 429 with `Retry-After`.
   */
  async submitCounterNotice(
    notice: ContentClaimCounterNotice,
  ): Promise<ContentClaimCounterNoticeResponse> {
    return this.ctx.request<ContentClaimCounterNoticeResponse>(
      'POST',
      '/content-claims/counter-notices',
      notice,
      { cache: false },
    );
  }
}
