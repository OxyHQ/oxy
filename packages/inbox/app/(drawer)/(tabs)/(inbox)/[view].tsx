/**
 * Dynamic route for system mailbox views.
 *
 * Handles: /sent, /drafts, /trash, /spam, /archive, /starred, /snoozed and
 * custom folders addressed by mailbox id.
 *
 * The inbox is NOT one of them — it lives at `/` (see `index.tsx`), so
 * `/inbox` redirects there to keep a single canonical URL.
 *
 * Labels live at `/label/<name>` and are owned by `label/[name].tsx` — they
 * are intentionally NOT handled here.
 */

import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { MailboxView } from '@/components/MailboxView';

export default function MailboxViewRoute() {
  const { view } = useLocalSearchParams<{ view: string }>();

  if (!view || view.toLowerCase() === 'inbox') {
    return <Redirect href="/" />;
  }

  return <MailboxView view={view} />;
}
