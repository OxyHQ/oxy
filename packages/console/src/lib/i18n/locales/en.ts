import type { LocaleDict } from '../types';

/**
 * English (en-US) translation dictionary for the Oxy Cloud Console.
 *
 * Keys cover developer-console-specific surfaces: dashboard, apps,
 * credentials, billing, usage, documentation, settings.
 */
const en: LocaleDict = {
  common: {
    cancel: 'Cancel',
    save: 'Save',
    continue: 'Continue',
    back: 'Back',
    next: 'Next',
    delete: 'Delete',
    edit: 'Edit',
    create: 'Create',
    update: 'Update',
    confirm: 'Confirm',
    loading: 'Loading…',
    error: 'Error',
    success: 'Success',
    copy: 'Copy',
    copied: 'Copied',
    search: 'Search',
    settings: 'Settings',
    learnMore: 'Learn more',
  },

  app: {
    name: 'Oxy Cloud',
    title: 'Oxy Cloud Console',
  },

  language: {
    picker: {
      label: 'Language',
      ariaLabel: 'Choose language',
    },
  },

  nav: {
    dashboard: 'Dashboard',
    apps: 'Apps',
    models: 'Models',
    playground: 'Playground',
    usage: 'Usage',
    billing: 'Billing',
    documentation: 'Documentation',
    examples: 'Examples',
    settings: 'Settings',
  },

  dashboard: {
    title: 'Dashboard',
    subtitle: 'Your Oxy Cloud activity at a glance.',
    sections: {
      recentActivity: 'Recent activity',
      yourApps: 'Your apps',
      quickActions: 'Quick actions',
    },
  },

  apps: {
    title: 'Apps',
    subtitle: 'Manage developer apps and credentials.',
    empty: {
      title: 'No apps yet',
      subtitle: 'Create your first app to start integrating with Oxy.',
      cta: 'Create app',
    },
    create: {
      title: 'Create new app',
      nameLabel: 'App name',
      namePlaceholder: 'My awesome app',
      submit: 'Create app',
    },
    keys: {
      title: 'Credentials',
      subtitle: 'Manage credentials for this app.',
      create: 'Create credential',
      reveal: 'Reveal once',
      copyValue: 'Copy client ID',
      copySecret: 'Copy secret',
      revealHint:
        'Secrets are shown once at creation. Copy yours now — Oxy will never display it again. The client ID is public and can be copied at any time.',
    },
    usage: {
      title: 'Usage',
      subtitle: 'Requests, tokens and quota for this app.',
    },
    settings: {
      title: 'App settings',
      delete: {
        title: 'Delete app',
        description:
          'Deleting this app permanently revokes its keys and ends every active session. This cannot be undone.',
        cta: 'Delete app',
        confirmTitle: 'Delete this app?',
        confirmBody: 'Type the app name to confirm.',
      },
    },
  },

  billing: {
    title: 'Billing',
    subtitle: 'Plans, invoices, payment methods.',
    sections: {
      plan: 'Plan',
      invoices: 'Invoices',
      paymentMethod: 'Payment method',
    },
  },

  usage: {
    title: 'Usage',
    subtitle: 'Requests, tokens, and rate limits across your apps.',
  },

  models: {
    title: 'Models',
    subtitle: 'Available AI models and their capabilities.',
  },

  playground: {
    title: 'Playground',
    subtitle: 'Test prompts against any model.',
    send: 'Send',
    clear: 'Clear conversation',
  },

  documentation: {
    title: 'Documentation',
    quickstart: 'Quickstart',
    authentication: 'Authentication',
    chatCompletions: 'Chat completions',
    sdks: 'SDKs',
    models: 'Models',
  },

  settings: {
    title: 'Account settings',
    account: {
      title: 'Account',
      nameLabel: 'Account name',
    },
    language: {
      title: 'Language',
      subtitle: 'Choose your preferred display language.',
    },
  },

  examples: {
    title: 'Examples',
  },

  account: {
    signedInAs: 'Signed in as {{name}}',
    signOut: 'Sign out',
  },
};

export default en;
