const mockMessageFind = jest.fn();
const mockCountDocuments = jest.fn();

// The global jest.setup.cjs mock for `mongoose` does not expose `Types.ObjectId`,
// which `searchMessages` calls before any filter normalization. Provide a minimal
// constructor so the method reaches the structured-filter logic under test.
jest.mock('mongoose', () => {
  class ObjectId {
    constructor(public readonly value: string) {}
    toString() {
      return this.value;
    }
  }
  return {
    __esModule: true,
    default: { Types: { ObjectId } },
    Types: { ObjectId },
  };
});

jest.mock('../../models/Message', () => ({
  Message: {
    find: (...args: unknown[]) => mockMessageFind(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

jest.mock('../../models/Mailbox', () => ({ Mailbox: {} }));
jest.mock('../../models/Label', () => ({ Label: {} }));
jest.mock('../../models/Bundle', () => ({ Bundle: {} }));
jest.mock('../../models/User', () => ({ __esModule: true, default: {} }));
jest.mock('../../models/Reminder', () => ({ Reminder: {} }));
jest.mock('../../models/Contact', () => ({ Contact: {} }));
jest.mock('../../models/EmailTemplate', () => ({ EmailTemplate: {} }));
jest.mock('../../models/EmailFilter', () => ({ EmailFilter: {} }));
jest.mock('../senderAvatar.service', () => ({ getAvatarPathsBatch: jest.fn() }));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: {} }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: {} }));
jest.mock('../smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../push.service', () => ({ pushService: {} }));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { emailService } from '../email.service';

function mockFindChain() {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  };
  mockMessageFind.mockReturnValue(chain);
  return chain;
}

function mockCountChain() {
  const chain = {
    maxTimeMS: jest.fn().mockResolvedValue(0),
  };
  mockCountDocuments.mockReturnValue(chain);
  return chain;
}

describe('emailService.searchMessages structured filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats from, to, and subject filters as escaped literal regex strings', async () => {
    const findChain = mockFindChain();
    const countChain = mockCountChain();

    await emailService.searchMessages('64b000000000000000000001', '', {
      from: '(a+)+$@example.com',
      to: 'ops+alerts@example.com',
      subject: 'Invoice [Q2] (final)?',
    });

    const filter = mockMessageFind.mock.calls[0][0];
    expect(filter['from.address']).toEqual({ $regex: '\\(a\\+\\)\\+\\$@example\\.com', $options: 'i' });
    expect(filter['to.address']).toEqual({ $regex: 'ops\\+alerts@example\\.com', $options: 'i' });
    expect(filter.subject).toEqual({ $regex: 'Invoice \\[Q2\\] \\(final\\)\\?', $options: 'i' });
    expect(mockCountDocuments).toHaveBeenCalledWith(filter);
    expect(findChain.maxTimeMS).toHaveBeenCalledWith(5000);
    expect(countChain.maxTimeMS).toHaveBeenCalledWith(5000);
  });

  it('rejects overlong structured filters before querying MongoDB', async () => {
    mockFindChain();
    mockCountChain();

    await expect(
      emailService.searchMessages('64b000000000000000000001', '', {
        from: 'a'.repeat(129),
      }),
    ).rejects.toThrow('Search filters must be 128 characters or fewer');

    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'unread'],
    [true, 'read'],
  ])('adds flags.seen=%s for the %s read-state filter', async (seen) => {
    mockFindChain();
    mockCountChain();

    await emailService.searchMessages('64b000000000000000000001', '', { seen });

    expect(mockMessageFind.mock.calls[0][0]).toMatchObject({ 'flags.seen': seen });
    expect(mockCountDocuments.mock.calls[0][0]).toMatchObject({ 'flags.seen': seen });
  });
});
