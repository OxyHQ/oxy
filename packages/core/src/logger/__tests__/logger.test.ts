import {
  configureLogger,
  consoleSink,
  createLogger,
  getLoggerConfig,
  isDev,
  logger,
  resetLoggerConfig,
  type LogEntry,
} from '../index';

/** Install a capturing sink and return the collected entries. */
function captureEntries(): LogEntry[] {
  const entries: LogEntry[] = [];
  configureLogger({ sink: (entry) => entries.push(entry) });
  return entries;
}

describe('logger', () => {
  afterEach(() => {
    resetLoggerConfig();
  });

  describe('level gating', () => {
    it('emits only levels at or below the configured level', () => {
      const entries = captureEntries();
      configureLogger({ level: 'warn' });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
    });

    it('emits everything at debug level', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries.map((entry) => entry.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('emits nothing at silent level', () => {
      const entries = captureEntries();
      configureLogger({ level: 'silent' });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries).toHaveLength(0);
    });
  });

  describe('namespacing', () => {
    it('root logger has no namespace', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      logger.info('hello');

      expect(entries[0].namespace).toBeUndefined();
    });

    it('createLogger sets the namespace', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      createLogger('mention:feed').info('loaded');

      expect(entries[0].namespace).toBe('mention:feed');
    });

    it('child() colon-joins nested namespaces', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      createLogger('mention:feed').child('prefetch').info('done');

      expect(entries[0].namespace).toBe('mention:feed:prefetch');
    });
  });

  describe('structured context', () => {
    it('passes per-call context through to the sink', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      logger.info('hi', { userId: 'u1', requestId: 'r1' });

      expect(entries[0].context).toEqual({ userId: 'u1', requestId: 'r1' });
    });

    it('merges base context with per-call context (per-call wins)', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      createLogger('svc', { component: 'Svc', userId: 'base' }).warn('x', {
        userId: 'call',
        method: 'm',
      });

      expect(entries[0].context).toEqual({ component: 'Svc', userId: 'call', method: 'm' });
    });

    it('captures the error value on error()', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });
      const boom = new Error('boom');

      logger.error('failed', boom, { component: 'Svc' });

      expect(entries[0].error).toBe(boom);
      expect(entries[0].context).toEqual({ component: 'Svc' });
    });

    it('forwards trailing variadic args', () => {
      const entries = captureEntries();
      configureLogger({ level: 'debug' });

      logger.warn('x', { component: 'Svc' }, 1, 'two');

      expect(entries[0].args).toEqual([1, 'two']);
    });
  });

  describe('sink override', () => {
    it('routes all output through the configured sink', () => {
      const sink = jest.fn();
      configureLogger({ level: 'debug', sink });

      logger.info('routed');

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0]).toMatchObject({ level: 'info', message: 'routed' });
    });

    it('resetLoggerConfig restores the console sink', () => {
      configureLogger({ sink: jest.fn() });
      resetLoggerConfig();
      expect(getLoggerConfig().sink).toBe(consoleSink);
    });
  });

  describe('consoleSink', () => {
    it('routes error to console.error and warn to console.warn', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const now = new Date().toISOString();

      consoleSink({ level: 'error', message: 'e', args: [], timestamp: now });
      consoleSink({ level: 'warn', message: 'w', args: [], timestamp: now });
      consoleSink({ level: 'info', message: 'i', args: [], timestamp: now });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe('isDev', () => {
    // `isDev` reads the RN-injected global `__DEV__` first; model it as an
    // optional global so we can exercise the NODE_ENV fallback without `as any`.
    const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };
    const originalDev = globalWithDev.__DEV__;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      // Setting to `undefined` makes `typeof __DEV__` read as 'undefined', the
      // same signal `isDev` keys off — no need for the `delete` operator.
      globalWithDev.__DEV__ = originalDev;
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('returns true when __DEV__ is true (React Native)', () => {
      globalWithDev.__DEV__ = true;
      expect(isDev()).toBe(true);
    });

    it('returns false when __DEV__ is false regardless of NODE_ENV', () => {
      globalWithDev.__DEV__ = false;
      process.env.NODE_ENV = 'development';
      expect(isDev()).toBe(false);
    });

    it('falls back to NODE_ENV=development when __DEV__ is undefined', () => {
      globalWithDev.__DEV__ = undefined;
      process.env.NODE_ENV = 'development';
      expect(isDev()).toBe(true);
    });

    it('returns false when NODE_ENV is production and __DEV__ is undefined', () => {
      globalWithDev.__DEV__ = undefined;
      process.env.NODE_ENV = 'production';
      expect(isDev()).toBe(false);
    });
  });
});
