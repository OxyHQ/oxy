/**
 * `limit` / `offset` on every email list endpoint that parses them from the
 * query string, and the `pagination` block each one answers with.
 *
 * A negative value used to reach Postgres as `LIMIT -5` / `OFFSET -1`, which
 * it refuses — a 500. Every site now clamps to [1, 100] and >= 0 as
 * `listContacts` already did, and the wire shape is unchanged.
 *
 * The service is stubbed: what is pinned here is what the controller hands it
 * and the wire shape it builds from the result — and, for `listMessages`, that
 * the folder check runs beside the listing without changing which error wins.
 */

import type { Response } from 'express';

const mockListMessages = jest.fn();
const mockGetMailboxById = jest.fn();
const mockSearchMessages = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockListBundledMessages = jest.fn();
const mockListReminders = jest.fn();
const mockListContacts = jest.fn();

jest.mock('../../services/email.service', () => ({
  emailService: {
    listMessages: (...args: unknown[]) => mockListMessages(...args),
    getMailboxById: (...args: unknown[]) => mockGetMailboxById(...args),
    searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
    getSubscriptions: (...args: unknown[]) => mockGetSubscriptions(...args),
    listBundledMessages: (...args: unknown[]) => mockListBundledMessages(...args),
    listReminders: (...args: unknown[]) => mockListReminders(...args),
    listContacts: (...args: unknown[]) => mockListContacts(...args),
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

import {
  listBundledMessages,
  listContacts,
  listMessages,
  listReminders,
  listSubscriptions,
  searchMessages,
  searchMessagesForUser,
} from '../email.controller';

const userId = '64b0000000000000000000aa';
const mailboxId = '507f1f77bcf86cd799439012';

type Handler = (req: never, res: Response) => Promise<void>;

interface Site {
  name: string;
  handler: Handler;
  /** Query parameters the endpoint needs besides paging. */
  query: Record<string, string>;
  /** The `{limit, offset}` the service received. */
  paging: () => { limit: number; offset: number };
}

function lastOptions(mock: jest.Mock, index: number): { limit: number; offset: number } {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('the service was not called');
  const { limit, offset } = call[index] as { limit: number; offset: number };
  return { limit, offset };
}

const SITES: Site[] = [
  {
    name: 'listMessages',
    handler: listMessages,
    query: { mailbox: mailboxId },
    paging: () => lastOptions(mockListMessages, 2),
  },
  {
    name: 'searchMessages',
    handler: searchMessages,
    query: { q: 'invoice' },
    paging: () => lastOptions(mockSearchMessages, 2),
  },
  {
    name: 'listSubscriptions',
    handler: listSubscriptions,
    query: {},
    paging: () => lastOptions(mockGetSubscriptions, 1),
  },
  {
    name: 'listBundledMessages',
    handler: listBundledMessages,
    query: {},
    paging: () => lastOptions(mockListBundledMessages, 2),
  },
  {
    name: 'listReminders',
    handler: listReminders,
    query: {},
    paging: () => lastOptions(mockListReminders, 1),
  },
  {
    name: 'listContacts',
    handler: listContacts,
    query: {},
    paging: () => lastOptions(mockListContacts, 1),
  },
];

let res: { json: jest.Mock };

async function call(site: Site, paging: Record<string, string>): Promise<Record<string, unknown>> {
  res = { json: jest.fn().mockReturnThis() };
  await site.handler(
    { user: { id: userId }, query: { ...site.query, ...paging } } as never,
    res as unknown as Response,
  );
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMailboxById.mockResolvedValue({ id: mailboxId });
  // The services echo the paging they were given, as the real ones do.
  mockListMessages.mockImplementation(
    async (_u: string, _m: string | null, o: { limit: number; offset: number }) => ({
      data: [],
      total: 0,
      limit: o.limit,
      offset: o.offset,
    }),
  );
  mockSearchMessages.mockImplementation(
    async (_u: string, _q: string, o: { limit: number; offset: number }) => ({
      data: [],
      total: 0,
      limit: o.limit,
      offset: o.offset,
    }),
  );
  mockGetSubscriptions.mockResolvedValue({ data: [], total: 0 });
  mockListBundledMessages.mockResolvedValue({ primary: [], bundles: [], total: 0 });
  mockListReminders.mockImplementation(
    async (_u: string, o: { limit: number; offset: number }) => ({
      data: [],
      pagination: { total: 0, limit: o.limit, offset: o.offset, hasMore: false },
    }),
  );
  mockListContacts.mockResolvedValue({ data: [], total: 0 });
});

describe.each(SITES)('$name paging', (site) => {
  it('defaults to 50 from 0', async () => {
    const body = await call(site, {});

    expect(site.paging()).toEqual({ limit: 50, offset: 0 });
    expect(body.pagination).toEqual({ total: 0, limit: 50, offset: 0, hasMore: false });
  });

  it('caps the limit at 100 and passes a positive offset through', async () => {
    const body = await call(site, { limit: '500', offset: '20' });

    expect(site.paging()).toEqual({ limit: 100, offset: 20 });
    expect(body.pagination).toEqual({ total: 0, limit: 100, offset: 20, hasMore: false });
  });

  it('clamps a negative limit to 1 and a negative offset to 0', async () => {
    const body = await call(site, { limit: '-5', offset: '-1' });

    expect(site.paging()).toEqual({ limit: 1, offset: 0 });
    expect(body.pagination).toEqual({ total: 0, limit: 1, offset: 0, hasMore: false });
  });

  it('treats a limit of 0 or a non-number as the default', async () => {
    await call(site, { limit: '0', offset: 'x' });
    expect(site.paging()).toEqual({ limit: 50, offset: 0 });

    await call(site, { limit: 'abc' });
    expect(site.paging()).toEqual({ limit: 50, offset: 0 });
  });
});

describe('searchMessagesForUser paging (the capability path)', () => {
  it('defaults to 50 from 0 and caps the limit at 100', async () => {
    await searchMessagesForUser(userId, { q: 'invoice' });
    expect(lastOptions(mockSearchMessages, 2)).toEqual({ limit: 50, offset: 0 });

    await searchMessagesForUser(userId, { q: 'invoice', limit: 500, offset: 20 });
    expect(lastOptions(mockSearchMessages, 2)).toEqual({ limit: 100, offset: 20 });
  });

  it('clamps a negative limit to 1 and a negative offset to 0', async () => {
    await searchMessagesForUser(userId, { q: 'invoice', limit: -5, offset: -1 });
    expect(lastOptions(mockSearchMessages, 2)).toEqual({ limit: 1, offset: 0 });
  });
});

describe('listMessages authorizes the folder alongside the listing', () => {
  const req = (query: Record<string, string>) =>
    ({ user: { id: userId }, query: { mailbox: mailboxId, ...query } }) as never;

  it('starts the listing before the folder lookup has answered', async () => {
    let answer!: (row: { id: string }) => void;
    mockGetMailboxById.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    res = { json: jest.fn().mockReturnThis() };

    const done = listMessages(req({}), res as unknown as Response);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockListMessages).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    answer({ id: mailboxId });
    await done;
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a folder that is not the caller`s, whatever the listing did', async () => {
    mockGetMailboxById.mockResolvedValue(undefined);
    mockListMessages.mockRejectedValue(new Error('Invalid email pagination cursor'));
    res = { json: jest.fn().mockReturnThis() };

    await expect(listMessages(req({}), res as unknown as Response)).rejects.toMatchObject({
      name: 'NotFoundError',
      message: 'Mailbox not found',
    });
    expect(res.json).not.toHaveBeenCalled();
  });

  it('answers the folder lookup`s own failure before the listing`s', async () => {
    mockGetMailboxById.mockRejectedValue(new Error('lookup failed'));
    mockListMessages.mockRejectedValue(new Error('listing failed'));

    await expect(listMessages(req({}), { json: jest.fn() } as unknown as Response)).rejects.toThrow(
      'lookup failed',
    );
  });

  it('answers the listing`s failure once the folder is the caller`s', async () => {
    mockListMessages.mockRejectedValue(new Error('listing failed'));

    await expect(listMessages(req({}), { json: jest.fn() } as unknown as Response)).rejects.toThrow(
      'listing failed',
    );
  });
});
