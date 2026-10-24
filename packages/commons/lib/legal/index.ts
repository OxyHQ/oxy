/**
 * Oxy's legal documents, the ones onboarding asks the user to agree to. The
 * same URLs the SDK's sign-in screen links (`OxyAuthScreen`).
 */
export const TERMS_OF_SERVICE_URL = 'https://oxy.so/company/transparency/policies/terms-of-service';
export const PRIVACY_POLICY_URL = 'https://oxy.so/company/transparency/policies/privacy';

export type ConsentLink = 'terms' | 'privacy';

export type ConsentSegment = { text: string; link?: ConsentLink };

/**
 * Split a consent sentence into plain text and link segments. The translation
 * marks each link with a tag, so every language places them where its grammar
 * wants: `I agree to Oxy's <terms>Terms of Service</terms> and acknowledge the
 * <privacy>Privacy Policy</privacy>.` An unknown or unclosed tag stays text, so
 * a translation mistake shows its words rather than dropping them.
 */
export function splitConsentText(source: string): ConsentSegment[] {
  const segments: ConsentSegment[] = [];
  const pattern = /<(terms|privacy)>(.*?)<\/\1>/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: source.slice(last, index) });
    segments.push({ text: match[2], link: match[1] as ConsentLink });
    last = index + match[0].length;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  return segments;
}

/** The sentence with its tags removed: the accessible label of the checkbox. */
export function consentPlainText(source: string): string {
  return splitConsentText(source)
    .map((segment) => segment.text)
    .join('');
}
