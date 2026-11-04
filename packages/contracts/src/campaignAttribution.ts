import { z } from 'zod';
import { utf16MaxLength, utf16MinLength } from './stringChecks';
import {
  CAMPAIGN_LABEL_MAX_LENGTH,
  hasCampaignControlCharacters,
  CAMPAIGN_CLICK_ID_MAX_LENGTH,
} from './client/campaignAttribution';

const campaignValue = (limit: number) =>
  z
    .string()
    .trim()
    .check(utf16MinLength(1))
    .check(utf16MaxLength(limit))
    .refine((value) => !hasCampaignControlCharacters(value), {
      message: 'Campaign values cannot contain control characters',
    });

/** Only bounded campaign labels are accepted, never a URL, IP or profile data. */
export const campaignAttributionSchema = z
  .object({
    utmSource: campaignValue(CAMPAIGN_LABEL_MAX_LENGTH).optional(),
    utmMedium: campaignValue(CAMPAIGN_LABEL_MAX_LENGTH).optional(),
    utmCampaign: campaignValue(CAMPAIGN_LABEL_MAX_LENGTH).optional(),
    utmContent: campaignValue(CAMPAIGN_LABEL_MAX_LENGTH).optional(),
    utmTerm: campaignValue(CAMPAIGN_LABEL_MAX_LENGTH).optional(),
    fbclid: campaignValue(CAMPAIGN_CLICK_ID_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one campaign parameter is required',
  });
