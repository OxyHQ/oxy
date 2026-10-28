import { campaignAttributionSchema } from '../campaignAttribution';
import { signUpRequestSchema } from '../signIn';

describe('signup campaign metadata', () => {
  it('accepts bounded campaign fields and the guest language with signup', () => {
    const result = signUpRequestSchema.safeParse({
      username: 'ada',
      email: 'ada@example.com',
      emailTicket: 'A'.repeat(43),
      languages: ['es-ES'],
      campaignAttribution: { utmSource: ' meta ', utmCampaign: 'Spain' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.campaignAttribution?.utmSource).toBe('meta');
  });
  it.each([
    {},
    { utmSource: '' },
    { utmSource: 'x'.repeat(257) },
    { fbclid: 'x'.repeat(1025) },
    { utmSource: 'meta\u0000' },
    { utmSource: 'meta', ip: '127.0.0.1' },
  ])('rejects invalid or extra campaign data %j', (value) => {
    expect(campaignAttributionSchema.safeParse(value).success).toBe(false);
  });
  it('accepts the maximum click identifier without adding it to the public user contract', () => {
    expect(campaignAttributionSchema.parse({ fbclid: 'x'.repeat(1024) }).fbclid).toHaveLength(1024);
  });
});
