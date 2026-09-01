import type { Response } from 'express';

const mockSearchMessages = jest.fn();

jest.mock('../../services/email.service', () => ({
  emailService: {
    searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
  },
}));

jest.mock('../../services/smtp.outbound', () => ({
  smtpOutbound: {},
}));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {},
}));

jest.mock('../../config/email.config', () => ({
  resolveEmailAddress: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

import { searchMessages } from '../email.controller';
import { BadRequestError } from '../../utils/error';

describe('email.controller searchMessages', () => {
  const userId = '64b0000000000000000000aa';
  let res: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    res = {
      json: jest.fn().mockReturnThis(),
    };
    mockSearchMessages.mockResolvedValue({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it('accepts mailbox-only searches', async () => {
    const req = {
      user: { id: userId },
      query: { mailbox: '507f1f77bcf86cd799439012' },
    };

    await searchMessages(req as never, res as Response);

    expect(mockSearchMessages).toHaveBeenCalledWith(userId, '', {
      limit: 50,
      offset: 0,
      mailboxId: '507f1f77bcf86cd799439012',
      from: undefined,
      to: undefined,
      subject: undefined,
      hasAttachment: undefined,
      dateAfter: undefined,
      dateBefore: undefined,
      starred: undefined,
      label: undefined,
      seen: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      data: [],
      pagination: {
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
    });
  });

  it('still rejects searches with no criteria', async () => {
    const req = {
      user: { id: userId },
      query: {},
    };

    await expect(
      searchMessages(req as never, res as Response),
    ).rejects.toThrow(BadRequestError);
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['is:read', true],
    ['is:unread', false],
  ])('maps %s to the messages.seen filter', async (q, seen) => {
    const req = {
      user: { id: userId },
      query: { q },
    };

    await searchMessages(req as never, res as Response);

    expect(mockSearchMessages).toHaveBeenCalledWith(userId, '', expect.objectContaining({ seen }));
  });

  it('keeps normal search text when an is operator is present', async () => {
    const req = {
      user: { id: userId },
      query: { q: 'invoice is:unread' },
    };

    await searchMessages(req as never, res as Response);

    expect(mockSearchMessages).toHaveBeenCalledWith(
      userId,
      'invoice',
      expect.objectContaining({ seen: false }),
    );
  });

  it('rejects conflicting read operators', async () => {
    const req = {
      user: { id: userId },
      query: { q: 'is:read is:unread' },
    };

    await expect(searchMessages(req as never, res as Response)).rejects.toThrow(BadRequestError);
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });

  it('rejects a repeated q query parameter', async () => {
    const req = {
      user: { id: userId },
      query: { q: ['is:unread', 'is:read'] },
    };

    await expect(searchMessages(req as never, res as Response)).rejects.toThrow(BadRequestError);
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });
});
