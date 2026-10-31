import { checkContract, createOrganizationCheck } from '@oxy.so/contracts/client';
import type { CreateOrganization } from '@oxy.so/contracts';

/** Normalize and validate form fields; callers must separately authorize creation. */
export function parseOrganizationDraft(input: {
  name: string;
  organizationType: CreateOrganization['organizationType'];
  websiteUrl: string;
  countryCode: string;
}): CreateOrganization | null {
  return checkContract(createOrganizationCheck, {
    name: input.name.trim(),
    organizationType: input.organizationType,
    websiteUrl: input.websiteUrl.trim() || null,
    countryCode: input.countryCode.trim().toUpperCase() || null,
  });
}
