import { createAccountRequestSchema } from '../accountGraph';
import {
  createOrganizationSchema,
  organizationBatchInputSchema,
  organizationImportBatchSchema,
  organizationSchema,
  organizationCurationSchema,
} from '../organizations';

describe('canonical organization contracts', () => {
  it.each(['3M', '7-Eleven', 'AT&T'])(
    'accepts real company name %s without human-name normalization',
    (name) => {
      expect(createOrganizationSchema.parse({ name, organizationType: 'business' }).name).toBe(
        name,
      );
    },
  );
  it('refuses authority mass assignment and unsafe identity text', () => {
    expect(
      createOrganizationSchema.safeParse({
        name: 'Company',
        organizationType: 'business',
        claimStatus: 'claimed',
      }).success,
    ).toBe(false);
    expect(
      createOrganizationSchema.safeParse({ name: '<script>', organizationType: 'business' })
        .success,
    ).toBe(false);
  });
  it('bounds batch reads and namespace imports', () => {
    expect(
      organizationBatchInputSchema.safeParse({ ids: Array.from({ length: 101 }, () => 'id') })
        .success,
    ).toBe(false);
    const item = {
      externalId: 'source-id',
      organization: { name: 'Company', organizationType: 'business' },
      evidenceReference: 'archive/proof',
    };
    expect(
      organizationImportBatchSchema.safeParse({ namespace: 'homiio', items: [item, item] }).success,
    ).toBe(false);
    expect(
      organizationImportBatchSchema.safeParse({
        namespace: 'homiio',
        items: [{ ...item, accountId: 'claimed-company' }],
      }).success,
    ).toBe(false);
  });
  it('keeps organization type separate from account kinds and topical categories', () => {
    expect(
      createAccountRequestSchema.safeParse({
        kind: 'organization',
        username: 'companyname',
        organizationType: 'business',
      }).success,
    ).toBe(true);
    expect(
      createAccountRequestSchema.safeParse({
        kind: 'project',
        username: 'projectname',
        organizationType: 'business',
      }).success,
    ).toBe(false);
  });
  it('requires curation evidence and validates actual response fields', () => {
    expect(organizationCurationSchema.safeParse({ status: 'suppressed' }).success).toBe(false);
    expect(
      organizationCurationSchema.safeParse({ status: 'claimed', evidenceReference: 'proof' })
        .success,
    ).toBe(false);
    expect(organizationSchema.safeParse({ accountId: 'id', name: 'Company' }).success).toBe(false);
  });
});
