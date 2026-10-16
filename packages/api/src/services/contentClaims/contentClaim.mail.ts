/**
 * The emails a content claim sends (ADR 0042 D10): to the claimant, about
 * their report, and to the accounts whose files a block reached.
 *
 * Plain text and the minimal HTML part every Oxy system email has
 * (`accountEmail.mail.ts`), from `noreply@`. Nothing here names the other
 * party: the owner is never told who complained, and the claimant is never
 * told whose content it was — staff summarize a counter-notice in their own
 * words. Replies about a claim go to {@link LEGAL_CONTACT}, quoting the
 * reference.
 */

import { COUNTER_NOTICE_STATEMENTS, type ContentClaimKind } from '@oxy.so/contracts';
import type { ContentClaimNotificationKind } from '../../db/schema';
import { htmlPage } from '../accountEmail.mail';

/** Where a claimant or an owner writes about a claim. */
export const LEGAL_CONTACT = 'legal@oxy.so';

/** File names an owner email lists before "and N more". */
export const MAX_LISTED_FILES = 20;

export interface ContentClaimMail {
  subject: string;
  text: string;
  html: string;
}

export interface ContentClaimMailContext {
  reference: string;
  claimKind: ContentClaimKind;
  /** The claimant's name (claimant emails) or the account's handle (owner emails). */
  greetingName: string | null;
  /** What staff wrote, for the kinds that carry it. */
  note: string | null;
  /** The owner's files the email is about (owner emails). */
  fileNames: string[];
  /** URLs the report named (the confirmation). */
  targetCount: number;
  /**
   * An owner's counter-notice, opened, for the claimant's copy — only for a
   * copyright claim, where the law requires the copy (17 U.S.C. § 512(g)(2)(B)).
   */
  counterNotice?: {
    name: string;
    address: string;
    phone: string;
    email: string;
    materialDescription: string;
    materialLocation: string;
    explanation: string;
    signature: string;
    sentAt: string;
  } | null;
  /** How many files a counter-notice covers (the staff alert). */
  fileCount?: number;
}

const CLAIM_KIND_TEXT: Record<ContentClaimKind, string> = {
  copyright: 'a copyright claim',
  trademark: 'a trademark claim',
  privacy: 'a privacy and personal data report',
  illegal_content: 'a report of illegal content',
  other: 'a content report',
};

function fileList(names: readonly string[]): string[] {
  const shown = names.slice(0, MAX_LISTED_FILES).map((name) => `- ${name}`);
  if (names.length > MAX_LISTED_FILES) shown.push(`- and ${names.length - MAX_LISTED_FILES} more`);
  return shown;
}

function write(subject: string, paragraphs: string[]): ContentClaimMail {
  // A list is one block of lines in the text part and one paragraph per line in HTML.
  return {
    subject,
    text: paragraphs.join('\n\n'),
    html: htmlPage(paragraphs.flatMap((paragraph) => paragraph.split('\n'))),
  };
}

/** Render one email. */
export function renderContentClaimMail(
  kind: ContentClaimNotificationKind,
  context: ContentClaimMailContext,
): ContentClaimMail {
  const greeting = context.greetingName ? `Hi ${context.greetingName},` : 'Hi,';
  const quote = `Quote the reference ${context.reference} if you write to us at ${LEGAL_CONTACT}.`;
  const what = CLAIM_KIND_TEXT[context.claimKind];

  switch (kind) {
    case 'claim_received':
      return write(`We received your report ${context.reference}`, [
        greeting,
        `We received your report (${what}, ${context.targetCount} ${context.targetCount === 1 ? 'link' : 'links'}). Your reference is ${context.reference}.`,
        'A person on our team will review it and email you at this address when we have decided.',
        quote,
      ]);
    case 'claim_actioned':
      return write(`We acted on your report ${context.reference}`, [
        greeting,
        'We reviewed your report and removed the content it names from Oxy. It is no longer shown on any Oxy service, and it cannot be uploaded again.',
        'The person or service that posted it has been told and may respond. If they do, we will let you know.',
        quote,
      ]);
    case 'claim_rejected':
      return write(`Your report ${context.reference}`, [
        greeting,
        'We reviewed your report and did not remove the content.',
        `Why: ${context.note ?? 'the report did not show that the content should be removed.'}`,
        `If you have more information, write to us at ${LEGAL_CONTACT} quoting the reference ${context.reference}.`,
      ]);
    case 'claim_counter_noticed':
      return write(`A response to your report ${context.reference}`, [
        greeting,
        'The person or service that posted the content you reported disputes your report.',
        `What they told us: ${context.note ?? ''}`.trim(),
        `We will review their response. If you have started legal proceedings about this content, tell us at ${LEGAL_CONTACT} quoting the reference ${context.reference}.`,
      ]);
    case 'claim_reinstated':
      return write(`Update on your report ${context.reference}`, [
        greeting,
        'After reviewing the response to your report, we have restored the content.',
        ...(context.note ? [`Why: ${context.note}`] : []),
        quote,
      ]);
    case 'claim_upheld':
      return write(`Update on your report ${context.reference}`, [
        greeting,
        'After reviewing the response to your report, the content stays removed.',
        quote,
      ]);
    case 'content_blocked':
      return write('Some of your content on Oxy was removed', [
        greeting,
        `We removed the following from Oxy after ${what} (reference ${context.reference}):`,
        fileList(context.fileNames).join('\n'),
        'It is no longer shown on any Oxy service and cannot be uploaded again. It stays in your account, where you can delete it.',
        `If you believe this is a mistake, you can send a counter-notice: write to ${LEGAL_CONTACT} quoting the reference ${context.reference}, and explain why the content should be restored.`,
      ]);
    case 'content_reinstated':
      return write('Your content on Oxy is back', [
        greeting,
        `After reviewing your response to ${what} (reference ${context.reference}), we restored the following:`,
        fileList(context.fileNames).join('\n'),
        'It is shown again wherever you used it.',
      ]);
    case 'content_upheld':
      return write('A decision on your counter-notice', [
        greeting,
        `After reviewing your response to ${what} (reference ${context.reference}), the content stays removed.`,
        quote,
      ]);
    case 'claim_counter_notice_copy': {
      const notice = context.counterNotice;
      if (!notice) {
        // Not a copyright claim: the owner's identity is not the claimant's to have.
        return write(`A response to your report ${context.reference}`, [
          greeting,
          'The person who posted the content you reported disputes your report and has asked us to restore it.',
          `We will review their response and tell you what we decide. ${quote}`,
        ]);
      }
      return write(`Counter-notice to your report ${context.reference}`, [
        greeting,
        'The person who posted the content you reported sent us the counter-notice below. The law requires us to send you a copy (17 U.S.C. § 512(g)(2)(B)).',
        [
          `Name: ${notice.name}`,
          `Address: ${notice.address}`,
          `Telephone: ${notice.phone}`,
          `Email: ${notice.email}`,
          `Material removed: ${notice.materialDescription}`,
          `Where it appeared: ${notice.materialLocation}`,
          `Their explanation: ${notice.explanation}`,
          `Statement: ${COUNTER_NOTICE_STATEMENTS.perjury}`,
          `Consent: ${COUNTER_NOTICE_STATEMENTS.jurisdiction}`,
          `Service of process: ${COUNTER_NOTICE_STATEMENTS.serviceOfProcess}`,
          `Signed: ${notice.signature}, ${notice.sentAt}`,
        ].join('\n'),
        `We may restore the material no less than 10 and no more than 14 business days after we received this counter-notice, unless you first tell us at ${LEGAL_CONTACT}, quoting the reference ${context.reference}, that you have filed an action seeking a court order to restrain the person from engaging in the infringing activity.`,
      ]);
    }
    case 'counter_notice_received':
      return write(`We received your counter-notice (${context.reference})`, [
        greeting,
        `We received your counter-notice to ${what} (reference ${context.reference}) about:`,
        fileList(context.fileNames).join('\n'),
        'A person on our team will review it. For a copyright claim, we send a copy to the person who made the claim, as the law requires; if they do not tell us within 10 business days that they have gone to court, we may restore the content.',
        quote,
      ]);
    case 'counter_notice_staff':
      return write(`Counter-notice received: ${context.reference}`, [
        `The owner of content removed after ${what} (reference ${context.reference}) sent a counter-notice covering ${context.fileCount ?? 0} ${context.fileCount === 1 ? 'file' : 'files'}.`,
        'Review it on the claim in the console (Staff → Content claims). The claimant has been sent their copy.',
      ]);
  }
}
