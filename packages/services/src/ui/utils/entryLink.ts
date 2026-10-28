import { SUPPORTED_LANGUAGES, normalizeLocale } from '@oxy.so/core';
import {
  CAMPAIGN_LABEL_MAX_LENGTH,
  hasCampaignControlCharacters,
  CAMPAIGN_CLICK_ID_MAX_LENGTH,
  type CampaignAttribution,
} from '@oxy.so/contracts/client';

const CAMPAIGN_PARAMETERS = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmContent: 'utm_content',
  utmTerm: 'utm_term',
  fbclid: 'fbclid',
} as const;

export function readCampaignAttribution(value: unknown): CampaignAttribution | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: CampaignAttribution = {};
  for (const field of Object.keys(CAMPAIGN_PARAMETERS) as (keyof CampaignAttribution)[]) {
    const raw = Reflect.get(value, field);
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim();
    const limit = field === 'fbclid' ? CAMPAIGN_CLICK_ID_MAX_LENGTH : CAMPAIGN_LABEL_MAX_LENGTH;
    if (!normalized || normalized.length > limit || hasCampaignControlCharacters(normalized))
      continue;
    result[field] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Consumes only explicit locale/campaign parameters, never the URL or referrer itself. */
export function readEntryLink(url: string | null): {
  language?: string;
  campaignAttribution?: CampaignAttribution;
} {
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const languages = parsed.searchParams.getAll('lang');
  const requestedLanguage = languages.length === 1 ? languages[0] : undefined;
  const language =
    requestedLanguage && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(requestedLanguage)
      ? (normalizeLocale(requestedLanguage) ??
        SUPPORTED_LANGUAGES.find(
          (candidate) => candidate.language === requestedLanguage.split('-')[0]?.toLowerCase(),
        )?.code)
      : undefined;
  const fields: Record<string, string> = {};
  for (const [field, query] of Object.entries(CAMPAIGN_PARAMETERS)) {
    const values = parsed.searchParams.getAll(query);
    if (values.length === 1) fields[field] = values[0];
  }
  return { language, campaignAttribution: readCampaignAttribution(fields) };
}
