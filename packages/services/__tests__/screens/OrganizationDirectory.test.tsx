import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const search = jest.fn();
const claim = jest.fn();
const create = jest.fn();
const update = jest.fn();
const get = jest.fn();
const myClaims = jest.fn();
const batch = jest.fn();
const reviewClaims = jest.fn();
const reviewClaimDetail = jest.fn();
const reviewClaim = jest.fn();
const createAccount = jest.fn();
const switchToAccount = jest.fn();
const checkUsername = jest.fn();
let user = { id: 'person', kind: 'personal' };
let ready = true;
const oxyServices = {
  organizations: {
    search,
    claim,
    create,
    update,
    get,
    myClaims,
    batch,
    reviewClaims,
    reviewClaimDetail,
    reviewClaim,
  },
  auth: { checkUsername },
};
jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ({ oxyServices, user, canUsePrivateApi: ready, createAccount, switchToAccount }),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({ useSurfaceHeader: jest.fn() }));

import { OrganizationDirectorySearch } from '../../src/ui/components/organizations/OrganizationDirectorySearch';
import { OrganizationSettings } from '../../src/ui/components/organizations/OrganizationSettings';
import { OrganizationClaims } from '../../src/ui/components/organizations/OrganizationClaims';
import { OrganizationClaimReview } from '../../src/ui/components/organizations/OrganizationClaimReview';
import CreateAccountScreen from '../../src/ui/screens/CreateAccountScreen';

const organization = {
  accountId: 'existing-org',
  name: 'Acme',
  username: 'acme',
  organizationType: 'business',
  claimStatus: 'unclaimed',
  status: 'active',
  websiteUrl: 'https://acme.example',
  countryCode: 'US',
  legalName: null,
  avatar: null,
  aliases: [],
  verifiedDomains: [],
  mergedIntoAccountId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const clients: QueryClient[] = [];
function mount(child: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
}
async function findCompany() {
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
}
beforeEach(() => {
  jest.clearAllMocks();
  ready = true;
  user = { id: 'person', kind: 'personal' };
  search.mockResolvedValue({ items: [organization], nextCursor: null });
  get.mockResolvedValue(organization);
  create.mockResolvedValue(organization);
  claim.mockResolvedValue({ id: 'claim1', accountId: organization.accountId, status: 'pending' });
  update.mockResolvedValue({ ...organization, updatedAt: '2026-02-01T00:00:00.000Z' });
  myClaims.mockResolvedValue({ items: [], nextCursor: null });
  batch.mockResolvedValue({
    items: [{ requestedAccountId: organization.accountId, organization }],
    missingIds: [],
  });
  checkUsername.mockResolvedValue({ available: true });
  createAccount.mockResolvedValue({ accountId: 'created-org' });
  switchToAccount.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

it('requests review on the existing identity without creating or switching accounts', async () => {
  mount(<OrganizationDirectorySearch onCreateAccount={jest.fn()} />);
  await findCompany();
  fireEvent.click(screen.getByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await screen.findByText('organizationDirectory.claimSent');
  expect(claim).toHaveBeenCalledWith('existing-org', { evidenceReference: 'private-case:123' });
  expect(create).not.toHaveBeenCalled();
  expect(createAccount).not.toHaveBeenCalled();
  expect(switchToAccount).not.toHaveBeenCalled();
});
it('requires a successful directory search before offering a new managed account', async () => {
  search.mockRejectedValueOnce(new Error('offline'));
  const onCreate = jest.fn();
  mount(<OrganizationDirectorySearch onCreateAccount={onCreate} />);
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByText('organizationDirectory.failed');
  expect(screen.queryByRole('button', { name: 'organizationDirectory.newAccount' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.retry' }));
  fireEvent.click(await screen.findByRole('button', { name: 'organizationDirectory.newAccount' }));
  expect(onCreate).toHaveBeenCalledWith('Acme', 'business');
});
it('creates a neutral directory entry with a subtype and grants no ownership', async () => {
  mount(<OrganizationDirectorySearch onCreateAccount={jest.fn()} />);
  await findCompany();
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.types.nonprofit' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ name: 'Acme', organizationType: 'nonprofit' }),
  );
  expect(createAccount).not.toHaveBeenCalled();
  expect(switchToAccount).not.toHaveBeenCalled();
});
it('does not claim a managed organization or write before a personal token is ready', async () => {
  search.mockResolvedValue({
    items: [{ ...organization, claimStatus: 'claimed' }],
    nextCursor: null,
  });
  mount(<OrganizationDirectorySearch onCreateAccount={jest.fn()} />);
  await findCompany();
  fireEvent.click(screen.getByRole('button', { name: 'Acme' }));
  expect(screen.queryByRole('button', { name: 'organizationDirectory.claim' })).toBeNull();
  cleanup();
  ready = false;
  search.mockResolvedValue({ items: [organization], nextCursor: null });
  mount(<OrganizationDirectorySearch onCreateAccount={jest.fn()} />);
  await findCompany();
  expect(screen.queryByRole('button', { name: 'organizationDirectory.addDirectory' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Acme' }));
  expect(
    screen.getByRole('button', { name: 'organizationDirectory.claim' }).hasAttribute('disabled'),
  ).toBe(true);
});
it('passes the chosen organization subtype through managed account creation', async () => {
  mount(<CreateAccountScreen onClose={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'accounts.kinds.organization.label' }));
  expect(screen.queryByLabelText('accounts.create.username.label')).toBeNull();
  await findCompany();
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.newAccount' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.types.nonprofit' }));
  fireEvent.change(screen.getByLabelText('accounts.create.username.label'), {
    target: { value: 'acme_new' },
  });
  await waitFor(() => expect(checkUsername).toHaveBeenCalledWith('acme_new'));
  fireEvent.click(screen.getByRole('button', { name: 'accounts.create.title' }));
  await waitFor(() =>
    expect(createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'organization', organizationType: 'nonprofit' }),
    ),
  );
});
it('validates canonical company fields and updates the existing ID, without replacing aliases', async () => {
  mount(<OrganizationSettings accountId="existing-org" canUpdate />);
  await screen.findByLabelText('organizationDirectory.website');
  fireEvent.change(screen.getByLabelText('organizationDirectory.website'), {
    target: { value: 'not a URL' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.save' }));
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByText('organizationDirectory.invalid')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('organizationDirectory.website'), {
    target: { value: 'https://new.example' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.types.nonprofit' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.save' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('existing-org', {
      name: 'Acme',
      legalName: null,
      websiteUrl: 'https://new.example',
      countryCode: 'US',
      organizationType: 'nonprofit',
    }),
  );
});
it('shows classification without edit controls to a member without account:update', async () => {
  mount(<OrganizationSettings accountId="existing-org" canUpdate={false} />);
  await screen.findByText('organizationDirectory.types.business');
  expect(screen.queryByRole('button', { name: 'organizationDirectory.save' })).toBeNull();
});
it('batch-hydrates claim status and drops private requests when the viewer switches', async () => {
  myClaims.mockResolvedValueOnce({
    items: [
      { id: 'claim1', accountId: 'existing-org', status: 'pending' },
      { id: 'claim2', accountId: 'existing-org', status: 'rejected' },
    ],
    nextCursor: null,
  });
  const view = mount(<OrganizationClaims />);
  await screen.findByText('organizationDirectory.pending');
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ ids: ['existing-org'] }));
  expect(batch).toHaveBeenCalledTimes(1);
  user = { id: 'someone-else', kind: 'personal' };
  view.rerender(
    <QueryClientProvider client={clients[0]}>
      <OrganizationClaims />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText('organizationDirectory.pending')).toBeNull());
});

const pendingClaim = {
  id: 'claim1',
  accountId: 'existing-org',
  claimantUserId: 'applicant',
  status: 'pending',
  evidenceReference: 'private-applicant-case',
  reviewEvidenceReference: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
async function openReview() {
  reviewClaims.mockResolvedValue({ items: [pendingClaim], nextCursor: null });
  reviewClaimDetail.mockResolvedValue(pendingClaim);
  reviewClaim.mockResolvedValue({ ...pendingClaim, status: 'approved' });
  mount(<OrganizationClaimReview />);
  expect(reviewClaims).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.review.title' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  await screen.findByText('private-applicant-case');
}
it('opens the staff queue on demand and approves the same request only with review evidence', async () => {
  await openReview();
  expect(
    screen
      .getByRole('button', { name: 'organizationDirectory.review.approved' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('organizationDirectory.review.evidence'), {
    target: { value: 'review-case:456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.review.approved' }));
  await waitFor(() =>
    expect(reviewClaim).toHaveBeenCalledWith('claim1', {
      decision: 'approved',
      evidenceReference: 'review-case:456',
    }),
  );
});
it('keeps the private review queue hidden after a staff authorization denial', async () => {
  reviewClaims.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
  mount(<OrganizationClaimReview />);
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.review.title' }));
  await screen.findByText('organizationDirectory.review.forbidden');
  expect(reviewClaimDetail).not.toHaveBeenCalled();
  expect(screen.queryByText('private-applicant-case')).toBeNull();
});
it('refuses self-review and explains that an independent reviewer is required', async () => {
  user = { id: 'applicant', kind: 'personal' };
  await openReview();
  await screen.findByText('organizationDirectory.review.independent');
  fireEvent.change(screen.getByLabelText('organizationDirectory.review.evidence'), {
    target: { value: 'review-case:456' },
  });
  expect(
    screen
      .getByRole('button', { name: 'organizationDirectory.review.approved' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(reviewClaim).not.toHaveBeenCalled();
});
it('does not resubmit after another reviewer changes a request', async () => {
  await openReview();
  reviewClaim.mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.review.evidence'), {
    target: { value: 'review-case:456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.review.rejected' }));
  await screen.findByText('organizationDirectory.review.conflict');
  expect(
    screen
      .getByRole('button', { name: 'organizationDirectory.review.approved' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(reviewClaim).toHaveBeenCalledTimes(1);
});

it('hides private review evidence and actions when a fresh authorization check is revoked', async () => {
  await openReview();
  expect(screen.getByText('private-applicant-case')).toBeTruthy();
  reviewClaimDetail.mockRejectedValue(Object.assign(new Error('revoked'), { status: 403 }));
  await clients[0].invalidateQueries({ queryKey: ['oxy', 'organizations', 'review-detail'] });
  await waitFor(() => expect(screen.queryByText('private-applicant-case')).toBeNull());
  expect(
    screen.queryByRole('button', { name: 'organizationDirectory.review.approved' }),
  ).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'organizationDirectory.review.rejected' }),
  ).toBeNull();
  expect(reviewClaim).not.toHaveBeenCalled();
});
