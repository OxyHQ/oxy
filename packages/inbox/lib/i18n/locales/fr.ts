import type { LocaleDict } from '../types';

/**
 * French (fr-FR) translation dictionary for the Inbox app.
 *
 * Tone: informal "tu" — matches the rest of the Oxy ecosystem.
 * Punctuation and capitalization mirror the source EN strings.
 */
const fr: LocaleDict = {
  common: {
    cancel: 'Annuler',
    save: 'Enregistrer',
    ok: 'OK',
    continue: 'Continuer',
    back: 'Retour',
    next: 'Suivant',
    done: 'Terminé',
    close: 'Fermer',
    loading: 'Chargement…',
    error: 'Erreur',
    success: 'Terminé',
    retry: 'Réessayer',
    delete: 'Supprimer',
    edit: 'Modifier',
    remove: 'Retirer',
    confirm: 'Confirmer',
    submit: 'Envoyer',
    search: 'Rechercher',
    yes: 'Oui',
    no: 'Non',
    or: 'ou',
    and: 'et',
    open: 'Ouvrir',
    discard: 'Abandonner',
    of: 'sur',
    more: 'Plus',
    less: 'Moins',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox par Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Boîte',
    search: 'Recherche',
    settings: 'Paramètres',
  },

  drawer: {
    starred: 'Favoris',
    snoozed: 'Reportés',
    subscriptions: 'Abonnements',
    labels: 'Libellés',
    more: 'Plus',
    less: 'Moins',
    notSignedIn: 'Non connecté',
    accountSwitcher: 'Sélecteur de compte',
    addAnotherAccount: 'Ajouter un autre compte',
    signOut: 'Se déconnecter',
    switchAccount: 'Changer de compte, connecté en tant que {{name}}',
    switchingAccount: 'Changement de compte…',
    expandSidebar: 'Développer la barre latérale',
    collapseSidebar: 'Réduire la barre latérale',
    signedOut: {
      title: 'Connecte-toi pour gérer ton courrier',
      subtitle: 'Accède à tes boîtes, à tes libellés et rédige de nouveaux messages.',
    },
    mailboxes: {
      Inbox: 'Boîte de réception',
      Sent: 'Envoyés',
      Drafts: 'Brouillons',
      Trash: 'Corbeille',
      Spam: 'Indésirables',
      Archive: 'Archives',
      Starred: 'Favoris',
      Snoozed: 'Reportés',
    },
    mailboxA11y: '{{name}}, {{count}} non lus',
  },

  home: {
    greeting: {
      morning: 'Bonjour',
      afternoon: 'Bon après-midi',
      evening: 'Bonsoir',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: "Résumé d'aujourd'hui",
    openMenu: 'Ouvrir le menu',
    jumpToToday: "Aller à aujourd'hui",
    previousWeek: 'Semaine précédente',
    nextWeek: 'Semaine suivante',
    regenerateBrief: 'Régénérer le résumé',
    inboxSection: 'Boîte',
    needsResponse: 'Réponse requise',
    followUp: 'À relancer',
    needsResponseA11y_one: 'Réponse requise, {{count}} courriel',
    needsResponseA11y_other: 'Réponse requise, {{count}} courriels',
    followUpA11y_one: 'À relancer, {{count}} courriel',
    followUpA11y_other: 'À relancer, {{count}} courriels',
    days: {
      sun: 'DIM',
      mon: 'LUN',
      tue: 'MAR',
      wed: 'MER',
      thu: 'JEU',
      fri: 'VEN',
      sat: 'SAM',
    },
    stats: {
      unread: '{{count}} non lus',
      starred: '{{count}} favoris',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia analyse ta boîte…',
      unavailable: 'Impossible de générer le résumé pour le moment.',
      empty: 'Aucun courriel à résumer pour le moment.',
    },
    feedEmpty: {
      title: 'Tout est à jour',
      subtitle: 'Rien de nouveau dans ta boîte.',
    },
    signedOut: {
      subtitle:
        'Connecte-toi pour voir ton résumé quotidien, les courriels qui attendent une réponse et les relances en cours.',
    },
  },


  inbox: {
    title: 'Boîte',
    starredTitle: 'Favoris',
    searchInMailbox: 'Rechercher dans {{mailbox}}',
    emptyTitle: 'Rien ici',
    emptyAllCaught: 'Tout est à jour.',
    emptySignIn: 'Connecte-toi pour accéder à ton courrier.',
    pagination: '{{from}}–{{to}} sur {{total}}',
    remind: 'Rappeler',
    bundled: 'Groupés',
    flat: 'Liste',
    composeFab: 'Rédiger un nouveau courriel',
    composeFabLabel: 'Rédiger',
    askAlia: 'Demander à Alia',
    askAliaHint: "Ouvre l'assistant IA Alia pour poser des questions sur ta boîte",
    sections: {
      reminders: 'Rappels',
      pinned: 'Épinglés',
      today: "Aujourd'hui",
      yesterday: 'Hier',
      thisWeek: 'Cette semaine',
      thisMonth: 'Ce mois-ci',
      earlier: 'Plus anciens',
    },
    aliaSuggestions: {
      unread: {
        label: 'Courriels non lus',
        prompt: 'Quels courriels nécessitent mon attention ?',
      },
      todaysSummary: {
        label: "Résumé d'aujourd'hui",
        prompt: "Résume mes courriels d'aujourd'hui",
      },
      withAttachments: {
        label: 'Avec pièces jointes',
        prompt: 'Trouve les courriels avec pièces jointes',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'Dossier Archives indisponible.',
      trashUnavailable: 'Dossier Corbeille indisponible.',
      offlineSync_one: '{{count}} action hors ligne synchronisée.',
      offlineSync_other: '{{count}} actions hors ligne synchronisées.',
      newVersionAvailable: 'Nouvelle version disponible — actualise pour mettre à jour.',
      newEmail: 'Nouvel e-mail de {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(sans objet)',
      emptyMessage: '(message vide)',
      messagesInConversation_one: '{{count}} message dans cette conversation',
      messagesInConversation_other: '{{count}} messages dans cette conversation',
      toRecipients: 'à {{recipients}}',
      ccRecipients: ', cc : {{recipients}}',
    },
    actions: {
      archive: 'Archiver',
      delete: 'Supprimer',
      markUnread: 'Marquer comme non lu',
      markRead: 'Marquer comme lu',
      reply: 'Répondre',
      replyAll: 'Répondre à tous',
      forward: 'Transférer',
      pin: 'Épingler le message',
      unpin: 'Désépingler le message',
      star: 'Mettre en favori',
      unstar: 'Retirer des favoris',
      snooze: 'Reporter',
      print: 'Imprimer',
      more: "Plus d'actions",
      moreInline: 'Plus',
      reportSpam: 'Signaler comme spam',
      label: 'Libellé',
      downloadEml: 'Télécharger .eml',
      messageActions: 'Actions du message',
    },
    labelPicker: {
      title: 'Libellés',
      empty: 'Pas encore de libellés',
    },
    toast: {
      attachmentFailed: 'Échec du téléchargement de la pièce jointe.',
      fileSystemUnavailable: 'Système de fichiers indisponible sur cet appareil.',
      sharingUnavailable: 'Partage indisponible sur cet appareil.',
      printFailed: "Échec de l'impression.",
      downloadFailed: 'Échec du téléchargement.',
      saveEmailDialog: 'Enregistrer le courriel',
    },
  },

  empty: {
    selectConversation: 'Sélectionne une conversation',
    nothingHere: 'Rien ici',
  },

  notFound: {
    title:
      'Cette conversation est introuvable. Elle a peut-être été déplacée, archivée ou supprimée.',
    back: 'Retour à la boîte',
  },

  search: {
    placeholder: 'Rechercher dans le courrier',
    clear: 'Effacer la recherche',
    openMenu: 'Ouvrir le menu',
    goBack: 'Retour',
    filters: {
      from: 'De',
      fromValue: 'De : {{value}}',
      hasAttachment: 'Avec pièce jointe',
    },
    nl: {
      understanding: 'Compréhension de la recherche…',
      searching: 'Recherche : {{filters}}',
      allEmails: 'tous les courriels',
      fromValue: 'de {{value}}',
      toValue: 'à {{value}}',
      subjectContains: 'objet contient « {{value}} »',
      withAttachments: 'avec pièces jointes',
      starred: 'favoris',
      unread: 'non lus',
      read: 'lus',
    },
    empty: {
      noResults: 'Aucun résultat',
      idle: 'Recherche dans tes courriels',
    },
    results_one: '{{count}} résultat',
    results_other: '{{count}} résultats',
  },

  compose: {
    titleCompose: 'Rédiger',
    titleReply: 'Répondre',
    titleForward: 'Transférer',
    headTitleCompose: 'Rédiger · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Rédiger · Oxy',
    placeholders: {
      to: 'Destinataires',
      subject: 'Objet',
      body: 'Rédige le courriel',
    },
    fields: {
      from: 'De',
      to: 'À',
      cc: 'Cc',
      bcc: 'Cci',
    },
    actions: {
      send: 'Envoyer',
      sendNow: 'Envoyer maintenant',
      moreSendOptions: "Plus d'options d'envoi",
      sendOptions: "Options d'envoi",
      scheduleSend: "Planifier l'envoi",
      saveDraft: 'Enregistrer le brouillon',
      discard: 'Abandonner',
    },
    saveDraftPrompt: {
      title: 'Enregistrer le brouillon ?',
      description: 'Veux-tu enregistrer ce message comme brouillon ?',
    },
    dropZone: 'Dépose les fichiers à joindre',
    toast: {
      addRecipient: 'Ajoute au moins un destinataire.',
      invalidEmail: 'Saisis une adresse électronique valide.',
      sendFailed: "Impossible d'envoyer le courriel. Réessaie.",
      scheduleFailed: 'Impossible de planifier le courriel. Réessaie.',
      scheduled: 'Courriel planifié pour le {{time}}',
      uploadFailed: 'Échec du téléversement de la pièce jointe.',
      signatureFailed: 'Échec du chargement de la signature.',
    },
  },

  inlineReply: {
    placeholder: 'Écris ta réponse…',
    forwardTo: 'Transférer à :',
    replyAllTo: 'Répondre à tous à :',
    replyTo: 'Répondre à :',
    cc: 'Cc :',
    bcc: 'Cci :',
    ccBccToggle: 'Cc/Cci',
    addRecipients: 'Ajouter des destinataires',
    send: 'Envoyer',
    quotedPrefix: 'Le {{date}}, {{author}} a écrit :',
    forwardHeader:
      '\n\n---------- Message transféré ----------\nDe : {{from}}\nDate : {{date}}\nObjet : {{subject}}\nÀ : {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Réponses rapides',
  },

  ai: {
    toolbar: {
      draft: 'Rédiger',
      polish: 'Affiner',
      shorter: 'Plus court',
      longer: 'Plus long',
      tone: 'Ton',
      suggestSubject: 'Suggérer un objet',
    },
    draftModal: {
      title: 'Rédiger avec IA',
      subtitle: 'Décris ce que tu veux dire et Alia le rédigera pour toi.',
      placeholder: 'p. ex., Décliner poliment la réunion et proposer la semaine prochaine',
      toneLabel: 'Ton :',
      cancel: 'Annuler',
      draft: 'Rédiger',
    },
    toneMenu: {
      title: 'Changer le ton vers…',
    },
    tones: {
      professional: 'Professionnel',
      casual: 'Décontracté',
      friendly: 'Amical',
      formal: 'Formel',
    },
  },

  threadSummary: {
    title: 'Résumé de la conversation',
    messages_one: '{{count}} message',
    messages_other: '{{count}} messages',
    keyPoints: 'Points clés',
    actionItems: 'Actions à faire',
    due: 'Échéance : {{date}}',
  },

  staleThread: {
    consider: 'Envisage une réponse rapide',
    reply: 'Répondre',
  },

  followUpReminder: {
    pastDue: 'Engagement en retard',
    upcoming: 'Engagement à venir',
    description: "Tu as dit « {{text}} » à {{recipient}}",
    deadline: {
      dueToday: "Échéance aujourd'hui",
      overdueOneDay: 'En retard de 1 jour',
      overdueDays: 'En retard de {{days}} jours',
      dueTomorrow: 'Échéance demain',
      dueInDays: 'Échéance dans {{days}} jours',
    },
    fallbackName: "quelqu'un",
    view: 'Voir',
    done: 'Terminé',
  },

  reminder: {
    create: {
      title: 'Créer un rappel',
      placeholder: 'De quoi veux-tu te souvenir ?',
      whenLabel: 'Quand ?',
      submit: 'Créer le rappel',
      presets: {
        laterToday: 'Plus tard aujourd\'hui',
        tomorrowMorning: 'Demain matin',
        thisWeekend: 'Ce week-end',
        nextWeek: 'La semaine prochaine',
      },
    },
    time: {
      overdue: 'En retard · {{date}}, {{time}}',
      today: "Aujourd'hui, {{time}}",
      tomorrow: 'Demain, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Reporter à…',
    options: {
      laterToday: 'Plus tard aujourd\'hui',
      tomorrow: 'Demain',
      thisWeekend: 'Ce week-end',
      nextWeek: 'La semaine prochaine',
    },
    time: {
      today: "Aujourd'hui, {{time}}",
      tomorrow: 'Demain, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: "Planifier l'envoi",
    options: {
      laterToday: 'Plus tard aujourd\'hui',
      tomorrowMorning: 'Demain matin',
      tomorrowAfternoon: 'Demain après-midi',
      mondayMorning: 'Lundi matin',
    },
  },

  template: {
    insert: 'Insérer un modèle',
  },

  selection: {
    archive: 'Archiver',
    delete: 'Supprimer',
    star: 'Mettre en favori',
    markRead: 'Marquer comme lu',
  },

  subscriptions: {
    title: 'Abonnements',
    subtitle:
      'Après désabonnement, il peut falloir quelques jours avant de cesser de recevoir des messages',
    empty: {
      title: 'Aucun abonnement trouvé',
      subtitle: "Les expéditeurs qui t'écrivent souvent apparaîtront ici.",
    },
    unsubscribe: 'Se désabonner',
    block: 'Bloquer',
    frequency: {
      twentyPlus: '20+ courriels récents',
      tenToTwenty: '10-20 courriels récents',
      count_one: '{{count}} courriel récent',
      count_other: '{{count}} courriels récents',
    },
  },

  contacts: {
    searchPlaceholder: 'Rechercher des contacts…',
    addContact: 'Ajouter un contact',
    cancel: 'Annuler',
    saveContact: 'Enregistrer le contact',
    save: 'Enregistrer',
    edit: {
      cancel: 'Annuler',
    },
    delete: {
      title: 'Supprimer ce contact ?',
      description: 'Cette action est irréversible.',
      cta: 'Supprimer',
    },
    starredFilter: 'Favoris',
    autoCollected: 'Collecté automatiquement',
    empty: {
      noMatch: 'Aucun contact ne correspond à ta recherche.',
      none: 'Pas encore de contacts.',
    },
    toast: {
      nameEmailRequired: 'Nom et courriel sont requis.',
      created: 'Contact créé.',
      updated: 'Contact mis à jour.',
      deleted: 'Contact supprimé.',
    },
    form: {
      name: 'Nom *',
      email: 'Courriel *',
      company: 'Entreprise',
      notes: 'Notes',
    },
  },

  shortcuts: {
    title: 'Raccourcis clavier',
    close: 'Fermer',
    actions: {
      compose: 'Rédiger',
      reply: 'Répondre',
      replyAll: 'Répondre à tous',
      forward: 'Transférer',
      archive: 'Archiver',
      delete: 'Supprimer',
      nextMessage: 'Message suivant',
      previousMessage: 'Message précédent',
      starUnstar: 'Favori / retirer favori',
      markUnread: 'Marquer comme non lu',
      search: 'Rechercher',
      help: 'Cette aide',
    },
  },

  cards: {
    purchase: {
      header: 'Achat',
      order: 'Commande n°',
      moreItems: '+{{count}} de plus',
      summary: "Détails de l'achat",
    },
    bill: {
      header: 'Facture',
      account: 'Compte',
      due: 'Échéance {{date}}',
      overdue: 'En retard · {{date}}',
      summary: 'Détails de la facture',
    },
    trip: {
      header: 'Voyage',
      confirmation: 'Confirmation',
      summary: 'Détails du voyage',
    },
    package: {
      header: 'Colis',
      tracking: 'Suivi',
      estimated: 'Est. {{date}}',
      summary: 'Détails du colis',
    },
    event: {
      header: 'Événement',
      addToCalendar: 'Ajouter au calendrier',
      googleCalendar: 'Google Agenda',
      addToCalendarDialog: 'Ajouter au calendrier',
      defaultTitle: 'Événement',
      summary: "Détails de l'événement",
    },
  },

  importance: {
    urgent: 'Urgent',
    action: 'Action requise',
    important: 'Important',
    fyi: 'Pour info',
  },

  attachment: {
    sizeBytes: '{{value}} o',
    sizeKb: '{{value}} Ko',
    sizeMb: '{{value}} Mo',
  },

  settings: {
    head: 'Paramètres · Inbox · Oxy',
    title: 'Paramètres',
  },

  auth: {
    gate: {
      title: 'Connecte-toi pour accéder à ta boîte',
      subtitle:
        'Connecte ton identité Oxy pour synchroniser messages, libellés et préférences sur tous tes appareils.',
      footer:
        "En te connectant, tu acceptes nos Conditions et reconnais notre Politique de confidentialité.",
    },
  },
};

export default fr;
