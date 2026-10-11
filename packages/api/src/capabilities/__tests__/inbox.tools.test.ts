const mockEmail = {
  listMessages: jest.fn(),
  getMessage: jest.fn(),
  getThread: jest.fn(),
  getMailboxById: jest.fn(),
  getMailboxBySpecialUse: jest.fn(),
  ensureMailboxes: jest.fn(),
  listMailboxes: jest.fn(),
  listLabels: jest.fn(),
  getQuotaUsage: jest.fn(),
  moveMessage: jest.fn(),
  updateMessageFlags: jest.fn(),
  updateMessageLabels: jest.fn(),
  snoozeMessage: jest.fn(),
};
const mockSearch = jest.fn();
const mockSend = jest.fn();
const mockSaveDraft = jest.fn();
const mockSuggest = jest.fn();
const mockSender = jest.fn();
const mockContext = jest.fn();
const mockInMailbox = jest.fn();
const mockListOutbox = jest.fn();
const mockCancelOutbox = jest.fn();

jest.mock('../../services/email.service', () => ({ emailService: mockEmail }));
jest.mock('../../controllers/email.controller', () => ({
  searchMessagesForUser: (...args: unknown[]) => mockSearch(...args),
  sendMessageForUser: (...args: unknown[]) => mockSend(...args),
  saveDraftForUser: (...args: unknown[]) => mockSaveDraft(...args),
  suggestContactsForUser: (...args: unknown[]) => mockSuggest(...args),
  senderIdentityFor: (...args: unknown[]) => mockSender(...args),
}));
jest.mock('../../controllers/emailContext.controller', () => ({
  buildEmailAgentContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  messageBelongsToMailbox: (...args: unknown[]) => mockInMailbox(...args),
}));
jest.mock('../../services/emailOutbox.service', () => ({
  listEmailOutbox: (...args: unknown[]) => mockListOutbox(...args),
  cancelEmailOutbox: (...args: unknown[]) => mockCancelOutbox(...args),
}));

import type { MessageDto } from '../../services/email.service';
import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';
import { INBOX_TOOLS, replyEnvelope, type InboxToolContext } from '../inbox.tools';

const ACCOUNT = 'account-1';
const INBOX = 'mailbox-inbox';
const ARCHIVE = 'mailbox-archive';
const OWN = 'owner@oxy.so';
const account: InboxToolContext = { accountId: ACCOUNT };
const mailboxScoped: InboxToolContext = { accountId: ACCOUNT, mailboxId: INBOX };

function email(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'email-1',
    mailboxId: INBOX,
    messageId: '<original@example.com>',
    from: { name: 'Ana', address: 'ana@example.com' },
    to: [
      { name: '', address: OWN },
      { name: 'Bo', address: 'bo@example.com' },
    ],
    cc: [{ name: '', address: 'cy@example.com' }],
    subject: 'Plans',
    inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>', '<parent@example.com>'],
    ...overrides,
  } as MessageDto;
}

function run(tool: string, input: Record<string, unknown>, context: InboxToolContext = account) {
  const implementation = INBOX_TOOLS[tool];
  if (!implementation) throw new Error(`No tool ${tool}`);
  return implementation(input, context);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmail.getMailboxBySpecialUse.mockImplementation(
    async (_account: string, specialUse: string) =>
      (
        ({
          '\\Inbox': { id: INBOX },
          '\\Archive': { id: ARCHIVE },
          '\\Trash': { id: 'mailbox-trash' },
        }) as Record<string, { id: string }>
      )[specialUse],
  );
  mockEmail.getMailboxById.mockImplementation(async (_account: string, id: string) =>
    [INBOX, ARCHIVE, 'mailbox-custom'].includes(id) ? { id } : undefined,
  );
  mockEmail.listMessages.mockResolvedValue({
    data: [{ id: 'email-1' }],
    total: 3,
    limit: 20,
    offset: 0,
    nextCursor: 'next',
  });
  mockEmail.getMessage.mockResolvedValue(email());
  mockEmail.moveMessage.mockImplementation(async (_a: string, id: string, target: string) => ({
    id,
    mailboxId: target,
  }));
  mockInMailbox.mockResolvedValue(true);
  mockSender.mockResolvedValue({ address: OWN, name: 'Owner' });
  mockSend.mockResolvedValue({ status: 202, data: { messageId: '<sent@oxy.so>', queued: false } });
});

describe('Inbox tools', () => {
  it('implements every catalog tool exactly once', () => {
    expect(Object.keys(INBOX_TOOLS).sort()).toEqual(
      INBOX_CAPABILITY_CATALOG.tools.map(({ name }) => name).sort(),
    );
  });

  describe('listing', () => {
    it('lists the inbox by default, in cursor mode, with the advertised default page size', async () => {
      await expect(run('listEmails', {})).resolves.toEqual({
        data: [{ id: 'email-1' }],
        pagination: { total: 3, limit: 20, hasMore: true, nextCursor: 'next' },
      });
      expect(mockEmail.listMessages).toHaveBeenCalledWith(ACCOUNT, INBOX, {
        limit: 20,
        cursor: '',
        unseenOnly: false,
        starred: false,
      });
    });

    it('lists a named folder, or starred mail across folders', async () => {
      await run('listEmails', { mailbox: 'Archive', unreadOnly: true, limit: 5, cursor: 'c1' });
      expect(mockEmail.listMessages).toHaveBeenLastCalledWith(ACCOUNT, ARCHIVE, {
        limit: 5,
        cursor: 'c1',
        unseenOnly: true,
        starred: false,
      });
      await run('listEmails', { starred: true });
      expect(mockEmail.listMessages).toHaveBeenLastCalledWith(ACCOUNT, null, {
        limit: 20,
        cursor: '',
        unseenOnly: false,
        starred: true,
      });
    });

    it('lists unread mail account-wide — the call that answered 400 for every Alia account ticket', async () => {
      mockEmail.listMessages.mockResolvedValueOnce({
        data: [],
        total: 0,
        limit: 20,
        offset: 0,
        nextCursor: null,
      });
      await expect(run('getUnreadEmails', {})).resolves.toEqual({
        data: [],
        pagination: { total: 0, limit: 20, hasMore: false, nextCursor: null },
      });
      expect(mockEmail.listMessages).toHaveBeenCalledWith(ACCOUNT, null, {
        limit: 20,
        cursor: '',
        unseenOnly: true,
      });
    });

    it('confines a mailbox-scoped caller to its mailbox and refuses another', async () => {
      await run('getUnreadEmails', {}, mailboxScoped);
      expect(mockEmail.listMessages).toHaveBeenLastCalledWith(ACCOUNT, INBOX, expect.anything());
      await run('listEmails', { starred: true }, mailboxScoped);
      expect(mockEmail.listMessages).toHaveBeenLastCalledWith(
        ACCOUNT,
        INBOX,
        expect.objectContaining({ starred: true }),
      );
      await expect(run('listEmails', { mailbox: 'archive' }, mailboxScoped)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        run('searchEmails', { q: 'x', mailbox: 'archive' }, mailboxScoped),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects an unknown mailbox rather than listing everything', async () => {
      await expect(run('listEmails', { mailbox: 'nowhere' })).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('searches with the new filters and returns the one list shape', async () => {
      mockSearch.mockResolvedValue({
        data: [{ id: 'email-2' }],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false, nextCursor: null },
      });
      await expect(
        run('searchEmails', { unread: true, starred: true }, mailboxScoped),
      ).resolves.toEqual({
        data: [{ id: 'email-2' }],
        pagination: { total: 1, limit: 20, hasMore: false, nextCursor: null },
      });
      expect(mockSearch).toHaveBeenCalledWith(
        ACCOUNT,
        expect.objectContaining({
          unread: true,
          starred: true,
          mailboxId: INBOX,
          limit: 20,
          cursor: '',
        }),
      );
      await expect(
        run('searchEmails', { q: 'x', dateAfter: 'last tuesday' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('reading', () => {
    it('reads an email by id within scope and 404s outside it', async () => {
      await expect(run('readEmail', { emailId: 'email-1' }, mailboxScoped)).resolves.toEqual({
        data: email(),
      });
      expect(mockInMailbox).toHaveBeenCalledWith('email-1', ACCOUNT, INBOX);

      mockInMailbox.mockResolvedValueOnce(false);
      await expect(run('readEmail', { emailId: 'email-9' }, mailboxScoped)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockEmail.getMessage).toHaveBeenCalledTimes(1);

      mockEmail.getMessage.mockResolvedValueOnce(undefined);
      await expect(run('readEmail', { emailId: 'missing' })).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('filters a thread to the scoped mailbox', async () => {
      mockEmail.getThread.mockResolvedValue([
        { id: 'a', mailboxId: INBOX },
        { id: 'b', mailboxId: ARCHIVE },
      ]);
      await expect(run('getEmailThread', { emailId: 'a' }, mailboxScoped)).resolves.toEqual({
        data: [{ id: 'a', mailboxId: INBOX }],
      });
      await expect(run('getEmailThread', { emailId: 'a' })).resolves.toEqual({
        data: [
          { id: 'a', mailboxId: INBOX },
          { id: 'b', mailboxId: ARCHIVE },
        ],
      });
    });

    it('builds the planning context for the scoped mailbox', async () => {
      mockContext.mockResolvedValue({ accountId: ACCOUNT });
      await run('getEmailContext', {}, mailboxScoped);
      expect(mockContext).toHaveBeenCalledWith(ACCOUNT, { mailboxId: INBOX, limit: 20 });
    });
  });

  describe('replies', () => {
    it('replies to the sender, threaded, and reply-all adds everyone but the owner', () => {
      expect(replyEnvelope(email(), OWN, false)).toEqual({
        to: [{ name: 'Ana', address: 'ana@example.com' }],
        cc: [],
        subject: 'Re: Plans',
        inReplyTo: '<original@example.com>',
        references: ['<root@example.com>', '<parent@example.com>', '<original@example.com>'],
      });
      expect(replyEnvelope(email(), OWN.toUpperCase(), true)).toMatchObject({
        to: [{ name: 'Ana', address: 'ana@example.com' }],
        cc: [{ name: 'Bo', address: 'bo@example.com' }, { address: 'cy@example.com' }],
      });
    });

    it("answers the owner's own sent mail to its recipients, keeps an existing Re: and skips a broken Message-ID", () => {
      const sent = email({
        from: { name: 'Owner', address: OWN },
        to: [{ name: 'Bo', address: 'bo@example.com' }],
        subject: 'RE: Plans',
        messageId: 'not-a-msg-id',
        references: [],
        inReplyTo: null,
      });
      expect(replyEnvelope(sent, OWN, false)).toEqual({
        to: [{ name: 'Bo', address: 'bo@example.com' }],
        cc: [],
        subject: 'RE: Plans',
      });
    });

    it('prefers Reply-To and refuses an email with nobody to answer', () => {
      expect(
        replyEnvelope(email({ replyTo: { name: '', address: 'list@example.com' } }), OWN, false).to,
      ).toEqual([{ address: 'list@example.com' }]);
      expect(() =>
        replyEnvelope(
          email({ from: { name: '', address: OWN }, to: [{ name: '', address: OWN }], cc: [] }),
          OWN,
          true,
        ),
      ).toThrow(/no recipient/);
    });

    it('sends a reply through the one send path with the transport key', async () => {
      await expect(
        run(
          'replyToEmail',
          { emailId: 'email-1', text: 'Yes', replyAll: true, cc: [{ address: 'bo@example.com' }] },
          {
            accountId: ACCOUNT,
            idempotencyKey: 'key-1',
          },
        ),
      ).resolves.toEqual({ data: { messageId: '<sent@oxy.so>', queued: false } });
      expect(mockSend).toHaveBeenCalledWith(
        ACCOUNT,
        expect.objectContaining({
          to: [{ name: 'Ana', address: 'ana@example.com' }],
          cc: [{ name: 'Bo', address: 'bo@example.com' }, { address: 'cy@example.com' }],
          subject: 'Re: Plans',
          text: 'Yes',
          inReplyTo: '<original@example.com>',
        }),
        'key-1',
      );
      await expect(run('replyToEmail', { emailId: 'email-1' })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('drafts a reply without sending, letting explicit fields win', async () => {
      mockSaveDraft.mockResolvedValue({ id: 'draft-1' });
      await expect(
        run('createDraft', { replyToEmailId: 'email-1', subject: 'Different', text: 'Draft' }),
      ).resolves.toEqual({ data: { id: 'draft-1' } });
      expect(mockSaveDraft).toHaveBeenCalledWith(
        ACCOUNT,
        expect.objectContaining({
          to: [{ name: 'Ana', address: 'ana@example.com' }],
          subject: 'Different',
          inReplyTo: '<original@example.com>',
        }),
      );
      expect(mockSend).not.toHaveBeenCalled();
      await expect(run('createDraft', {})).rejects.toMatchObject({ statusCode: 400 });
    });

    it('sends a new email with only whitelisted fields and refuses a past schedule', async () => {
      await run(
        'sendEmail',
        { to: [{ address: 'x@example.com' }], text: 'Hi', surprise: 'ignored' },
        {
          accountId: ACCOUNT,
          idempotencyKey: 'key-2',
        },
      );
      expect(mockSend).toHaveBeenCalledWith(
        ACCOUNT,
        expect.not.objectContaining({ surprise: expect.anything() }),
        'key-2',
      );
      await expect(
        run('sendEmail', {
          to: [{ address: 'x@example.com' }],
          scheduledAt: '2000-01-01T00:00:00Z',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('organizing', () => {
    it('archives and trashes by moving into the special mailbox, after the scope check', async () => {
      await expect(run('archiveEmail', { emailId: 'email-1' }, mailboxScoped)).resolves.toEqual({
        data: { id: 'email-1', mailboxId: ARCHIVE },
      });
      await run('trashEmail', { emailId: 'email-1' });
      expect(mockEmail.moveMessage).toHaveBeenLastCalledWith(ACCOUNT, 'email-1', 'mailbox-trash');

      mockInMailbox.mockResolvedValueOnce(false);
      await expect(
        run('trashEmail', { emailId: 'elsewhere' }, mailboxScoped),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(mockEmail.moveMessage).toHaveBeenCalledTimes(2);
    });

    it('moves by folder name or id', async () => {
      await run('moveEmail', { emailId: 'email-1', mailbox: 'mailbox-custom' });
      expect(mockEmail.moveMessage).toHaveBeenLastCalledWith(ACCOUNT, 'email-1', 'mailbox-custom');
      await run('moveEmail', { emailId: 'email-1', mailbox: 'inbox' });
      expect(mockEmail.moveMessage).toHaveBeenLastCalledWith(ACCOUNT, 'email-1', INBOX);
    });

    it('updates only the organizing flags and refuses an empty change', async () => {
      await run('updateEmailFlags', { emailId: 'email-1', flags: { seen: true, draft: true } });
      expect(mockEmail.updateMessageFlags).toHaveBeenCalledWith(ACCOUNT, 'email-1', { seen: true });
      await expect(
        run('updateEmailFlags', { emailId: 'email-1', flags: {} }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('adds and removes labels, and needs one of the two', async () => {
      await run('setEmailLabels', { emailId: 'email-1', add: ['Work'], remove: ['Later'] });
      expect(mockEmail.updateMessageLabels).toHaveBeenCalledWith(
        ACCOUNT,
        'email-1',
        ['Work'],
        ['Later'],
      );
      await expect(run('setEmailLabels', { emailId: 'email-1' })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('snoozes only into the future', async () => {
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await run('snoozeEmail', { emailId: 'email-1', until });
      expect(mockEmail.snoozeMessage).toHaveBeenCalledWith(ACCOUNT, 'email-1', new Date(until));
      await expect(
        run('snoozeEmail', { emailId: 'email-1', until: '2001-01-01T00:00:00Z' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('lists and cancels outbound deliveries of the account', async () => {
      mockListOutbox.mockResolvedValue([{ id: 'out-1' }]);
      mockCancelOutbox.mockResolvedValue({ id: 'out-1', status: 'cancelled' });
      await expect(run('listOutboundEmails', {})).resolves.toEqual({ data: [{ id: 'out-1' }] });
      expect(mockListOutbox).toHaveBeenCalledWith(ACCOUNT, 20);
      await expect(run('cancelOutboundEmail', { outboxId: 'out-1' })).resolves.toEqual({
        data: { id: 'out-1', status: 'cancelled' },
      });
    });
  });
});
