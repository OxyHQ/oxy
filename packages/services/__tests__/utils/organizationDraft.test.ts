import { checkContract, createOrganizationCheck } from '@oxy.so/contracts/client';
import { parseOrganizationDraft } from '../../src/ui/utils/organizationDraft';
import { createOrganizationSchema, type OrganizationType } from '@oxy.so/contracts';

describe('organization form draft', () => {
  it('normalizes surrounding spaces and maps blank optional fields to null', () => {
    expect(
      parseOrganizationDraft({
        name: '  3M  ',
        organizationType: 'business',
        websiteUrl: ' https://example.com ',
        countryCode: ' es ',
      }),
    ).toEqual({
      name: '3M',
      organizationType: 'business',
      websiteUrl: 'https://example.com',
      countryCode: 'ES',
    });
    expect(
      parseOrganizationDraft({
        name: ' Example ',
        organizationType: 'other',
        websiteUrl: ' \t ',
        countryCode: ' ',
      }),
    ).toEqual({ name: 'Example', organizationType: 'other', websiteUrl: null, countryCode: null });
  });

  it('matches existing selector normalization and server validation across edge cases', () => {
    const names = ['', '   ', ' Example ', '<script>', 'x'.repeat(201), 'AT&T'];
    const types = ['business', 'nonprofit', 'not-a-type'] as OrganizationType[];
    const websites = ['', '  ', 'https://example.com ', 'ftp://example.com', 'not a url'];
    const countries = ['', ' es ', 'USA', '1A'];
    for (const name of names) {
      for (const organizationType of types) {
        for (const websiteUrl of websites) {
          for (const countryCode of countries) {
            const draft = { name, organizationType, websiteUrl, countryCode };
            const normalized = {
              name: name.trim(),
              organizationType,
              websiteUrl: websiteUrl.trim() || null,
              countryCode: countryCode.trim().toUpperCase() || null,
            };
            const result = parseOrganizationDraft(draft);
            expect(result).toEqual(checkContract(createOrganizationCheck, normalized));
            const serverResult = createOrganizationSchema.safeParse(normalized);
            expect(result !== null).toBe(serverResult.success);
            if (result !== null && serverResult.success) expect(result).toEqual(serverResult.data);
          }
        }
      }
    }
  });
});
