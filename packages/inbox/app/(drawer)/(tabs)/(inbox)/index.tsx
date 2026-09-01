/**
 * `/` — the inbox itself. The inbox is the app's root view, so it is served
 * here rather than at `/inbox`.
 */

import { MailboxView } from '@/components/MailboxView';

export default function InboxIndex() {
  return <MailboxView view="inbox" />;
}
