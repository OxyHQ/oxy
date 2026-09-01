import type { LocaleDict } from '../types';

/**
 * Spanish (es-ES) translation dictionary for the Inbox app.
 *
 * Tone: informal "tú" — matches the rest of the Oxy ecosystem (accounts app,
 * core). Punctuation and capitalization mirror the source EN strings.
 */
const es: LocaleDict = {
  common: {
    cancel: 'Cancelar',
    save: 'Guardar',
    ok: 'Aceptar',
    continue: 'Continuar',
    back: 'Atrás',
    next: 'Siguiente',
    done: 'Listo',
    close: 'Cerrar',
    loading: 'Cargando…',
    error: 'Error',
    success: 'Listo',
    retry: 'Reintentar',
    delete: 'Eliminar',
    edit: 'Editar',
    remove: 'Quitar',
    confirm: 'Confirmar',
    submit: 'Enviar',
    search: 'Buscar',
    yes: 'Sí',
    no: 'No',
    or: 'o',
    and: 'y',
    open: 'Abrir',
    discard: 'Descartar',
    of: 'de',
    more: 'Más',
    less: 'Menos',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox de Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Bandeja',
    search: 'Buscar',
    settings: 'Ajustes',
  },

  drawer: {
    starred: 'Destacados',
    snoozed: 'Pospuestos',
    subscriptions: 'Suscripciones',
    labels: 'Etiquetas',
    more: 'Más',
    less: 'Menos',
    notSignedIn: 'Sesión no iniciada',
    accountSwitcher: 'Selector de cuenta',
    addAnotherAccount: 'Añadir otra cuenta',
    signOut: 'Cerrar sesión',
    switchAccount: 'Cambiar de cuenta, sesión iniciada como {{name}}',
    switchingAccount: 'Cambiando de cuenta…',
    expandSidebar: 'Expandir barra lateral',
    collapseSidebar: 'Contraer barra lateral',
    signedOut: {
      title: 'Inicia sesión para gestionar tu correo',
      subtitle:
        'Accede a tus carpetas, etiquetas y crea mensajes nuevos.',
    },
    mailboxes: {
      Inbox: 'Bandeja de entrada',
      Sent: 'Enviados',
      Drafts: 'Borradores',
      Trash: 'Papelera',
      Spam: 'Spam',
      Archive: 'Archivo',
      Starred: 'Destacados',
      Snoozed: 'Pospuestos',
    },
    mailboxA11y: '{{name}}, {{count}} sin leer',
  },

  home: {
    greeting: {
      morning: 'Buenos días',
      afternoon: 'Buenas tardes',
      evening: 'Buenas noches',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: 'Resumen de hoy',
    openMenu: 'Abrir menú',
    jumpToToday: 'Ir a hoy',
    previousWeek: 'Semana anterior',
    nextWeek: 'Semana siguiente',
    regenerateBrief: 'Regenerar resumen',
    inboxSection: 'Bandeja',
    needsResponse: 'Necesita respuesta',
    followUp: 'Pendiente de seguimiento',
    needsResponseA11y_one: 'Necesita respuesta, {{count}} correo',
    needsResponseA11y_other: 'Necesita respuesta, {{count}} correos',
    followUpA11y_one: 'Pendiente de seguimiento, {{count}} correo',
    followUpA11y_other: 'Pendiente de seguimiento, {{count}} correos',
    days: {
      sun: 'DOM',
      mon: 'LUN',
      tue: 'MAR',
      wed: 'MIÉ',
      thu: 'JUE',
      fri: 'VIE',
      sat: 'SÁB',
    },
    stats: {
      unread: '{{count}} sin leer',
      starred: '{{count}} destacados',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia está analizando tu bandeja…',
      unavailable: 'No se pudo generar el resumen ahora.',
      empty: 'Aún no hay correos para resumir.',
    },
    feedEmpty: {
      title: 'Todo al día',
      subtitle: 'No hay nada nuevo en tu bandeja.',
    },
    signedOut: {
      subtitle:
        'Inicia sesión para ver tu resumen diario, los correos que necesitan respuesta y los seguimientos pendientes.',
    },
  },


  inbox: {
    title: 'Bandeja',
    starredTitle: 'Destacados',
    searchInMailbox: 'Buscar en {{mailbox}}',
    emptyTitle: 'No hay nada aquí',
    emptyAllCaught: 'Estás al día.',
    emptySignIn: 'Inicia sesión para acceder a tu correo.',
    pagination: '{{from}}–{{to}} de {{total}}',
    remind: 'Recordar',
    bundled: 'Agrupados',
    flat: 'Lista',
    composeFab: 'Redactar correo nuevo',
    composeFabLabel: 'Redactar',
    askAlia: 'Preguntar a Alia',
    askAliaHint:
      'Abre el asistente de IA Alia para hacer preguntas sobre tu bandeja',
    sections: {
      reminders: 'Recordatorios',
      pinned: 'Fijados',
      today: 'Hoy',
      yesterday: 'Ayer',
      thisWeek: 'Esta semana',
      thisMonth: 'Este mes',
      earlier: 'Anteriores',
    },
    aliaSuggestions: {
      unread: {
        label: 'Correos sin leer',
        prompt: '¿Qué correos necesitan mi atención?',
      },
      todaysSummary: {
        label: 'Resumen de hoy',
        prompt: 'Resume mis correos de hoy',
      },
      withAttachments: {
        label: 'Con adjuntos',
        prompt: 'Busca correos con adjuntos',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'La carpeta Archivo no está disponible.',
      trashUnavailable: 'La carpeta Papelera no está disponible.',
      offlineSync_one: 'Sincronizada {{count}} acción sin conexión.',
      offlineSync_other: 'Sincronizadas {{count}} acciones sin conexión.',
      newVersionAvailable: 'Hay una versión nueva — recarga para actualizar.',
      newEmail: 'Nuevo email de {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(sin asunto)',
      emptyMessage: '(mensaje vacío)',
      messagesInConversation_one: '{{count}} mensaje en esta conversación',
      messagesInConversation_other: '{{count}} mensajes en esta conversación',
      toRecipients: 'a {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Archivar',
      delete: 'Eliminar',
      markUnread: 'Marcar como no leído',
      markRead: 'Marcar como leído',
      reply: 'Responder',
      replyAll: 'Responder a todos',
      forward: 'Reenviar',
      pin: 'Fijar mensaje',
      unpin: 'Desfijar mensaje',
      star: 'Destacar mensaje',
      unstar: 'Quitar destacado',
      snooze: 'Posponer',
      print: 'Imprimir',
      more: 'Más acciones',
      moreInline: 'Más',
      reportSpam: 'Marcar como spam',
      label: 'Etiqueta',
      downloadEml: 'Descargar .eml',
      messageActions: 'Acciones del mensaje',
    },
    labelPicker: {
      title: 'Etiquetas',
      empty: 'Aún no hay etiquetas',
    },
    toast: {
      attachmentFailed: 'No se pudo descargar el adjunto.',
      fileSystemUnavailable:
        'El sistema de archivos no está disponible en este dispositivo.',
      sharingUnavailable: 'Compartir no está disponible en este dispositivo.',
      printFailed: 'No se pudo imprimir el correo.',
      downloadFailed: 'No se pudo descargar el correo.',
      saveEmailDialog: 'Guardar correo',
    },
  },

  empty: {
    selectConversation: 'Selecciona una conversación',
    nothingHere: 'No hay nada aquí',
  },

  notFound: {
    title:
      'No se ha encontrado esa conversación. Puede que se haya movido, archivado o eliminado.',
    back: 'Volver a la bandeja',
  },

  search: {
    placeholder: 'Buscar correo',
    clear: 'Limpiar búsqueda',
    openMenu: 'Abrir menú',
    goBack: 'Atrás',
    filters: {
      from: 'De',
      fromValue: 'De: {{value}}',
      hasAttachment: 'Con adjunto',
    },
    nl: {
      understanding: 'Analizando tu búsqueda…',
      searching: 'Buscando: {{filters}}',
      allEmails: 'todos los correos',
      fromValue: 'de {{value}}',
      toValue: 'para {{value}}',
      subjectContains: 'asunto contiene "{{value}}"',
      withAttachments: 'con adjuntos',
      starred: 'destacados',
      unread: 'sin leer',
      read: 'leídos',
    },
    empty: {
      noResults: 'No se han encontrado resultados',
      idle: 'Busca en tus correos',
    },
    results_one: '{{count}} resultado',
    results_other: '{{count}} resultados',
  },

  compose: {
    titleCompose: 'Redactar',
    titleReply: 'Responder',
    titleForward: 'Reenviar',
    headTitleCompose: 'Redactar · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Redactar · Oxy',
    placeholders: {
      to: 'Destinatarios',
      subject: 'Asunto',
      body: 'Redactar correo',
    },
    fields: {
      from: 'De',
      to: 'Para',
      cc: 'Cc',
      bcc: 'Cco',
    },
    actions: {
      send: 'Enviar',
      sendNow: 'Enviar ahora',
      moreSendOptions: 'Más opciones de envío',
      sendOptions: 'Opciones de envío',
      scheduleSend: 'Programar envío',
      saveDraft: 'Guardar borrador',
      discard: 'Descartar',
    },
    saveDraftPrompt: {
      title: '¿Guardar borrador?',
      description: '¿Quieres guardar este mensaje como borrador?',
    },
    dropZone: 'Suelta los archivos para adjuntar',
    toast: {
      addRecipient: 'Añade al menos un destinatario.',
      invalidEmail: 'Introduce una dirección de correo válida.',
      sendFailed: 'No se pudo enviar el correo. Inténtalo de nuevo.',
      scheduleFailed: 'No se pudo programar el envío. Inténtalo de nuevo.',
      scheduled: 'Correo programado para el {{time}}',
      uploadFailed: 'No se pudo subir el adjunto.',
      signatureFailed: 'No se pudo cargar la firma.',
    },
  },

  inlineReply: {
    placeholder: 'Escribe tu respuesta…',
    forwardTo: 'Reenviar a:',
    replyAllTo: 'Responder a todos a:',
    replyTo: 'Responder a:',
    cc: 'Cc:',
    bcc: 'Cco:',
    ccBccToggle: 'Cc/Cco',
    addRecipients: 'Añadir destinatarios',
    send: 'Enviar',
    quotedPrefix: 'El {{date}}, {{author}} escribió:',
    forwardHeader:
      '\n\n---------- Mensaje reenviado ----------\nDe: {{from}}\nFecha: {{date}}\nAsunto: {{subject}}\nPara: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Respuestas rápidas',
  },

  ai: {
    toolbar: {
      draft: 'Redactar',
      polish: 'Pulir',
      shorter: 'Más corto',
      longer: 'Más largo',
      tone: 'Tono',
      suggestSubject: 'Sugerir asunto',
    },
    draftModal: {
      title: 'Redactar con IA',
      subtitle: 'Describe qué quieres decir y Alia lo redactará por ti.',
      placeholder:
        'p. ej., Rechaza la reunión con educación y sugiere la próxima semana',
      toneLabel: 'Tono:',
      cancel: 'Cancelar',
      draft: 'Redactar',
    },
    toneMenu: {
      title: 'Cambiar el tono a…',
    },
    tones: {
      professional: 'Profesional',
      casual: 'Informal',
      friendly: 'Cercano',
      formal: 'Formal',
    },
  },

  threadSummary: {
    title: 'Resumen de la conversación',
    messages_one: '{{count}} mensaje',
    messages_other: '{{count}} mensajes',
    keyPoints: 'Puntos clave',
    actionItems: 'Acciones pendientes',
    due: 'Para: {{date}}',
  },

  staleThread: {
    consider: 'Plantéate enviar una respuesta rápida',
    reply: 'Responder',
  },

  followUpReminder: {
    pastDue: 'Compromiso vencido',
    upcoming: 'Compromiso próximo',
    description: 'Dijiste «{{text}}» a {{recipient}}',
    deadline: {
      dueToday: 'Vence hoy',
      overdueOneDay: 'Vencido hace 1 día',
      overdueDays: 'Vencido hace {{days}} días',
      dueTomorrow: 'Vence mañana',
      dueInDays: 'Vence en {{days}} días',
    },
    fallbackName: 'alguien',
    view: 'Ver',
    done: 'Hecho',
  },

  reminder: {
    create: {
      title: 'Crear recordatorio',
      placeholder: '¿De qué quieres que te recordemos?',
      whenLabel: '¿Cuándo?',
      submit: 'Crear recordatorio',
      presets: {
        laterToday: 'Más tarde hoy',
        tomorrowMorning: 'Mañana por la mañana',
        thisWeekend: 'Este fin de semana',
        nextWeek: 'La próxima semana',
      },
    },
    time: {
      overdue: 'Vencido · {{date}}, {{time}}',
      today: 'Hoy, {{time}}',
      tomorrow: 'Mañana, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Posponer hasta…',
    options: {
      laterToday: 'Más tarde hoy',
      tomorrow: 'Mañana',
      thisWeekend: 'Este fin de semana',
      nextWeek: 'La próxima semana',
    },
    time: {
      today: 'Hoy, {{time}}',
      tomorrow: 'Mañana, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: 'Programar envío',
    options: {
      laterToday: 'Más tarde hoy',
      tomorrowMorning: 'Mañana por la mañana',
      tomorrowAfternoon: 'Mañana por la tarde',
      mondayMorning: 'El lunes por la mañana',
    },
  },

  template: {
    insert: 'Insertar plantilla',
  },

  selection: {
    archive: 'Archivar',
    delete: 'Eliminar',
    star: 'Destacar',
    markRead: 'Marcar como leído',
  },

  subscriptions: {
    title: 'Suscripciones',
    subtitle:
      'Al darte de baja puede tardar unos días en dejar de llegarte mensajes',
    empty: {
      title: 'No se han encontrado suscripciones',
      subtitle:
        'Aquí aparecerán los remitentes que te escriben con frecuencia.',
    },
    unsubscribe: 'Darse de baja',
    block: 'Bloquear',
    frequency: {
      twentyPlus: 'Más de 20 correos recientes',
      tenToTwenty: '10-20 correos recientes',
      count_one: '{{count}} correo reciente',
      count_other: '{{count}} correos recientes',
    },
  },

  contacts: {
    searchPlaceholder: 'Buscar contactos…',
    addContact: 'Añadir contacto',
    cancel: 'Cancelar',
    saveContact: 'Guardar contacto',
    save: 'Guardar',
    edit: {
      cancel: 'Cancelar',
    },
    delete: {
      title: '¿Eliminar este contacto?',
      description: 'Esta acción no se puede deshacer.',
      cta: 'Eliminar',
    },
    starredFilter: 'Destacados',
    autoCollected: 'Recopilado automáticamente',
    empty: {
      noMatch: 'Ningún contacto coincide con tu búsqueda.',
      none: 'Aún no tienes contactos.',
    },
    toast: {
      nameEmailRequired: 'Nombre y correo son obligatorios.',
      created: 'Contacto creado.',
      updated: 'Contacto actualizado.',
      deleted: 'Contacto eliminado.',
    },
    form: {
      name: 'Nombre *',
      email: 'Correo *',
      company: 'Empresa',
      notes: 'Notas',
    },
  },

  shortcuts: {
    title: 'Atajos de teclado',
    close: 'Cerrar',
    actions: {
      compose: 'Redactar',
      reply: 'Responder',
      replyAll: 'Responder a todos',
      forward: 'Reenviar',
      archive: 'Archivar',
      delete: 'Eliminar',
      nextMessage: 'Mensaje siguiente',
      previousMessage: 'Mensaje anterior',
      starUnstar: 'Destacar / quitar destacado',
      markUnread: 'Marcar como no leído',
      search: 'Buscar',
      help: 'Esta ayuda',
    },
  },

  cards: {
    purchase: {
      header: 'Compra',
      order: 'Pedido n.º',
      moreItems: '+{{count}} más',
      summary: 'Detalles de la compra',
    },
    bill: {
      header: 'Factura',
      account: 'Cuenta',
      due: 'Vence el {{date}}',
      overdue: 'Vencida · {{date}}',
      summary: 'Detalles de la factura',
    },
    trip: {
      header: 'Viaje',
      confirmation: 'Confirmación',
      summary: 'Detalles del viaje',
    },
    package: {
      header: 'Paquete',
      tracking: 'Seguimiento',
      estimated: 'Estimado {{date}}',
      summary: 'Detalles del paquete',
    },
    event: {
      header: 'Evento',
      addToCalendar: 'Añadir al calendario',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'Añadir al calendario',
      defaultTitle: 'Evento',
      summary: 'Detalles del evento',
    },
  },

  importance: {
    urgent: 'Urgente',
    action: 'Requiere acción',
    important: 'Importante',
    fyi: 'Para tu información',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Ajustes · Inbox · Oxy',
    title: 'Ajustes',
  },

  auth: {
    gate: {
      title: 'Inicia sesión para acceder a tu inbox',
      subtitle: 'Conecta tu identidad Oxy para sincronizar mensajes, etiquetas y preferencias en todos tus dispositivos.',
      footer: 'Al iniciar sesión aceptas nuestros Términos y reconoces nuestra Política de Privacidad.',
    },
  },
};

export default es;
