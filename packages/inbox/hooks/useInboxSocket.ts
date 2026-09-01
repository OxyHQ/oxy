/**
 * Real-time inbox socket.
 *
 * Connects ONCE at the authenticated layout level (see `app/_layout.tsx`) and
 * fans `email:new` / `email:unread_count` events from the API into the existing
 * react-query caches so new mail appears instantly in the open list and the
 * mailbox unread badges update without a follow-up HTTP fetch.
 *
 * Follows the same strict-whitelist pattern as `useSessionSocket` in
 * `@oxyhq/services` — unknown events log a dev warning and are otherwise
 * a no-op. Never add an `else` branch that triggers side effects.
 */

import { useEffect, useRef } from 'react';
import io, { type Socket } from 'socket.io-client';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom';
import { useOxy } from '@oxyhq/services';

import { useEmailStore } from '@/hooks/useEmail';
import { emailKeys } from '@/hooks/queries/queryKeys';
import { useTranslation } from '@/lib/i18n';
import type { Mailbox, Message, Pagination } from '@/services/emailApi';

/**
 * Server → client socket event payload contracts. Mirror exactly the
 * `EmailNewEvent` / `EmailUnreadCountEvent` interfaces in
 * `packages/api/src/types/socketEvents.ts` — both sides MUST stay in sync.
 */
export interface EmailNewEvent {
  messageId: string;
  mailboxId: string;
  folder: string;
  from: { name?: string; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: true;
}

export interface EmailUnreadCountEvent {
  mailboxId: string;
  unread: number;
}

type InboxSocketEventType = 'email:new' | 'email:unread_count';

interface MessagesPage {
  data: Message[];
  pagination: Pagination;
}

type MessagesInfinite = InfiniteData<MessagesPage>;

/**
 * Build a Message-shaped placeholder from an `EmailNewEvent` payload so the
 * optimistic prepend renders correctly until the reconciling refetch lands.
 *
 * The placeholder MUST satisfy `Message` (zod-inferred) at the type level —
 * every required field gets a safe default. `_id` is namespaced so it never
 * collides with a real Mongo id; dedupe of the eventual real row happens on
 * the `messageId` (MIME `Message-Id`) field, which IS stable.
 */
function buildOptimisticMessage(event: EmailNewEvent, userId: string): Message {
  return {
    _id: `optimistic:${event.messageId}`,
    userId,
    mailboxId: event.mailboxId,
    messageId: event.messageId,
    from: event.from,
    to: [],
    subject: event.subject,
    text: event.snippet,
    html: null,
    attachments: [],
    flags: {
      seen: false,
      starred: false,
      answered: false,
      forwarded: false,
      draft: false,
      pinned: false,
    },
    labels: [],
    size: 0,
    date: event.receivedAt,
    receivedAt: event.receivedAt,
  };
}

/**
 * Prepend the optimistic message to every cached `['messages', mailboxId, …]`
 * page list whose mailbox matches. Skips if a row with the same
 * `messageId` is already present (race with a concurrent manual refetch).
 */
function prependToMessageCache(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
  mailboxId: string,
  optimistic: Message,
) {
  queryClient.setQueriesData<MessagesInfinite>(
    {
      // The query key shape is ['messages', mailboxId, starred, label, userId]. We
      // match by predicate so the prepend lands in every active variant
      // (including starred + label views the message also belongs to,
      // though `email:new` only carries the mailbox id, so we match on
      // mailbox + userId — starred/label cohorts will refresh via the
      // reconciliation invalidate below).
      predicate: (q) => {
        const key = q.queryKey;
        return (
          Array.isArray(key) &&
          key[0] === 'messages' &&
          key[1] === mailboxId &&
          key[4] === userId
        );
      },
    },
    (old) => {
      if (!old || old.pages.length === 0) return old;
      const alreadyPresent = old.pages.some((page) =>
        page.data.some((m) => m.messageId === optimistic.messageId),
      );
      if (alreadyPresent) return old;
      const [firstPage, ...rest] = old.pages;
      return {
        ...old,
        pages: [
          { ...firstPage, data: [optimistic, ...firstPage.data] },
          ...rest,
        ],
      };
    },
  );
}

/**
 * Update the mailbox unread count in the `['mailboxes', userId]` cache so the
 * sidebar badge re-renders without a network round-trip.
 */
function updateMailboxUnread(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
  mailboxId: string,
  unread: number,
) {
  queryClient.setQueryData<Mailbox[] | undefined>(emailKeys.mailboxes.list(userId), (old) => {
    if (!old) return old;
    let mutated = false;
    const next = old.map((mb) => {
      if (mb._id !== mailboxId) return mb;
      if (mb.unseenMessages === unread) return mb;
      mutated = true;
      return { ...mb, unseenMessages: unread };
    });
    return mutated ? next : old;
  });
}

interface UseInboxSocketOptions {
  /** Override the socket URL. Defaults to the same baseURL the inbox API uses. */
  baseURL: string;
}

/**
 * Subscribe to inbox realtime events. The hook is a no-op until a user is
 * signed in (`useOxy().user`), and tears the socket down on sign-out / user
 * switch — react-query caches survive, so reconciling fetches happen the
 * moment a new session is restored.
 *
 * Single legitimate `useEffect`: opening + closing an external connection.
 */
export function useInboxSocket({ baseURL }: UseInboxSocketOptions) {
  const { user, oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const viewMode = useEmailStore((s) => s.viewMode);

  const userId = user?.id ?? null;
  const socketRef = useRef<Socket | null>(null);

  // Keep latest values in refs so the socket subscription doesn't tear down
  // and re-create on every render. The handlers always read fresh values.
  const queryClientRef = useRef(queryClient);
  const viewModeRef = useRef(viewMode);
  const tokenGetterRef = useRef(() => oxyServices.getAccessToken());
  const toastTitleRef = useRef(t);

  queryClientRef.current = queryClient;
  viewModeRef.current = viewMode;
  tokenGetterRef.current = () => oxyServices.getAccessToken();
  toastTitleRef.current = t;

  useEffect(() => {
    if (!userId || !baseURL) {
      const existing = socketRef.current;
      if (existing) {
        existing.disconnect();
        socketRef.current = null;
      }
      return;
    }

    const socket = io(baseURL, {
      transports: ['websocket'],
      auth: (cb) => {
        const token = tokenGetterRef.current();
        cb({ token: token ?? '' });
      },
    });
    socketRef.current = socket;

    const isEmailNewEvent = (value: unknown): value is EmailNewEvent => {
      if (typeof value !== 'object' || value === null) return false;
      const v = value as Record<string, unknown>;
      const from = v.from as Record<string, unknown> | undefined;
      return (
        typeof v.messageId === 'string' &&
        typeof v.mailboxId === 'string' &&
        typeof v.folder === 'string' &&
        typeof v.subject === 'string' &&
        typeof v.snippet === 'string' &&
        typeof v.receivedAt === 'string' &&
        typeof from === 'object' &&
        from !== null &&
        typeof from.address === 'string'
      );
    };

    const isEmailUnreadCountEvent = (value: unknown): value is EmailUnreadCountEvent => {
      if (typeof value !== 'object' || value === null) return false;
      const v = value as Record<string, unknown>;
      return typeof v.mailboxId === 'string' && typeof v.unread === 'number';
    };

    const handleEvent = (eventType: InboxSocketEventType, payload: unknown) => {
      switch (eventType) {
        case 'email:new': {
          if (!isEmailNewEvent(payload)) {
            if (__DEV__) {
              console.warn('[useInboxSocket] Malformed email:new payload:', payload);
            }
            return;
          }
          const event = payload;
          const optimistic = buildOptimisticMessage(event, userId);

          // 1. Optimistic prepend — instant UI update, no round-trip.
          prependToMessageCache(queryClientRef.current, userId, event.mailboxId, optimistic);

          // 2. Bump the unread badge optimistically by 1; the authoritative
          //    `email:unread_count` event (emitted alongside by the server)
          //    will reconcile the exact number.
          queryClientRef.current.setQueryData<Mailbox[] | undefined>(emailKeys.mailboxes.list(userId), (old) => {
            if (!old) return old;
            let mutated = false;
            const next = old.map((mb) => {
              if (mb._id !== event.mailboxId) return mb;
              mutated = true;
              return { ...mb, unseenMessages: mb.unseenMessages + 1 };
            });
            return mutated ? next : old;
          });

          // 3. Reconciliation safety net — refetch the affected list so the
          //    optimistic placeholder is replaced by the real, fully-typed
          //    Message (with real `_id`, full `to`, `threadCount`, etc.).
          queryClientRef.current.invalidateQueries({
            predicate: (q) => {
              const key = q.queryKey;
              return (
                Array.isArray(key) &&
                key[0] === 'messages' &&
                key[1] === event.mailboxId &&
                key[4] === userId
              );
            },
          });

          // 4. Discreet toast when the user is viewing a different mailbox
          //    or a non-mailbox view (starred / label). NEVER toast when
          //    they're already looking at the folder the mail landed in —
          //    the new row appearing at the top is signal enough.
          const currentView = viewModeRef.current;
          const isViewingTargetMailbox =
            currentView?.type === 'mailbox' && currentView.mailbox._id === event.mailboxId;
          if (!isViewingTargetMailbox) {
            const sender = event.from.name ?? event.from.address;
            toast.info(toastTitleRef.current('inbox.toast.newEmail', { sender }));
          }
          break;
        }
        case 'email:unread_count': {
          if (!isEmailUnreadCountEvent(payload)) {
            if (__DEV__) {
              console.warn('[useInboxSocket] Malformed email:unread_count payload:', payload);
            }
            return;
          }
          updateMailboxUnread(queryClientRef.current, userId, payload.mailboxId, payload.unread);
          break;
        }
      }
    };

    const handleEmailNew = (payload: EmailNewEvent) => {
      handleEvent('email:new', payload);
    };

    const handleEmailUnreadCount = (payload: EmailUnreadCountEvent) => {
      handleEvent('email:unread_count', payload);
    };

    const handleUnknown = (eventName: string) => {
      // Strict whitelist diagnostic: unknown events MUST NOT trigger side
      // effects. Dev-only warning, otherwise silent. Mirrors the
      // `useSessionSocket` pattern documented in CLAUDE.md.
      //
      // Scoped to the `email:` namespace on purpose. The `user:<id>` room is
      // shared with every other domain that pushes to this user — session,
      // civic, socket.io's own lifecycle events — and none of those are this
      // hook's business. Warning about them turns a real diagnostic ("a new
      // email event exists that we don't handle") into noise.
      if (
        __DEV__ &&
        eventName.startsWith('email:') &&
        eventName !== 'email:new' &&
        eventName !== 'email:unread_count'
      ) {
        console.warn('[useInboxSocket] Unhandled email event:', eventName);
      }
    };

    socket.on('email:new', handleEmailNew);
    socket.on('email:unread_count', handleEmailUnreadCount);
    socket.onAny(handleUnknown);

    return () => {
      socket.off('email:new', handleEmailNew);
      socket.off('email:unread_count', handleEmailUnreadCount);
      socket.offAny(handleUnknown);
      socket.disconnect();
      socketRef.current = null;
    };
    // The socket is keyed only on the values that should force a reconnect
    // (user identity, server URL). Everything else flows via refs.
  }, [userId, baseURL]);
}
