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

jest.mock('../../models/User', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../models/Message', () => ({
  Message: {},
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

  it('maps is:unread in q to a seen=false filter without sending the operator to text search', async () => {
    const req = {
      user: { id: userId },
      query: { q: 'is:unread' },
    };

    await searchMessages(req as never, res as Response);

    expect(mockSearchMessages).toHaveBeenCalledWith(userId, '', {
      limit: 50,
      offset: 0,
      mailboxId: undefined,
      from: undefined,
      to: undefined,
      subject: undefined,
      hasAttachment: undefined,
      dateAfter: undefined,
      dateBefore: undefined,
      starred: undefined,
      label: undefined,
      seen: false,
    });
  });

  it('maps is:read while preserving ordinary text terms', async () => {
    const req = {
      user: { id: userId },
      query: { q: 'invoice is:read' },
    };

    await searchMessages(req as never, res as Response);

    expect(mockSearchMessages).toHaveBeenCalledWith(userId, 'invoice', expect.objectContaining({ seen: true }));
  });

  it('rejects conflicting read-state operators', async () => {
    const req = {
      user: { id: userId },
      query: { q: 'is:unread is:read' },
    };

    await expect(searchMessages(req as never, res as Response)).rejects.toThrow(
      'is:read and is:unread cannot be used together',
    );
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });

  it('rejects repeated q parameters instead of accepting an ambiguous value', async () => {
    const req = {
      user: { id: userId },
      query: { q: ['is:unread', 'is:read'] },
    };

    await expect(searchMessages(req as never, res as Response)).rejects.toThrow(
      'q must be a single string value',
    );
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });
});
