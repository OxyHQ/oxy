import type { LocaleDict } from '../types';

/**
 * Catalan (ca-ES) translation dictionary for the Inbox app.
 *
 * Tone: informal "tu" — matches the rest of the Oxy ecosystem.
 * Punctuation and capitalization mirror the source EN strings.
 */
const ca: LocaleDict = {
  common: {
    cancel: 'Cancel·la',
    save: 'Desa',
    ok: "D'acord",
    continue: 'Continua',
    back: 'Enrere',
    next: 'Següent',
    done: 'Fet',
    close: 'Tanca',
    loading: 'Carregant…',
    error: 'Error',
    success: 'Fet',
    retry: 'Torna-ho a provar',
    delete: 'Elimina',
    edit: 'Edita',
    remove: 'Treu',
    confirm: 'Confirma',
    submit: 'Envia',
    search: 'Cerca',
    yes: 'Sí',
    no: 'No',
    or: 'o',
    and: 'i',
    open: 'Obre',
    discard: 'Descarta',
    of: 'de',
    more: 'Més',
    less: 'Menys',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox per Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Safata',
    search: 'Cerca',
    settings: 'Configuració',
  },

  drawer: {
    starred: 'Destacats',
    snoozed: 'Posposats',
    subscriptions: 'Subscripcions',
    labels: 'Etiquetes',
    more: 'Més',
    less: 'Menys',
    notSignedIn: "Sessió no iniciada",
    accountSwitcher: 'Selector de compte',
    addAnotherAccount: 'Afegeix un altre compte',
    signOut: 'Tanca la sessió',
    switchAccount: 'Canvia de compte, sessió iniciada com a {{name}}',
    switchingAccount: 'Canviant de compte…',
    expandSidebar: 'Expandeix la barra lateral',
    collapseSidebar: 'Contrau la barra lateral',
    signedOut: {
      title: 'Inicia la sessió per gestionar el correu',
      subtitle:
        'Accedeix a les bústies, etiquetes i redacta missatges nous.',
    },
    mailboxes: {
      Inbox: "Safata d'entrada",
      Sent: 'Enviats',
      Drafts: 'Esborranys',
      Trash: 'Paperera',
      Spam: 'Brossa',
      Archive: 'Arxiu',
      Starred: 'Destacats',
      Snoozed: 'Posposats',
    },
    mailboxA11y: '{{name}}, {{count}} sense llegir',
  },

  home: {
    greeting: {
      morning: 'Bon dia',
      afternoon: 'Bona tarda',
      evening: 'Bona nit',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: "Resum d'avui",
    openMenu: 'Obre el menú',
    jumpToToday: 'Ves a avui',
    previousWeek: 'Setmana anterior',
    nextWeek: 'Setmana següent',
    regenerateBrief: 'Torna a generar el resum',
    inboxSection: 'Safata',
    needsResponse: 'Necessita resposta',
    followUp: 'Pendent de seguiment',
    needsResponseA11y_one: 'Necessita resposta, {{count}} correu',
    needsResponseA11y_other: 'Necessita resposta, {{count}} correus',
    followUpA11y_one: 'Pendent de seguiment, {{count}} correu',
    followUpA11y_other: 'Pendent de seguiment, {{count}} correus',
    days: {
      sun: 'DG',
      mon: 'DL',
      tue: 'DT',
      wed: 'DC',
      thu: 'DJ',
      fri: 'DV',
      sat: 'DS',
    },
    stats: {
      unread: '{{count}} sense llegir',
      starred: '{{count}} destacats',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: "L'Alia està analitzant la safata…",
      unavailable: "No s'ha pogut generar el resum ara mateix.",
      empty: 'Encara no hi ha correus per resumir.',
    },
    feedEmpty: {
      title: 'Tot al dia',
      subtitle: 'No hi ha res nou a la safata.',
    },
    signedOut: {
      subtitle:
        'Inicia la sessió per veure el resum diari, els correus que necessiten resposta i els seguiments pendents.',
    },
  },


  inbox: {
    title: 'Safata',
    starredTitle: 'Destacats',
    searchInMailbox: 'Cerca a {{mailbox}}',
    emptyTitle: 'No hi ha res aquí',
    emptyAllCaught: 'Estàs al dia.',
    emptySignIn: 'Inicia la sessió per accedir al correu.',
    pagination: '{{from}}–{{to}} de {{total}}',
    remind: 'Recorda',
    bundled: 'Agrupats',
    flat: 'Llista',
    composeFab: 'Redacta un correu nou',
    composeFabLabel: 'Redacta',
    askAlia: "Pregunta a l'Alia",
    askAliaHint:
      "Obre l'assistent d'IA Alia per fer preguntes sobre la safata",
    sections: {
      reminders: 'Recordatoris',
      pinned: 'Fixats',
      today: 'Avui',
      yesterday: 'Ahir',
      thisWeek: 'Aquesta setmana',
      thisMonth: 'Aquest mes',
      earlier: 'Anteriors',
    },
    aliaSuggestions: {
      unread: {
        label: 'Correus sense llegir',
        prompt: 'Quins correus necessiten la meva atenció?',
      },
      todaysSummary: {
        label: "Resum d'avui",
        prompt: "Resumeix els correus d'avui",
      },
      withAttachments: {
        label: 'Amb adjunts',
        prompt: 'Cerca correus amb adjunts',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'La carpeta Arxiu no està disponible.',
      trashUnavailable: 'La carpeta Paperera no està disponible.',
      offlineSync_one: "S'ha sincronitzat {{count}} acció sense connexió.",
      offlineSync_other: "S'han sincronitzat {{count}} accions sense connexió.",
      newVersionAvailable: 'Hi ha una versió nova — recarrega per actualitzar.',
      newEmail: 'Nou correu de {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(sense assumpte)',
      emptyMessage: '(missatge buit)',
      messagesInConversation_one: '{{count}} missatge en aquesta conversa',
      messagesInConversation_other: '{{count}} missatges en aquesta conversa',
      toRecipients: 'a {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Arxiva',
      delete: 'Elimina',
      markUnread: 'Marca com a no llegit',
      markRead: 'Marca com a llegit',
      reply: 'Respon',
      replyAll: 'Respon a tots',
      forward: 'Reenvia',
      pin: 'Fixa el missatge',
      unpin: 'Desfixa el missatge',
      star: 'Destaca el missatge',
      unstar: 'Treu el destacat',
      snooze: 'Posposa',
      print: 'Imprimeix',
      more: 'Més accions',
      moreInline: 'Més',
      reportSpam: 'Marca com a brossa',
      label: 'Etiqueta',
      downloadEml: 'Baixa .eml',
      messageActions: 'Accions del missatge',
    },
    labelPicker: {
      title: 'Etiquetes',
      empty: 'Encara no hi ha etiquetes',
    },
    toast: {
      attachmentFailed: "No s'ha pogut baixar l'adjunt.",
      fileSystemUnavailable:
        "El sistema d'arxius no està disponible en aquest dispositiu.",
      sharingUnavailable: 'Compartir no està disponible en aquest dispositiu.',
      printFailed: "No s'ha pogut imprimir el correu.",
      downloadFailed: "No s'ha pogut baixar el correu.",
      saveEmailDialog: 'Desa el correu',
    },
  },

  empty: {
    selectConversation: 'Selecciona una conversa',
    nothingHere: 'No hi ha res aquí',
  },

  notFound: {
    title:
      "No s'ha trobat aquesta conversa. Pot ser que s'hagi mogut, arxivat o eliminat.",
    back: 'Torna a la safata',
  },

  search: {
    placeholder: 'Cerca al correu',
    clear: 'Neteja la cerca',
    openMenu: 'Obre el menú',
    goBack: 'Enrere',
    filters: {
      from: 'De',
      fromValue: 'De: {{value}}',
      hasAttachment: 'Amb adjunt',
    },
    nl: {
      understanding: 'Entenent la cerca…',
      searching: 'Cercant: {{filters}}',
      allEmails: 'tots els correus',
      fromValue: 'de {{value}}',
      toValue: 'per a {{value}}',
      subjectContains: "l'assumpte conté \"{{value}}\"",
      withAttachments: 'amb adjunts',
      starred: 'destacats',
      unread: 'sense llegir',
      read: 'llegits',
    },
    empty: {
      noResults: "No s'han trobat resultats",
      idle: 'Cerca als teus correus',
    },
    results_one: '{{count}} resultat',
    results_other: '{{count}} resultats',
  },

  compose: {
    titleCompose: 'Redacta',
    titleReply: 'Respon',
    titleForward: 'Reenvia',
    headTitleCompose: 'Redacta · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Redacta · Oxy',
    placeholders: {
      to: 'Destinataris',
      subject: 'Assumpte',
      body: 'Redacta el correu',
    },
    fields: {
      from: 'De',
      to: 'Per a',
      cc: 'Cc',
      bcc: 'Cco',
    },
    actions: {
      send: 'Envia',
      sendNow: 'Envia ara',
      moreSendOptions: "Més opcions d'enviament",
      sendOptions: "Opcions d'enviament",
      scheduleSend: "Programa l'enviament",
      saveDraft: "Desa l'esborrany",
      discard: 'Descarta',
    },
    saveDraftPrompt: {
      title: "Desar l'esborrany?",
      description: 'Vols desar aquest missatge com a esborrany?',
    },
    dropZone: 'Deixa anar els fitxers per adjuntar-los',
    toast: {
      addRecipient: 'Afegeix com a mínim un destinatari.',
      invalidEmail: 'Introdueix una adreça de correu vàlida.',
      sendFailed: "No s'ha pogut enviar el correu. Torna-ho a provar.",
      scheduleFailed: "No s'ha pogut programar l'enviament. Torna-ho a provar.",
      scheduled: 'Correu programat per al {{time}}',
      uploadFailed: "No s'ha pogut pujar l'adjunt.",
      signatureFailed: "No s'ha pogut carregar la signatura.",
    },
  },

  inlineReply: {
    placeholder: 'Escriu la teva resposta…',
    forwardTo: 'Reenvia a:',
    replyAllTo: 'Respon a tots a:',
    replyTo: 'Respon a:',
    cc: 'Cc:',
    bcc: 'Cco:',
    ccBccToggle: 'Cc/Cco',
    addRecipients: 'Afegeix destinataris',
    send: 'Envia',
    quotedPrefix: 'El {{date}}, {{author}} va escriure:',
    forwardHeader:
      '\n\n---------- Missatge reenviat ----------\nDe: {{from}}\nData: {{date}}\nAssumpte: {{subject}}\nPer a: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Respostes ràpides',
  },

  ai: {
    toolbar: {
      draft: 'Redacta',
      polish: 'Polir',
      shorter: 'Més curt',
      longer: 'Més llarg',
      tone: 'To',
      suggestSubject: 'Suggereix un assumpte',
    },
    draftModal: {
      title: 'Redacta amb IA',
      subtitle: "Descriu què vols dir i l'Alia ho redactarà per a tu.",
      placeholder:
        'p. ex., Rebutja la reunió educadament i suggereix la setmana vinent',
      toneLabel: 'To:',
      cancel: 'Cancel·la',
      draft: 'Redacta',
    },
    toneMenu: {
      title: 'Canvia el to a…',
    },
    tones: {
      professional: 'Professional',
      casual: 'Informal',
      friendly: 'Proper',
      formal: 'Formal',
    },
  },

  threadSummary: {
    title: 'Resum de la conversa',
    messages_one: '{{count}} missatge',
    messages_other: '{{count}} missatges',
    keyPoints: 'Punts clau',
    actionItems: 'Accions pendents',
    due: 'Per a: {{date}}',
  },

  staleThread: {
    consider: 'Considera enviar una resposta ràpida',
    reply: 'Respon',
  },

  followUpReminder: {
    pastDue: 'Compromís vençut',
    upcoming: 'Compromís proper',
    description: 'Vas dir «{{text}}» a {{recipient}}',
    deadline: {
      dueToday: 'Venç avui',
      overdueOneDay: 'Vençut fa 1 dia',
      overdueDays: 'Vençut fa {{days}} dies',
      dueTomorrow: 'Venç demà',
      dueInDays: "Venç d'aquí a {{days}} dies",
    },
    fallbackName: 'algú',
    view: 'Mostra',
    done: 'Fet',
  },

  reminder: {
    create: {
      title: 'Crea un recordatori',
      placeholder: 'De què vols que et recordi?',
      whenLabel: 'Quan?',
      submit: 'Crea el recordatori',
      presets: {
        laterToday: 'Més tard avui',
        tomorrowMorning: 'Demà al matí',
        thisWeekend: 'Aquest cap de setmana',
        nextWeek: 'La setmana vinent',
      },
    },
    time: {
      overdue: 'Vençut · {{date}}, {{time}}',
      today: 'Avui, {{time}}',
      tomorrow: 'Demà, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Posposa fins a…',
    options: {
      laterToday: 'Més tard avui',
      tomorrow: 'Demà',
      thisWeekend: 'Aquest cap de setmana',
      nextWeek: 'La setmana vinent',
    },
    time: {
      today: 'Avui, {{time}}',
      tomorrow: 'Demà, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: "Programa l'enviament",
    options: {
      laterToday: 'Més tard avui',
      tomorrowMorning: 'Demà al matí',
      tomorrowAfternoon: 'Demà a la tarda',
      mondayMorning: 'Dilluns al matí',
    },
  },

  template: {
    insert: 'Insereix una plantilla',
  },

  selection: {
    archive: 'Arxiva',
    delete: 'Elimina',
    star: 'Destaca',
    markRead: 'Marca com a llegit',
  },

  subscriptions: {
    title: 'Subscripcions',
    subtitle:
      'Quan et dones de baixa, pot trigar uns dies a deixar de rebre missatges',
    empty: {
      title: "No s'han trobat subscripcions",
      subtitle:
        "Aquí apareixeran els remitents que t'escriuen amb freqüència.",
    },
    unsubscribe: "Dona't de baixa",
    block: 'Bloqueja',
    frequency: {
      twentyPlus: 'Més de 20 correus recents',
      tenToTwenty: '10-20 correus recents',
      count_one: '{{count}} correu recent',
      count_other: '{{count}} correus recents',
    },
  },

  contacts: {
    searchPlaceholder: 'Cerca contactes…',
    addContact: 'Afegeix un contacte',
    cancel: 'Cancel·la',
    saveContact: 'Desa el contacte',
    save: 'Desa',
    edit: {
      cancel: 'Cancel·la',
    },
    delete: {
      title: 'Vols eliminar aquest contacte?',
      description: 'Aquesta acció no es pot desfer.',
      cta: 'Elimina',
    },
    starredFilter: 'Destacats',
    autoCollected: 'Recollit automàticament',
    empty: {
      noMatch: 'Cap contacte coincideix amb la cerca.',
      none: 'Encara no tens contactes.',
    },
    toast: {
      nameEmailRequired: 'El nom i el correu són obligatoris.',
      created: 'Contacte creat.',
      updated: 'Contacte actualitzat.',
      deleted: 'Contacte eliminat.',
    },
    form: {
      name: 'Nom *',
      email: 'Correu *',
      company: 'Empresa',
      notes: 'Notes',
    },
  },

  shortcuts: {
    title: 'Dreceres de teclat',
    close: 'Tanca',
    actions: {
      compose: 'Redacta',
      reply: 'Respon',
      replyAll: 'Respon a tots',
      forward: 'Reenvia',
      archive: 'Arxiva',
      delete: 'Elimina',
      nextMessage: 'Missatge següent',
      previousMessage: 'Missatge anterior',
      starUnstar: 'Destaca / treu el destacat',
      markUnread: 'Marca com a no llegit',
      search: 'Cerca',
      help: 'Aquesta ajuda',
    },
  },

  cards: {
    purchase: {
      header: 'Compra',
      order: 'Comanda núm.',
      moreItems: '+{{count}} més',
      summary: 'Detalls de la compra',
    },
    bill: {
      header: 'Factura',
      account: 'Compte',
      due: 'Venç el {{date}}',
      overdue: 'Vençuda · {{date}}',
      summary: 'Detalls de la factura',
    },
    trip: {
      header: 'Viatge',
      confirmation: 'Confirmació',
      summary: 'Detalls del viatge',
    },
    package: {
      header: 'Paquet',
      tracking: 'Seguiment',
      estimated: 'Estimat {{date}}',
      summary: 'Detalls del paquet',
    },
    event: {
      header: 'Esdeveniment',
      addToCalendar: 'Afegeix al calendari',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'Afegeix al calendari',
      defaultTitle: 'Esdeveniment',
      summary: "Detalls de l'esdeveniment",
    },
  },

  importance: {
    urgent: 'Urgent',
    action: 'Requereix acció',
    important: 'Important',
    fyi: 'Per a la teva informació',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Configuració · Inbox · Oxy',
    title: 'Configuració',
  },

  auth: {
    gate: {
      title: 'Inicia la sessió per accedir a la safata',
      subtitle:
        'Connecta la teva identitat Oxy per sincronitzar missatges, etiquetes i preferències a tots els dispositius.',
      footer:
        'En iniciar la sessió, acceptes els nostres Termes i reconeixes la nostra Política de privacitat.',
    },
  },
};

export default ca;
