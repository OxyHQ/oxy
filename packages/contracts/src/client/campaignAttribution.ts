/** First-touch campaign labels supplied by an entry link; never account authority. */
export interface CampaignAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclid?: string;
}

export const CAMPAIGN_LABEL_MAX_LENGTH = 256;
export const CAMPAIGN_CLICK_ID_MAX_LENGTH = 1024;

export function hasCampaignControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
