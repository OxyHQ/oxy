describe('card extraction enablement', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('stays disabled when CARD_EXTRACTION_ENABLED is absent', async () => {
    process.env = { ...originalEnv };
    delete process.env.CARD_EXTRACTION_ENABLED;

    const { CARD_EXTRACTION_CONFIG } = await import('../email.config');

    expect(CARD_EXTRACTION_CONFIG.enabled).toBe(false);
  });

  it('is enabled only by an explicit true value', async () => {
    process.env = { ...originalEnv, CARD_EXTRACTION_ENABLED: 'true' };

    const { CARD_EXTRACTION_CONFIG } = await import('../email.config');

    expect(CARD_EXTRACTION_CONFIG.enabled).toBe(true);
  });
});
