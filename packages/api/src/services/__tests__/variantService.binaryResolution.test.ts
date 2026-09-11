const execSyncMock = jest.fn((command: string) => {
  if (command === 'which ffmpeg') return '/usr/bin/ffmpeg\n';
  if (command === 'which ffprobe') return '/usr/bin/ffprobe\n';
  throw new Error(`Unexpected command: ${command}`);
});
const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: execSyncMock,
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: jest.fn(),
  },
}));

describe('VariantService media binary resolution', () => {
  it('uses system ffmpeg and ffprobe without probing unavailable optional packages', async () => {
    await import('../variantService');

    expect(execSyncMock).toHaveBeenCalledWith('which ffmpeg', { encoding: 'utf8' });
    expect(execSyncMock).toHaveBeenCalledWith('which ffprobe', { encoding: 'utf8' });
    expect(loggerInfoMock).toHaveBeenCalledWith('[VariantService] Using system ffmpeg', {
      binaryPath: '/usr/bin/ffmpeg',
    });
    expect(loggerInfoMock).toHaveBeenCalledWith('[VariantService] Using system ffprobe', {
      binaryPath: '/usr/bin/ffprobe',
    });
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});
