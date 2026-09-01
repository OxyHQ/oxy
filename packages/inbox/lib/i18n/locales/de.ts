import type { LocaleDict } from '../types';

/**
 * German (de-DE) translation dictionary for the Inbox app.
 *
 * Tone: informal "Du" — matches the rest of the Oxy ecosystem.
 * Punctuation and capitalization mirror the source EN strings.
 */
const de: LocaleDict = {
  common: {
    cancel: 'Abbrechen',
    save: 'Speichern',
    ok: 'OK',
    continue: 'Weiter',
    back: 'Zurück',
    next: 'Weiter',
    done: 'Fertig',
    close: 'Schließen',
    loading: 'Lädt…',
    error: 'Fehler',
    success: 'Fertig',
    retry: 'Erneut versuchen',
    delete: 'Löschen',
    edit: 'Bearbeiten',
    remove: 'Entfernen',
    confirm: 'Bestätigen',
    submit: 'Absenden',
    search: 'Suchen',
    yes: 'Ja',
    no: 'Nein',
    or: 'oder',
    and: 'und',
    open: 'Öffnen',
    discard: 'Verwerfen',
    of: 'von',
    more: 'Mehr',
    less: 'Weniger',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox von Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Posteingang',
    search: 'Suchen',
    settings: 'Einstellungen',
  },

  drawer: {
    starred: 'Markiert',
    snoozed: 'Erinnerung später',
    subscriptions: 'Abonnements',
    labels: 'Labels',
    more: 'Mehr',
    less: 'Weniger',
    notSignedIn: 'Nicht angemeldet',
    accountSwitcher: 'Kontoauswahl',
    addAnotherAccount: 'Weiteres Konto hinzufügen',
    signOut: 'Abmelden',
    switchAccount: 'Konto wechseln, angemeldet als {{name}}',
    switchingAccount: 'Konto wird gewechselt…',
    expandSidebar: 'Seitenleiste ausklappen',
    collapseSidebar: 'Seitenleiste einklappen',
    signedOut: {
      title: 'Melde dich an, um deine E-Mails zu verwalten',
      subtitle: 'Greife auf deine Postfächer und Labels zu und verfasse neue Nachrichten.',
    },
    mailboxes: {
      Inbox: 'Posteingang',
      Sent: 'Gesendet',
      Drafts: 'Entwürfe',
      Trash: 'Papierkorb',
      Spam: 'Spam',
      Archive: 'Archiv',
      Starred: 'Markiert',
      Snoozed: 'Erinnerung später',
    },
    mailboxA11y: '{{name}}, {{count}} ungelesen',
  },

  home: {
    greeting: {
      morning: 'Guten Morgen',
      afternoon: 'Guten Tag',
      evening: 'Guten Abend',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: 'Tagesüberblick',
    openMenu: 'Menü öffnen',
    jumpToToday: 'Zu heute springen',
    previousWeek: 'Vorherige Woche',
    nextWeek: 'Nächste Woche',
    regenerateBrief: 'Überblick neu erstellen',
    inboxSection: 'Posteingang',
    needsResponse: 'Antwort erforderlich',
    followUp: 'Nachfassen',
    needsResponseA11y_one: 'Antwort erforderlich, {{count}} E-Mail',
    needsResponseA11y_other: 'Antwort erforderlich, {{count}} E-Mails',
    followUpA11y_one: 'Nachfassen, {{count}} E-Mail',
    followUpA11y_other: 'Nachfassen, {{count}} E-Mails',
    days: {
      sun: 'SO',
      mon: 'MO',
      tue: 'DI',
      wed: 'MI',
      thu: 'DO',
      fri: 'FR',
      sat: 'SA',
    },
    stats: {
      unread: '{{count}} ungelesen',
      starred: '{{count}} markiert',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia analysiert deinen Posteingang…',
      unavailable: 'Überblick kann gerade nicht erstellt werden.',
      empty: 'Noch keine E-Mails zum Zusammenfassen.',
    },
    feedEmpty: {
      title: 'Alles erledigt',
      subtitle: 'Nichts Neues im Posteingang.',
    },
    signedOut: {
      subtitle:
        'Melde dich an, um deinen Tagesüberblick, E-Mails mit Antwortbedarf und ausstehende Nachfragen zu sehen.',
    },
  },


  inbox: {
    title: 'Posteingang',
    starredTitle: 'Markiert',
    searchInMailbox: 'In {{mailbox}} suchen',
    emptyTitle: 'Hier ist nichts',
    emptyAllCaught: 'Du bist auf dem aktuellen Stand.',
    emptySignIn: 'Melde dich an, um auf deine E-Mails zuzugreifen.',
    pagination: '{{from}}–{{to}} von {{total}}',
    remind: 'Erinnern',
    bundled: 'Gebündelt',
    flat: 'Liste',
    composeFab: 'Neue E-Mail verfassen',
    composeFabLabel: 'Verfassen',
    askAlia: 'Alia fragen',
    askAliaHint: 'Öffnet den KI-Assistenten Alia, um Fragen zum Posteingang zu stellen',
    sections: {
      reminders: 'Erinnerungen',
      pinned: 'Angeheftet',
      today: 'Heute',
      yesterday: 'Gestern',
      thisWeek: 'Diese Woche',
      thisMonth: 'Dieser Monat',
      earlier: 'Älter',
    },
    aliaSuggestions: {
      unread: {
        label: 'Ungelesene E-Mails',
        prompt: 'Welche E-Mails brauchen meine Aufmerksamkeit?',
      },
      todaysSummary: {
        label: 'Zusammenfassung von heute',
        prompt: 'Fasse meine heutigen E-Mails zusammen',
      },
      withAttachments: {
        label: 'Mit Anhängen',
        prompt: 'Suche E-Mails mit Anhängen',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'Archiv-Ordner nicht verfügbar.',
      trashUnavailable: 'Papierkorb-Ordner nicht verfügbar.',
      offlineSync_one: '{{count}} Offline-Aktion synchronisiert.',
      offlineSync_other: '{{count}} Offline-Aktionen synchronisiert.',
      newVersionAvailable: 'Neue Version verfügbar — neu laden zum Aktualisieren.',
      newEmail: 'Neue E-Mail von {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(kein Betreff)',
      emptyMessage: '(leere Nachricht)',
      messagesInConversation_one: '{{count}} Nachricht in dieser Konversation',
      messagesInConversation_other: '{{count}} Nachrichten in dieser Konversation',
      toRecipients: 'an {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Archivieren',
      delete: 'Löschen',
      markUnread: 'Als ungelesen markieren',
      markRead: 'Als gelesen markieren',
      reply: 'Antworten',
      replyAll: 'Allen antworten',
      forward: 'Weiterleiten',
      pin: 'Nachricht anheften',
      unpin: 'Anheften aufheben',
      star: 'Nachricht markieren',
      unstar: 'Markierung entfernen',
      snooze: 'Erinnern',
      print: 'Drucken',
      more: 'Mehr Aktionen',
      moreInline: 'Mehr',
      reportSpam: 'Spam melden',
      label: 'Label',
      downloadEml: '.eml herunterladen',
      messageActions: 'Nachrichten-Aktionen',
    },
    labelPicker: {
      title: 'Labels',
      empty: 'Noch keine Labels',
    },
    toast: {
      attachmentFailed: 'Anhang konnte nicht heruntergeladen werden.',
      fileSystemUnavailable: 'Dateisystem auf diesem Gerät nicht verfügbar.',
      sharingUnavailable: 'Teilen auf diesem Gerät nicht verfügbar.',
      printFailed: 'Drucken fehlgeschlagen.',
      downloadFailed: 'Herunterladen fehlgeschlagen.',
      saveEmailDialog: 'E-Mail speichern',
    },
  },

  empty: {
    selectConversation: 'Konversation auswählen',
    nothingHere: 'Hier ist nichts',
  },

  notFound: {
    title:
      'Diese Konversation wurde nicht gefunden. Möglicherweise wurde sie verschoben, archiviert oder gelöscht.',
    back: 'Zurück zum Posteingang',
  },

  search: {
    placeholder: 'E-Mails durchsuchen',
    clear: 'Suche löschen',
    openMenu: 'Menü öffnen',
    goBack: 'Zurück',
    filters: {
      from: 'Von',
      fromValue: 'Von: {{value}}',
      hasAttachment: 'Mit Anhang',
    },
    nl: {
      understanding: 'Suche wird verstanden…',
      searching: 'Suche: {{filters}}',
      allEmails: 'alle E-Mails',
      fromValue: 'von {{value}}',
      toValue: 'an {{value}}',
      subjectContains: 'Betreff enthält "{{value}}"',
      withAttachments: 'mit Anhängen',
      starred: 'markiert',
      unread: 'ungelesen',
      read: 'gelesen',
    },
    empty: {
      noResults: 'Keine Ergebnisse gefunden',
      idle: 'Durchsuche deine E-Mails',
    },
    results_one: '{{count}} Ergebnis',
    results_other: '{{count}} Ergebnisse',
  },

  compose: {
    titleCompose: 'Verfassen',
    titleReply: 'Antworten',
    titleForward: 'Weiterleiten',
    headTitleCompose: 'Verfassen · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Verfassen · Oxy',
    placeholders: {
      to: 'Empfänger',
      subject: 'Betreff',
      body: 'E-Mail verfassen',
    },
    fields: {
      from: 'Von',
      to: 'An',
      cc: 'Cc',
      bcc: 'Bcc',
    },
    actions: {
      send: 'Senden',
      sendNow: 'Jetzt senden',
      moreSendOptions: 'Weitere Sendeoptionen',
      sendOptions: 'Sendeoptionen',
      scheduleSend: 'Senden planen',
      saveDraft: 'Entwurf speichern',
      discard: 'Verwerfen',
    },
    saveDraftPrompt: {
      title: 'Entwurf speichern?',
      description: 'Möchtest du diese Nachricht als Entwurf speichern?',
    },
    dropZone: 'Dateien zum Anhängen hier ablegen',
    toast: {
      addRecipient: 'Bitte füge mindestens einen Empfänger hinzu.',
      invalidEmail: 'Bitte gib eine gültige E-Mail-Adresse ein.',
      sendFailed: 'E-Mail konnte nicht gesendet werden. Bitte erneut versuchen.',
      scheduleFailed: 'Senden konnte nicht geplant werden. Bitte erneut versuchen.',
      scheduled: 'E-Mail geplant für {{time}}',
      uploadFailed: 'Anhang konnte nicht hochgeladen werden.',
      signatureFailed: 'Signatur konnte nicht geladen werden.',
    },
  },

  inlineReply: {
    placeholder: 'Antwort verfassen…',
    forwardTo: 'Weiterleiten an:',
    replyAllTo: 'Allen antworten an:',
    replyTo: 'Antworten an:',
    cc: 'Cc:',
    bcc: 'Bcc:',
    ccBccToggle: 'Cc/Bcc',
    addRecipients: 'Empfänger hinzufügen',
    send: 'Senden',
    quotedPrefix: 'Am {{date}} schrieb {{author}}:',
    forwardHeader:
      '\n\n---------- Weitergeleitete Nachricht ----------\nVon: {{from}}\nDatum: {{date}}\nBetreff: {{subject}}\nAn: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Schnellantworten',
  },

  ai: {
    toolbar: {
      draft: 'Entwurf',
      polish: 'Verfeinern',
      shorter: 'Kürzer',
      longer: 'Länger',
      tone: 'Tonalität',
      suggestSubject: 'Betreff vorschlagen',
    },
    draftModal: {
      title: 'Mit KI verfassen',
      subtitle: 'Beschreibe, was du sagen möchtest, und Alia entwirft es für dich.',
      placeholder: 'z. B. Termin höflich absagen, stattdessen nächste Woche vorschlagen',
      toneLabel: 'Tonalität:',
      cancel: 'Abbrechen',
      draft: 'Entwurf',
    },
    toneMenu: {
      title: 'Tonalität ändern zu…',
    },
    tones: {
      professional: 'Professionell',
      casual: 'Locker',
      friendly: 'Freundlich',
      formal: 'Formell',
    },
  },

  threadSummary: {
    title: 'Konversations-Zusammenfassung',
    messages_one: '{{count}} Nachricht',
    messages_other: '{{count}} Nachrichten',
    keyPoints: 'Kernpunkte',
    actionItems: 'Aufgaben',
    due: 'Fällig: {{date}}',
  },

  staleThread: {
    consider: 'Überlege, eine kurze Antwort zu senden',
    reply: 'Antworten',
  },

  followUpReminder: {
    pastDue: 'Überfällige Zusage',
    upcoming: 'Anstehende Zusage',
    description: 'Du hast „{{text}}" zu {{recipient}} gesagt',
    deadline: {
      dueToday: 'Heute fällig',
      overdueOneDay: '1 Tag überfällig',
      overdueDays: '{{days}} Tage überfällig',
      dueTomorrow: 'Morgen fällig',
      dueInDays: 'Fällig in {{days}} Tagen',
    },
    fallbackName: 'jemand',
    view: 'Ansehen',
    done: 'Erledigt',
  },

  reminder: {
    create: {
      title: 'Erinnerung erstellen',
      placeholder: 'Woran möchtest du erinnert werden?',
      whenLabel: 'Wann?',
      submit: 'Erinnerung erstellen',
      presets: {
        laterToday: 'Später heute',
        tomorrowMorning: 'Morgen früh',
        thisWeekend: 'Dieses Wochenende',
        nextWeek: 'Nächste Woche',
      },
    },
    time: {
      overdue: 'Überfällig · {{date}}, {{time}}',
      today: 'Heute, {{time}}',
      tomorrow: 'Morgen, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Erinnern bis…',
    options: {
      laterToday: 'Später heute',
      tomorrow: 'Morgen',
      thisWeekend: 'Dieses Wochenende',
      nextWeek: 'Nächste Woche',
    },
    time: {
      today: 'Heute, {{time}}',
      tomorrow: 'Morgen, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: 'Senden planen',
    options: {
      laterToday: 'Später heute',
      tomorrowMorning: 'Morgen früh',
      tomorrowAfternoon: 'Morgen Nachmittag',
      mondayMorning: 'Montag früh',
    },
  },

  template: {
    insert: 'Vorlage einfügen',
  },

  selection: {
    archive: 'Archivieren',
    delete: 'Löschen',
    star: 'Markieren',
    markRead: 'Als gelesen markieren',
  },

  subscriptions: {
    title: 'Abonnements',
    subtitle:
      'Nach dem Abbestellen kann es ein paar Tage dauern, bis keine Nachrichten mehr ankommen',
    empty: {
      title: 'Keine Abonnements gefunden',
      subtitle: 'Absender, die dir häufig E-Mails schicken, erscheinen hier.',
    },
    unsubscribe: 'Abbestellen',
    block: 'Blockieren',
    frequency: {
      twentyPlus: '20+ kürzliche E-Mails',
      tenToTwenty: '10-20 kürzliche E-Mails',
      count_one: '{{count}} kürzliche E-Mail',
      count_other: '{{count}} kürzliche E-Mails',
    },
  },

  contacts: {
    searchPlaceholder: 'Kontakte durchsuchen…',
    addContact: 'Kontakt hinzufügen',
    cancel: 'Abbrechen',
    saveContact: 'Kontakt speichern',
    save: 'Speichern',
    edit: {
      cancel: 'Abbrechen',
    },
    delete: {
      title: 'Diesen Kontakt löschen?',
      description: 'Diese Aktion kann nicht rückgängig gemacht werden.',
      cta: 'Löschen',
    },
    starredFilter: 'Markiert',
    autoCollected: 'Automatisch erfasst',
    empty: {
      noMatch: 'Keine Kontakte entsprechen deiner Suche.',
      none: 'Noch keine Kontakte.',
    },
    toast: {
      nameEmailRequired: 'Name und E-Mail sind erforderlich.',
      created: 'Kontakt erstellt.',
      updated: 'Kontakt aktualisiert.',
      deleted: 'Kontakt gelöscht.',
    },
    form: {
      name: 'Name *',
      email: 'E-Mail *',
      company: 'Unternehmen',
      notes: 'Notizen',
    },
  },

  shortcuts: {
    title: 'Tastenkürzel',
    close: 'Schließen',
    actions: {
      compose: 'Verfassen',
      reply: 'Antworten',
      replyAll: 'Allen antworten',
      forward: 'Weiterleiten',
      archive: 'Archivieren',
      delete: 'Löschen',
      nextMessage: 'Nächste Nachricht',
      previousMessage: 'Vorherige Nachricht',
      starUnstar: 'Markieren / Markierung entfernen',
      markUnread: 'Als ungelesen markieren',
      search: 'Suchen',
      help: 'Diese Hilfe',
    },
  },

  cards: {
    purchase: {
      header: 'Einkauf',
      order: 'Bestellnr.',
      moreItems: '+{{count}} weitere',
      summary: 'Einkaufsdetails',
    },
    bill: {
      header: 'Rechnung',
      account: 'Konto',
      due: 'Fällig {{date}}',
      overdue: 'Überfällig · {{date}}',
      summary: 'Rechnungsdetails',
    },
    trip: {
      header: 'Reise',
      confirmation: 'Bestätigung',
      summary: 'Reisedetails',
    },
    package: {
      header: 'Paket',
      tracking: 'Sendungsverfolgung',
      estimated: 'Vsl. {{date}}',
      summary: 'Paketdetails',
    },
    event: {
      header: 'Termin',
      addToCalendar: 'Zum Kalender hinzufügen',
      googleCalendar: 'Google Kalender',
      addToCalendarDialog: 'Zum Kalender hinzufügen',
      defaultTitle: 'Termin',
      summary: 'Termindetails',
    },
  },

  importance: {
    urgent: 'Dringend',
    action: 'Aktion erforderlich',
    important: 'Wichtig',
    fyi: 'Zur Info',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Einstellungen · Inbox · Oxy',
    title: 'Einstellungen',
  },

  auth: {
    gate: {
      title: 'Melde dich an, um auf deinen Posteingang zuzugreifen',
      subtitle:
        'Verbinde deine Oxy-Identität, um Nachrichten, Labels und Einstellungen geräteübergreifend zu synchronisieren.',
      footer:
        'Mit der Anmeldung akzeptierst du unsere Nutzungsbedingungen und bestätigst unsere Datenschutzrichtlinie.',
    },
  },
};

export default de;
