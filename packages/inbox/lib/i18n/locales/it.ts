import type { LocaleDict } from '../types';

/**
 * Italian (it-IT) translation dictionary for the Inbox app.
 *
 * Tone: informal "tu" — matches the rest of the Oxy ecosystem.
 * Punctuation and capitalization mirror the source EN strings.
 */
const it: LocaleDict = {
  common: {
    cancel: 'Annulla',
    save: 'Salva',
    ok: 'OK',
    continue: 'Continua',
    back: 'Indietro',
    next: 'Avanti',
    done: 'Fatto',
    close: 'Chiudi',
    loading: 'Caricamento…',
    error: 'Errore',
    success: 'Fatto',
    retry: 'Riprova',
    delete: 'Elimina',
    edit: 'Modifica',
    remove: 'Rimuovi',
    confirm: 'Conferma',
    submit: 'Invia',
    search: 'Cerca',
    yes: 'Sì',
    no: 'No',
    or: 'o',
    and: 'e',
    open: 'Apri',
    discard: 'Scarta',
    of: 'di',
    more: 'Altro',
    less: 'Meno',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox di Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Posta',
    search: 'Cerca',
    settings: 'Impostazioni',
  },

  drawer: {
    starred: 'Speciali',
    snoozed: 'Posticipati',
    subscriptions: 'Iscrizioni',
    labels: 'Etichette',
    more: 'Altro',
    less: 'Meno',
    notSignedIn: 'Non autenticato',
    accountSwitcher: 'Selettore di account',
    addAnotherAccount: 'Aggiungi un altro account',
    signOut: 'Esci',
    switchAccount: 'Cambia account, autenticato come {{name}}',
    switchingAccount: 'Cambio account in corso…',
    expandSidebar: 'Espandi barra laterale',
    collapseSidebar: 'Comprimi barra laterale',
    signedOut: {
      title: 'Accedi per gestire la posta',
      subtitle: 'Accedi alle tue cassette, alle etichette e componi nuovi messaggi.',
    },
    mailboxes: {
      Inbox: 'Posta in arrivo',
      Sent: 'Inviata',
      Drafts: 'Bozze',
      Trash: 'Cestino',
      Spam: 'Spam',
      Archive: 'Archivio',
      Starred: 'Speciali',
      Snoozed: 'Posticipati',
    },
    mailboxA11y: '{{name}}, {{count}} non letti',
  },

  home: {
    greeting: {
      morning: 'Buongiorno',
      afternoon: 'Buon pomeriggio',
      evening: 'Buonasera',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: 'Riepilogo di oggi',
    openMenu: 'Apri menu',
    jumpToToday: 'Vai a oggi',
    previousWeek: 'Settimana precedente',
    nextWeek: 'Settimana successiva',
    regenerateBrief: 'Rigenera riepilogo',
    inboxSection: 'Posta',
    needsResponse: 'Richiede risposta',
    followUp: 'Da risollecitare',
    needsResponseA11y_one: 'Richiede risposta, {{count}} email',
    needsResponseA11y_other: 'Richiede risposta, {{count}} email',
    followUpA11y_one: 'Da risollecitare, {{count}} email',
    followUpA11y_other: 'Da risollecitare, {{count}} email',
    days: {
      sun: 'DOM',
      mon: 'LUN',
      tue: 'MAR',
      wed: 'MER',
      thu: 'GIO',
      fri: 'VEN',
      sat: 'SAB',
    },
    stats: {
      unread: '{{count}} non lette',
      starred: '{{count}} speciali',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia sta analizzando la posta…',
      unavailable: 'Impossibile generare il riepilogo in questo momento.',
      empty: 'Ancora nessuna email da riepilogare.',
    },
    feedEmpty: {
      title: 'Tutto in pari',
      subtitle: 'Niente di nuovo nella posta.',
    },
    signedOut: {
      subtitle:
        'Accedi per vedere il riepilogo quotidiano, le email che richiedono una risposta e i solleciti in sospeso.',
    },
  },


  inbox: {
    title: 'Posta',
    starredTitle: 'Speciali',
    searchInMailbox: 'Cerca in {{mailbox}}',
    emptyTitle: 'Non c\'è niente qui',
    emptyAllCaught: 'Sei in pari.',
    emptySignIn: 'Accedi per visualizzare la posta.',
    pagination: '{{from}}–{{to}} di {{total}}',
    remind: 'Ricorda',
    bundled: 'Raggruppate',
    flat: 'Elenco',
    composeFab: 'Scrivi una nuova email',
    composeFabLabel: 'Scrivi',
    askAlia: 'Chiedi ad Alia',
    askAliaHint: 'Apre l\'assistente AI Alia per porre domande sulla posta',
    sections: {
      reminders: 'Promemoria',
      pinned: 'Fissati',
      today: 'Oggi',
      yesterday: 'Ieri',
      thisWeek: 'Questa settimana',
      thisMonth: 'Questo mese',
      earlier: 'Precedenti',
    },
    aliaSuggestions: {
      unread: {
        label: 'Email non lette',
        prompt: 'Quali email richiedono la mia attenzione?',
      },
      todaysSummary: {
        label: 'Riepilogo di oggi',
        prompt: 'Riassumi le email di oggi',
      },
      withAttachments: {
        label: 'Con allegati',
        prompt: 'Trova email con allegati',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'Cartella Archivio non disponibile.',
      trashUnavailable: 'Cartella Cestino non disponibile.',
      offlineSync_one: 'Sincronizzata {{count}} azione offline.',
      offlineSync_other: 'Sincronizzate {{count}} azioni offline.',
      newVersionAvailable: 'Nuova versione disponibile — aggiorna per applicarla.',
      newEmail: 'Nuova email da {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(senza oggetto)',
      emptyMessage: '(messaggio vuoto)',
      messagesInConversation_one: '{{count}} messaggio in questa conversazione',
      messagesInConversation_other: '{{count}} messaggi in questa conversazione',
      toRecipients: 'a {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Archivia',
      delete: 'Elimina',
      markUnread: 'Segna come non letto',
      markRead: 'Segna come letto',
      reply: 'Rispondi',
      replyAll: 'Rispondi a tutti',
      forward: 'Inoltra',
      pin: 'Fissa il messaggio',
      unpin: 'Sblocca il messaggio',
      star: 'Segna come speciale',
      unstar: 'Rimuovi speciale',
      snooze: 'Posticipa',
      print: 'Stampa',
      more: 'Altre azioni',
      moreInline: 'Altro',
      reportSpam: 'Segnala come spam',
      label: 'Etichetta',
      downloadEml: 'Scarica .eml',
      messageActions: 'Azioni del messaggio',
    },
    labelPicker: {
      title: 'Etichette',
      empty: 'Ancora nessuna etichetta',
    },
    toast: {
      attachmentFailed: 'Impossibile scaricare l\'allegato.',
      fileSystemUnavailable: 'File system non disponibile su questo dispositivo.',
      sharingUnavailable: 'Condivisione non disponibile su questo dispositivo.',
      printFailed: 'Impossibile stampare l\'email.',
      downloadFailed: 'Impossibile scaricare l\'email.',
      saveEmailDialog: 'Salva email',
    },
  },

  empty: {
    selectConversation: 'Seleziona una conversazione',
    nothingHere: 'Non c\'è niente qui',
  },

  notFound: {
    title:
      'Conversazione non trovata. Potrebbe essere stata spostata, archiviata o eliminata.',
    back: 'Torna alla posta',
  },

  search: {
    placeholder: 'Cerca nella posta',
    clear: 'Cancella ricerca',
    openMenu: 'Apri menu',
    goBack: 'Indietro',
    filters: {
      from: 'Da',
      fromValue: 'Da: {{value}}',
      hasAttachment: 'Con allegato',
    },
    nl: {
      understanding: 'Interpretazione della ricerca…',
      searching: 'Ricerca: {{filters}}',
      allEmails: 'tutte le email',
      fromValue: 'da {{value}}',
      toValue: 'a {{value}}',
      subjectContains: 'oggetto contiene "{{value}}"',
      withAttachments: 'con allegati',
      starred: 'speciali',
      unread: 'non lette',
      read: 'lette',
    },
    empty: {
      noResults: 'Nessun risultato',
      idle: 'Cerca nelle tue email',
    },
    results_one: '{{count}} risultato',
    results_other: '{{count}} risultati',
  },

  compose: {
    titleCompose: 'Scrivi',
    titleReply: 'Rispondi',
    titleForward: 'Inoltra',
    headTitleCompose: 'Scrivi · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Scrivi · Oxy',
    placeholders: {
      to: 'Destinatari',
      subject: 'Oggetto',
      body: 'Scrivi email',
    },
    fields: {
      from: 'Da',
      to: 'A',
      cc: 'Cc',
      bcc: 'Ccn',
    },
    actions: {
      send: 'Invia',
      sendNow: 'Invia ora',
      moreSendOptions: 'Altre opzioni di invio',
      sendOptions: 'Opzioni di invio',
      scheduleSend: 'Programma invio',
      saveDraft: 'Salva bozza',
      discard: 'Scarta',
    },
    saveDraftPrompt: {
      title: 'Salvare la bozza?',
      description: 'Vuoi salvare questo messaggio come bozza?',
    },
    dropZone: 'Trascina qui i file da allegare',
    toast: {
      addRecipient: 'Aggiungi almeno un destinatario.',
      invalidEmail: 'Inserisci un indirizzo email valido.',
      sendFailed: 'Impossibile inviare l\'email. Riprova.',
      scheduleFailed: 'Impossibile programmare l\'invio. Riprova.',
      scheduled: 'Email programmata per il {{time}}',
      uploadFailed: 'Impossibile caricare l\'allegato.',
      signatureFailed: 'Impossibile caricare la firma.',
    },
  },

  inlineReply: {
    placeholder: 'Scrivi la tua risposta…',
    forwardTo: 'Inoltra a:',
    replyAllTo: 'Rispondi a tutti a:',
    replyTo: 'Rispondi a:',
    cc: 'Cc:',
    bcc: 'Ccn:',
    ccBccToggle: 'Cc/Ccn',
    addRecipients: 'Aggiungi destinatari',
    send: 'Invia',
    quotedPrefix: 'Il {{date}}, {{author}} ha scritto:',
    forwardHeader:
      '\n\n---------- Messaggio inoltrato ----------\nDa: {{from}}\nData: {{date}}\nOggetto: {{subject}}\nA: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Risposte rapide',
  },

  ai: {
    toolbar: {
      draft: 'Bozza',
      polish: 'Rifinisci',
      shorter: 'Più breve',
      longer: 'Più lungo',
      tone: 'Tono',
      suggestSubject: 'Suggerisci oggetto',
    },
    draftModal: {
      title: 'Scrivi con AI',
      subtitle: 'Descrivi cosa vuoi dire e Alia lo redigerà per te.',
      placeholder: 'es. Rifiuta cortesemente la riunione e proponi la prossima settimana',
      toneLabel: 'Tono:',
      cancel: 'Annulla',
      draft: 'Bozza',
    },
    toneMenu: {
      title: 'Cambia tono in…',
    },
    tones: {
      professional: 'Professionale',
      casual: 'Informale',
      friendly: 'Amichevole',
      formal: 'Formale',
    },
  },

  threadSummary: {
    title: 'Riepilogo conversazione',
    messages_one: '{{count}} messaggio',
    messages_other: '{{count}} messaggi',
    keyPoints: 'Punti chiave',
    actionItems: 'Azioni da fare',
    due: 'Scadenza: {{date}}',
  },

  staleThread: {
    consider: 'Valuta una risposta rapida',
    reply: 'Rispondi',
  },

  followUpReminder: {
    pastDue: 'Impegno scaduto',
    upcoming: 'Impegno in arrivo',
    description: 'Hai detto "{{text}}" a {{recipient}}',
    deadline: {
      dueToday: 'Scade oggi',
      overdueOneDay: 'In ritardo di 1 giorno',
      overdueDays: 'In ritardo di {{days}} giorni',
      dueTomorrow: 'Scade domani',
      dueInDays: 'Scade tra {{days}} giorni',
    },
    fallbackName: 'qualcuno',
    view: 'Mostra',
    done: 'Fatto',
  },

  reminder: {
    create: {
      title: 'Crea promemoria',
      placeholder: 'Di cosa vuoi essere ricordato?',
      whenLabel: 'Quando?',
      submit: 'Crea promemoria',
      presets: {
        laterToday: 'Più tardi oggi',
        tomorrowMorning: 'Domani mattina',
        thisWeekend: 'Questo fine settimana',
        nextWeek: 'La prossima settimana',
      },
    },
    time: {
      overdue: 'Scaduto · {{date}}, {{time}}',
      today: 'Oggi, {{time}}',
      tomorrow: 'Domani, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Posticipa fino a…',
    options: {
      laterToday: 'Più tardi oggi',
      tomorrow: 'Domani',
      thisWeekend: 'Questo fine settimana',
      nextWeek: 'La prossima settimana',
    },
    time: {
      today: 'Oggi, {{time}}',
      tomorrow: 'Domani, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: 'Programma invio',
    options: {
      laterToday: 'Più tardi oggi',
      tomorrowMorning: 'Domani mattina',
      tomorrowAfternoon: 'Domani pomeriggio',
      mondayMorning: 'Lunedì mattina',
    },
  },

  template: {
    insert: 'Inserisci modello',
  },

  selection: {
    archive: 'Archivia',
    delete: 'Elimina',
    star: 'Segna come speciale',
    markRead: 'Segna come letto',
  },

  subscriptions: {
    title: 'Iscrizioni',
    subtitle:
      'Quando ti disiscrivi, potrebbero volerci alcuni giorni prima di smettere di ricevere messaggi',
    empty: {
      title: 'Nessuna iscrizione trovata',
      subtitle: 'Qui appariranno i mittenti che ti scrivono spesso.',
    },
    unsubscribe: 'Disiscriviti',
    block: 'Blocca',
    frequency: {
      twentyPlus: 'Oltre 20 email recenti',
      tenToTwenty: '10-20 email recenti',
      count_one: '{{count}} email recente',
      count_other: '{{count}} email recenti',
    },
  },

  contacts: {
    searchPlaceholder: 'Cerca contatti…',
    addContact: 'Aggiungi contatto',
    cancel: 'Annulla',
    saveContact: 'Salva contatto',
    save: 'Salva',
    edit: {
      cancel: 'Annulla',
    },
    delete: {
      title: 'Eliminare questo contatto?',
      description: 'Questa azione non può essere annullata.',
      cta: 'Elimina',
    },
    starredFilter: 'Speciali',
    autoCollected: 'Raccolto automaticamente',
    empty: {
      noMatch: 'Nessun contatto corrisponde alla ricerca.',
      none: 'Ancora nessun contatto.',
    },
    toast: {
      nameEmailRequired: 'Nome ed email sono obbligatori.',
      created: 'Contatto creato.',
      updated: 'Contatto aggiornato.',
      deleted: 'Contatto eliminato.',
    },
    form: {
      name: 'Nome *',
      email: 'Email *',
      company: 'Azienda',
      notes: 'Note',
    },
  },

  shortcuts: {
    title: 'Scorciatoie da tastiera',
    close: 'Chiudi',
    actions: {
      compose: 'Scrivi',
      reply: 'Rispondi',
      replyAll: 'Rispondi a tutti',
      forward: 'Inoltra',
      archive: 'Archivia',
      delete: 'Elimina',
      nextMessage: 'Messaggio successivo',
      previousMessage: 'Messaggio precedente',
      starUnstar: 'Speciale / rimuovi speciale',
      markUnread: 'Segna come non letto',
      search: 'Cerca',
      help: 'Questa guida',
    },
  },

  cards: {
    purchase: {
      header: 'Acquisto',
      order: 'Ordine n.',
      moreItems: '+{{count}} altri',
      summary: 'Dettagli acquisto',
    },
    bill: {
      header: 'Fattura',
      account: 'Conto',
      due: 'Scade il {{date}}',
      overdue: 'Scaduta · {{date}}',
      summary: 'Dettagli fattura',
    },
    trip: {
      header: 'Viaggio',
      confirmation: 'Conferma',
      summary: 'Dettagli viaggio',
    },
    package: {
      header: 'Pacco',
      tracking: 'Tracciamento',
      estimated: 'Stimato {{date}}',
      summary: 'Dettagli pacco',
    },
    event: {
      header: 'Evento',
      addToCalendar: 'Aggiungi al calendario',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'Aggiungi al calendario',
      defaultTitle: 'Evento',
      summary: 'Dettagli evento',
    },
  },

  importance: {
    urgent: 'Urgente',
    action: 'Azione richiesta',
    important: 'Importante',
    fyi: 'Per tua informazione',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Impostazioni · Inbox · Oxy',
    title: 'Impostazioni',
  },

  auth: {
    gate: {
      title: 'Accedi per usare la tua posta',
      subtitle:
        'Connetti la tua identità Oxy per sincronizzare messaggi, etichette e preferenze su tutti i dispositivi.',
      footer:
        'Accedendo accetti i nostri Termini e riconosci la nostra Privacy Policy.',
    },
  },
};

export default it;
