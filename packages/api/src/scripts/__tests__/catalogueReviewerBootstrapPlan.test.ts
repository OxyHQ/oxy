import {
  CATALOGUE_PUBLISH_CAPABILITY,
  planCatalogueReviewerBootstrap,
} from '../catalogueReviewerBootstrapPlan';

describe('catalogue reviewer staff bootstrap plan', () => {
  it('adds only the catalogue capability and staff flag', () => {
    expect(planCatalogueReviewerBootstrap({
      userId: '6981c9178fcdefaf81988ffb',
      isStaff: false,
      staffCapabilities: [],
    })).toMatchObject({
      userId: '6981c9178fcdefaf81988ffb',
      capability: CATALOGUE_PUBLISH_CAPABILITY,
      changed: true,
      nextIsStaff: true,
      nextCapabilities: [CATALOGUE_PUBLISH_CAPABILITY],
    });
  });

  it('preserves unrelated capabilities without granting another one', () => {
    const plan = planCatalogueReviewerBootstrap({
      userId: '6981c9178fcdefaf81988ffb',
      isStaff: true,
      staffCapabilities: ['billing:adjust'],
    });
    expect(plan.nextCapabilities).toEqual([
      'billing:adjust',
      CATALOGUE_PUBLISH_CAPABILITY,
    ]);
  });

  it('is idempotent once the exact grant exists', () => {
    const plan = planCatalogueReviewerBootstrap({
      userId: '6981c9178fcdefaf81988ffb',
      isStaff: true,
      staffCapabilities: [CATALOGUE_PUBLISH_CAPABILITY],
    });
    expect(plan.changed).toBe(false);
    expect(plan.nextCapabilities).toEqual([CATALOGUE_PUBLISH_CAPABILITY]);
  });

  it('does not normalize an ambiguous configured id', () => {
    expect(() => planCatalogueReviewerBootstrap({
      userId: ' 6981c9178fcdefaf81988ffb',
      isStaff: false,
      staffCapabilities: [],
    })).toThrow('exact opaque user id');
  });
});
