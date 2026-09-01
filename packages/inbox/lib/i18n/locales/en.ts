import type { LocaleDict } from '../types';

/**
 * English (en-US) translation dictionary for the Inbox app.
 *
 * Keys are namespaced by feature area (`common.*`, `tabs.*`, `inbox.*`,
 * `compose.*`, etc.). Use `{{var}}` placeholders for interpolation values
 * such as counts or names.
 *
 * Settings strings live alongside the rest of the dictionary but the
 * SettingsLanding / sections / subscreen components are still being
 * rebuilt in parallel — see the audit notes in the task report for the
 * catalog of settings literals that still need adoption.
 */
const en: LocaleDict = {
  common: {
    cancel: 'Cancel',
    save: 'Save',
    ok: 'OK',
    continue: 'Continue',
    back: 'Back',
    next: 'Next',
    done: 'Done',
    close: 'Close',
    loading: 'Loading…',
    error: 'Error',
    success: 'Success',
    retry: 'Retry',
    delete: 'Delete',
    edit: 'Edit',
    remove: 'Remove',
    confirm: 'Confirm',
    submit: 'Submit',
    search: 'Search',
    yes: 'Yes',
    no: 'No',
    or: 'or',
    and: 'and',
    open: 'Open',
    discard: 'Discard',
    of: 'of',
    more: 'More',
    less: 'Less',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox by Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Inbox',
    search: 'Search',
    settings: 'Settings',
  },

  drawer: {
    starred: 'Starred',
    snoozed: 'Snoozed',
    subscriptions: 'Subscriptions',
    labels: 'Labels',
    more: 'More',
    less: 'Less',
    notSignedIn: 'Not signed in',
    accountSwitcher: 'Account Switcher',
    addAnotherAccount: 'Add another account',
    signOut: 'Sign out',
    switchAccount: 'Switch account, signed in as {{name}}',
    switchingAccount: 'Switching account…',
    expandSidebar: 'Expand sidebar',
    collapseSidebar: 'Collapse sidebar',
    signedOut: {
      title: 'Sign in to manage your email',
      subtitle: 'Access your mailboxes, labels, and compose new messages.',
    },
    mailboxes: {
      Inbox: 'Inbox',
      Sent: 'Sent',
      Drafts: 'Drafts',
      Trash: 'Trash',
      Spam: 'Spam',
      Archive: 'Archive',
      Starred: 'Starred',
      Snoozed: 'Snoozed',
    },
    mailboxA11y: '{{name}}, {{count}} unread',
  },

  home: {
    greeting: {
      morning: 'Good morning',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: "Today's Brief",
    openMenu: 'Open menu',
    jumpToToday: 'Jump to today',
    previousWeek: 'Previous week',
    nextWeek: 'Next week',
    regenerateBrief: 'Regenerate brief',
    inboxSection: 'Inbox',
    needsResponse: 'Needs Response',
    followUp: 'Follow Up',
    needsResponseA11y_one: 'Needs response, {{count}} email',
    needsResponseA11y_other: 'Needs response, {{count}} emails',
    followUpA11y_one: 'Follow up, {{count}} email',
    followUpA11y_other: 'Follow up, {{count}} emails',
    days: {
      sun: 'SUN',
      mon: 'MON',
      tue: 'TUE',
      wed: 'WED',
      thu: 'THU',
      fri: 'FRI',
      sat: 'SAT',
    },
    stats: {
      unread: '{{count}} unread',
      starred: '{{count}} starred',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia is analyzing your inbox…',
      unavailable: 'Unable to generate brief right now.',
      empty: 'No emails to summarize yet.',
    },
    feedEmpty: {
      title: 'All caught up',
      subtitle: 'Nothing new in your inbox.',
    },
    signedOut: {
      subtitle:
        'Sign in to see your daily brief, emails that need a reply, and follow-ups waiting on you.',
    },
  },


  inbox: {
    title: 'Inbox',
    starredTitle: 'Starred',
    searchInMailbox: 'Search in {{mailbox}}',
    emptyTitle: 'Nothing here',
    emptyAllCaught: "You're all caught up.",
    emptySignIn: 'Sign in to access your mail.',
    pagination: '{{from}}–{{to}} of {{total}}',
    remind: 'Remind',
    bundled: 'Bundled',
    flat: 'Flat',
    composeFab: 'Compose new email',
    composeFabLabel: 'Compose',
    askAlia: 'Ask Alia',
    askAliaHint: 'Opens the Alia AI assistant to ask questions about your inbox',
    sections: {
      reminders: 'Reminders',
      pinned: 'Pinned',
      today: 'Today',
      yesterday: 'Yesterday',
      thisWeek: 'This Week',
      thisMonth: 'This Month',
      earlier: 'Earlier',
    },
    aliaSuggestions: {
      unread: {
        label: 'Unread emails',
        prompt: 'What emails need my attention?',
      },
      todaysSummary: {
        label: "Today's summary",
        prompt: 'Summarize my emails from today',
      },
      withAttachments: {
        label: 'With attachments',
        prompt: 'Find emails with attachments',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'Archive folder not available.',
      trashUnavailable: 'Trash folder not available.',
      offlineSync_one: 'Synced {{count}} offline action.',
      offlineSync_other: 'Synced {{count}} offline actions.',
      newVersionAvailable: 'New version available — refresh to update.',
      newEmail: 'New email from {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(no subject)',
      emptyMessage: '(empty message)',
      messagesInConversation_one: '{{count}} message in this conversation',
      messagesInConversation_other: '{{count}} messages in this conversation',
      toRecipients: 'to {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Archive',
      delete: 'Delete',
      markUnread: 'Mark as unread',
      markRead: 'Mark read',
      reply: 'Reply',
      replyAll: 'Reply all',
      forward: 'Forward',
      pin: 'Pin message',
      unpin: 'Unpin message',
      star: 'Star message',
      unstar: 'Unstar message',
      snooze: 'Snooze',
      print: 'Print',
      more: 'More actions',
      moreInline: 'More',
      reportSpam: 'Report spam',
      label: 'Label',
      downloadEml: 'Download .eml',
      messageActions: 'Message actions',
    },
    labelPicker: {
      title: 'Labels',
      empty: 'No labels yet',
    },
    toast: {
      attachmentFailed: 'Failed to download attachment.',
      fileSystemUnavailable: 'File system not available on this device.',
      sharingUnavailable: 'Sharing is not available on this device.',
      printFailed: 'Failed to print email.',
      downloadFailed: 'Failed to download email.',
      saveEmailDialog: 'Save email',
    },
  },

  empty: {
    selectConversation: 'Select a conversation',
    nothingHere: 'Nothing here',
  },

  notFound: {
    title:
      "Couldn't find that conversation. It may have been moved, archived, or deleted.",
    back: 'Back to Inbox',
  },

  search: {
    placeholder: 'Search mail',
    clear: 'Clear search',
    openMenu: 'Open menu',
    goBack: 'Go back',
    filters: {
      from: 'From',
      fromValue: 'From: {{value}}',
      hasAttachment: 'Has attachment',
    },
    nl: {
      understanding: 'Understanding your search…',
      searching: 'Searching: {{filters}}',
      allEmails: 'all emails',
      fromValue: 'from {{value}}',
      toValue: 'to {{value}}',
      subjectContains: 'subject contains "{{value}}"',
      withAttachments: 'with attachments',
      starred: 'starred',
      unread: 'unread',
      read: 'read',
    },
    empty: {
      noResults: 'No results found',
      idle: 'Search your emails',
    },
    results_one: '{{count}} result',
    results_other: '{{count}} results',
  },

  compose: {
    titleCompose: 'Compose',
    titleReply: 'Reply',
    titleForward: 'Forward',
    headTitleCompose: 'Compose · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Compose · Oxy',
    placeholders: {
      to: 'Recipients',
      subject: 'Subject',
      body: 'Compose email',
    },
    fields: {
      from: 'From',
      to: 'To',
      cc: 'Cc',
      bcc: 'Bcc',
    },
    actions: {
      send: 'Send',
      sendNow: 'Send now',
      moreSendOptions: 'More send options',
      sendOptions: 'Send options',
      scheduleSend: 'Schedule send',
      saveDraft: 'Save draft',
      discard: 'Discard',
    },
    saveDraftPrompt: {
      title: 'Save draft?',
      description: 'Do you want to save this message as a draft?',
    },
    dropZone: 'Drop files to attach',
    toast: {
      addRecipient: 'Please add at least one recipient.',
      invalidEmail: 'Please enter a valid email address.',
      sendFailed: 'Unable to send email. Please try again.',
      scheduleFailed: 'Failed to schedule email. Please try again.',
      scheduled: 'Email scheduled for {{time}}',
      uploadFailed: 'Failed to upload attachment.',
      signatureFailed: 'Failed to load signature.',
    },
  },

  inlineReply: {
    placeholder: 'Write your reply…',
    forwardTo: 'Forward to:',
    replyAllTo: 'Reply all to:',
    replyTo: 'Reply to:',
    cc: 'Cc:',
    bcc: 'Bcc:',
    ccBccToggle: 'Cc/Bcc',
    addRecipients: 'Add recipients',
    send: 'Send',
    quotedPrefix: 'On {{date}}, {{author}} wrote:',
    forwardHeader:
      '\n\n---------- Forwarded message ----------\nFrom: {{from}}\nDate: {{date}}\nSubject: {{subject}}\nTo: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Quick replies',
  },

  ai: {
    toolbar: {
      draft: 'Draft',
      polish: 'Polish',
      shorter: 'Shorter',
      longer: 'Longer',
      tone: 'Tone',
      suggestSubject: 'Suggest subject line',
    },
    draftModal: {
      title: 'Draft with AI',
      subtitle: 'Describe what you want to say, and Alia will draft it for you.',
      placeholder: 'e.g., Decline the meeting politely, suggest next week instead',
      toneLabel: 'Tone:',
      cancel: 'Cancel',
      draft: 'Draft',
    },
    toneMenu: {
      title: 'Change tone to…',
    },
    tones: {
      professional: 'Professional',
      casual: 'Casual',
      friendly: 'Friendly',
      formal: 'Formal',
    },
  },

  threadSummary: {
    title: 'Thread Summary',
    messages_one: '{{count}} message',
    messages_other: '{{count}} messages',
    keyPoints: 'Key Points',
    actionItems: 'Action Items',
    due: 'Due: {{date}}',
  },

  staleThread: {
    consider: 'Consider sending a quick reply',
    reply: 'Reply',
  },

  followUpReminder: {
    pastDue: 'Past due commitment',
    upcoming: 'Upcoming commitment',
    description: 'You said "{{text}}" to {{recipient}}',
    deadline: {
      dueToday: 'Due today',
      overdueOneDay: 'Overdue by 1 day',
      overdueDays: 'Overdue by {{days}} days',
      dueTomorrow: 'Due tomorrow',
      dueInDays: 'Due in {{days}} days',
    },
    fallbackName: 'someone',
    view: 'View',
    done: 'Done',
  },

  reminder: {
    create: {
      title: 'Create reminder',
      placeholder: 'What do you want to be reminded about?',
      whenLabel: 'When?',
      submit: 'Create reminder',
      presets: {
        laterToday: 'Later today',
        tomorrowMorning: 'Tomorrow morning',
        thisWeekend: 'This weekend',
        nextWeek: 'Next week',
      },
    },
    time: {
      overdue: 'Overdue · {{date}}, {{time}}',
      today: 'Today, {{time}}',
      tomorrow: 'Tomorrow, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Snooze until…',
    options: {
      laterToday: 'Later today',
      tomorrow: 'Tomorrow',
      thisWeekend: 'This weekend',
      nextWeek: 'Next week',
    },
    time: {
      today: 'Today, {{time}}',
      tomorrow: 'Tomorrow, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: 'Schedule send',
    options: {
      laterToday: 'Later today',
      tomorrowMorning: 'Tomorrow morning',
      tomorrowAfternoon: 'Tomorrow afternoon',
      mondayMorning: 'Monday morning',
    },
  },

  template: {
    insert: 'Insert Template',
  },

  selection: {
    archive: 'Archive',
    delete: 'Delete',
    star: 'Star',
    markRead: 'Mark read',
  },

  subscriptions: {
    title: 'Subscriptions',
    subtitle:
      'When you unsubscribe, it can take a few days to stop receiving messages',
    empty: {
      title: 'No subscriptions found',
      subtitle: 'Senders who email you frequently will appear here.',
    },
    unsubscribe: 'Unsubscribe',
    block: 'Block',
    frequency: {
      twentyPlus: '20+ emails recently',
      tenToTwenty: '10-20 emails recently',
      count_one: '{{count}} email recently',
      count_other: '{{count}} emails recently',
    },
  },

  contacts: {
    searchPlaceholder: 'Search contacts…',
    addContact: 'Add contact',
    cancel: 'Cancel',
    saveContact: 'Save contact',
    save: 'Save',
    edit: {
      cancel: 'Cancel',
    },
    delete: {
      title: 'Delete this contact?',
      description: 'This action cannot be undone.',
      cta: 'Delete',
    },
    starredFilter: 'Starred',
    autoCollected: 'Auto-collected',
    empty: {
      noMatch: 'No contacts match your search.',
      none: 'No contacts yet.',
    },
    toast: {
      nameEmailRequired: 'Name and email are required.',
      created: 'Contact created.',
      updated: 'Contact updated.',
      deleted: 'Contact deleted.',
    },
    form: {
      name: 'Name *',
      email: 'Email *',
      company: 'Company',
      notes: 'Notes',
    },
  },

  shortcuts: {
    title: 'Keyboard shortcuts',
    close: 'Close',
    actions: {
      compose: 'Compose',
      reply: 'Reply',
      replyAll: 'Reply all',
      forward: 'Forward',
      archive: 'Archive',
      delete: 'Delete',
      nextMessage: 'Next message',
      previousMessage: 'Previous message',
      starUnstar: 'Star / unstar',
      markUnread: 'Mark unread',
      search: 'Search',
      help: 'This help',
    },
  },

  cards: {
    purchase: {
      header: 'Purchase',
      order: 'Order #',
      moreItems: '+{{count}} more',
      summary: 'Purchase details',
    },
    bill: {
      header: 'Bill',
      account: 'Account',
      due: 'Due {{date}}',
      overdue: 'Overdue · {{date}}',
      summary: 'Bill details',
    },
    trip: {
      header: 'Trip',
      confirmation: 'Confirmation',
      summary: 'Trip details',
    },
    package: {
      header: 'Package',
      tracking: 'Tracking',
      estimated: 'Est. {{date}}',
      summary: 'Package details',
    },
    event: {
      header: 'Event',
      addToCalendar: 'Add to Calendar',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'Add to Calendar',
      defaultTitle: 'Event',
      summary: 'Event details',
    },
  },

  importance: {
    urgent: 'Urgent',
    action: 'Action needed',
    important: 'Important',
    fyi: 'FYI',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Settings · Inbox · Oxy',
    title: 'Settings',
  },

  auth: {
    gate: {
      title: 'Sign in to access your inbox',
      subtitle: 'Connect your Oxy identity to sync messages, labels, and preferences across every device.',
      footer: 'By signing in you agree to our Terms and acknowledge our Privacy Policy.',
    },
  },
};

export default en;
