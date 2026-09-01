import type { LocaleDict } from '../types';

/**
 * Portuguese (pt-PT) translation dictionary for the Inbox app.
 *
 * Tone: informal "tu" — matches the rest of the Oxy ecosystem.
 * Punctuation and capitalization mirror the source EN strings.
 */
const pt: LocaleDict = {
  common: {
    cancel: 'Cancelar',
    save: 'Guardar',
    ok: 'OK',
    continue: 'Continuar',
    back: 'Voltar',
    next: 'Seguinte',
    done: 'Concluído',
    close: 'Fechar',
    loading: 'A carregar…',
    error: 'Erro',
    success: 'Pronto',
    retry: 'Tentar novamente',
    delete: 'Eliminar',
    edit: 'Editar',
    remove: 'Remover',
    confirm: 'Confirmar',
    submit: 'Enviar',
    search: 'Pesquisar',
    yes: 'Sim',
    no: 'Não',
    or: 'ou',
    and: 'e',
    open: 'Abrir',
    discard: 'Descartar',
    of: 'de',
    more: 'Mais',
    less: 'Menos',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox da Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'Caixa de entrada',
    search: 'Pesquisar',
    settings: 'Definições',
  },

  drawer: {
    starred: 'Com estrela',
    snoozed: 'Adiados',
    subscriptions: 'Subscrições',
    labels: 'Etiquetas',
    more: 'Mais',
    less: 'Menos',
    notSignedIn: 'Sessão não iniciada',
    accountSwitcher: 'Seletor de conta',
    addAnotherAccount: 'Adicionar outra conta',
    signOut: 'Terminar sessão',
    switchAccount: 'Trocar de conta, sessão iniciada como {{name}}',
    switchingAccount: 'A trocar de conta…',
    expandSidebar: 'Expandir barra lateral',
    collapseSidebar: 'Recolher barra lateral',
    signedOut: {
      title: 'Inicia sessão para gerir o teu correio',
      subtitle: 'Acede às caixas, etiquetas e compõe novas mensagens.',
    },
    mailboxes: {
      Inbox: 'Caixa de entrada',
      Sent: 'Enviados',
      Drafts: 'Rascunhos',
      Trash: 'Lixo',
      Spam: 'Spam',
      Archive: 'Arquivo',
      Starred: 'Com estrela',
      Snoozed: 'Adiados',
    },
    mailboxA11y: '{{name}}, {{count}} por ler',
  },

  home: {
    greeting: {
      morning: 'Bom dia',
      afternoon: 'Boa tarde',
      evening: 'Boa noite',
      withName: '{{greeting}}, {{name}}',
    },
    todaysBrief: 'Resumo de hoje',
    openMenu: 'Abrir menu',
    jumpToToday: 'Ir para hoje',
    previousWeek: 'Semana anterior',
    nextWeek: 'Semana seguinte',
    regenerateBrief: 'Regenerar resumo',
    inboxSection: 'Caixa de entrada',
    needsResponse: 'Precisa de resposta',
    followUp: 'Pendente de seguimento',
    needsResponseA11y_one: 'Precisa de resposta, {{count}} email',
    needsResponseA11y_other: 'Precisa de resposta, {{count}} emails',
    followUpA11y_one: 'Pendente de seguimento, {{count}} email',
    followUpA11y_other: 'Pendente de seguimento, {{count}} emails',
    days: {
      sun: 'DOM',
      mon: 'SEG',
      tue: 'TER',
      wed: 'QUA',
      thu: 'QUI',
      fri: 'SEX',
      sat: 'SÁB',
    },
    stats: {
      unread: '{{count}} por ler',
      starred: '{{count}} com estrela',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'A Alia está a analisar a tua caixa…',
      unavailable: 'Não foi possível gerar o resumo agora.',
      empty: 'Ainda não há emails para resumir.',
    },
    feedEmpty: {
      title: 'Tudo em dia',
      subtitle: 'Não há nada novo na caixa.',
    },
    signedOut: {
      subtitle:
        'Inicia sessão para ver o resumo diário, os emails que precisam de resposta e os seguimentos pendentes.',
    },
  },


  inbox: {
    title: 'Caixa de entrada',
    starredTitle: 'Com estrela',
    searchInMailbox: 'Pesquisar em {{mailbox}}',
    emptyTitle: 'Não há nada aqui',
    emptyAllCaught: 'Estás em dia.',
    emptySignIn: 'Inicia sessão para aceder ao teu correio.',
    pagination: '{{from}}–{{to}} de {{total}}',
    remind: 'Lembrar',
    bundled: 'Agrupados',
    flat: 'Lista',
    composeFab: 'Escrever novo email',
    composeFabLabel: 'Escrever',
    askAlia: 'Perguntar à Alia',
    askAliaHint: 'Abre o assistente de IA Alia para fazer perguntas sobre a caixa',
    sections: {
      reminders: 'Lembretes',
      pinned: 'Fixados',
      today: 'Hoje',
      yesterday: 'Ontem',
      thisWeek: 'Esta semana',
      thisMonth: 'Este mês',
      earlier: 'Anteriores',
    },
    aliaSuggestions: {
      unread: {
        label: 'Emails por ler',
        prompt: 'Que emails precisam da minha atenção?',
      },
      todaysSummary: {
        label: 'Resumo de hoje',
        prompt: 'Resume os emails de hoje',
      },
      withAttachments: {
        label: 'Com anexos',
        prompt: 'Procura emails com anexos',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'Pasta Arquivo não disponível.',
      trashUnavailable: 'Pasta Lixo não disponível.',
      offlineSync_one: 'Sincronizada {{count}} ação offline.',
      offlineSync_other: 'Sincronizadas {{count}} ações offline.',
      newVersionAvailable: 'Nova versão disponível — atualiza a página.',
      newEmail: 'Novo email de {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(sem assunto)',
      emptyMessage: '(mensagem vazia)',
      messagesInConversation_one: '{{count}} mensagem nesta conversa',
      messagesInConversation_other: '{{count}} mensagens nesta conversa',
      toRecipients: 'a {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: 'Arquivar',
      delete: 'Eliminar',
      markUnread: 'Marcar como não lido',
      markRead: 'Marcar como lido',
      reply: 'Responder',
      replyAll: 'Responder a todos',
      forward: 'Reencaminhar',
      pin: 'Fixar mensagem',
      unpin: 'Desafixar mensagem',
      star: 'Marcar com estrela',
      unstar: 'Remover estrela',
      snooze: 'Adiar',
      print: 'Imprimir',
      more: 'Mais ações',
      moreInline: 'Mais',
      reportSpam: 'Marcar como spam',
      label: 'Etiqueta',
      downloadEml: 'Transferir .eml',
      messageActions: 'Ações da mensagem',
    },
    labelPicker: {
      title: 'Etiquetas',
      empty: 'Ainda não há etiquetas',
    },
    toast: {
      attachmentFailed: 'Não foi possível transferir o anexo.',
      fileSystemUnavailable: 'Sistema de ficheiros indisponível neste dispositivo.',
      sharingUnavailable: 'Partilha indisponível neste dispositivo.',
      printFailed: 'Falha ao imprimir o email.',
      downloadFailed: 'Falha ao transferir o email.',
      saveEmailDialog: 'Guardar email',
    },
  },

  empty: {
    selectConversation: 'Seleciona uma conversa',
    nothingHere: 'Não há nada aqui',
  },

  notFound: {
    title:
      'Não foi possível encontrar essa conversa. Pode ter sido movida, arquivada ou eliminada.',
    back: 'Voltar à caixa',
  },

  search: {
    placeholder: 'Pesquisar no correio',
    clear: 'Limpar pesquisa',
    openMenu: 'Abrir menu',
    goBack: 'Voltar',
    filters: {
      from: 'De',
      fromValue: 'De: {{value}}',
      hasAttachment: 'Com anexo',
    },
    nl: {
      understanding: 'A interpretar a tua pesquisa…',
      searching: 'A pesquisar: {{filters}}',
      allEmails: 'todos os emails',
      fromValue: 'de {{value}}',
      toValue: 'para {{value}}',
      subjectContains: 'assunto contém "{{value}}"',
      withAttachments: 'com anexos',
      starred: 'com estrela',
      unread: 'por ler',
      read: 'lidos',
    },
    empty: {
      noResults: 'Sem resultados',
      idle: 'Pesquisa nos teus emails',
    },
    results_one: '{{count}} resultado',
    results_other: '{{count}} resultados',
  },

  compose: {
    titleCompose: 'Escrever',
    titleReply: 'Responder',
    titleForward: 'Reencaminhar',
    headTitleCompose: 'Escrever · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · Escrever · Oxy',
    placeholders: {
      to: 'Destinatários',
      subject: 'Assunto',
      body: 'Escreve o email',
    },
    fields: {
      from: 'De',
      to: 'Para',
      cc: 'Cc',
      bcc: 'Bcc',
    },
    actions: {
      send: 'Enviar',
      sendNow: 'Enviar agora',
      moreSendOptions: 'Mais opções de envio',
      sendOptions: 'Opções de envio',
      scheduleSend: 'Agendar envio',
      saveDraft: 'Guardar rascunho',
      discard: 'Descartar',
    },
    saveDraftPrompt: {
      title: 'Guardar rascunho?',
      description: 'Queres guardar esta mensagem como rascunho?',
    },
    dropZone: 'Larga os ficheiros aqui para anexar',
    toast: {
      addRecipient: 'Adiciona pelo menos um destinatário.',
      invalidEmail: 'Introduz um endereço de email válido.',
      sendFailed: 'Não foi possível enviar o email. Tenta novamente.',
      scheduleFailed: 'Não foi possível agendar o envio. Tenta novamente.',
      scheduled: 'Email agendado para {{time}}',
      uploadFailed: 'Não foi possível carregar o anexo.',
      signatureFailed: 'Não foi possível carregar a assinatura.',
    },
  },

  inlineReply: {
    placeholder: 'Escreve a tua resposta…',
    forwardTo: 'Reencaminhar para:',
    replyAllTo: 'Responder a todos para:',
    replyTo: 'Responder a:',
    cc: 'Cc:',
    bcc: 'Bcc:',
    ccBccToggle: 'Cc/Bcc',
    addRecipients: 'Adicionar destinatários',
    send: 'Enviar',
    quotedPrefix: 'Em {{date}}, {{author}} escreveu:',
    forwardHeader:
      '\n\n---------- Mensagem reencaminhada ----------\nDe: {{from}}\nData: {{date}}\nAssunto: {{subject}}\nPara: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'Respostas rápidas',
  },

  ai: {
    toolbar: {
      draft: 'Esboço',
      polish: 'Polir',
      shorter: 'Mais curto',
      longer: 'Mais longo',
      tone: 'Tom',
      suggestSubject: 'Sugerir assunto',
    },
    draftModal: {
      title: 'Escrever com IA',
      subtitle: 'Descreve o que queres dizer e a Alia escreve por ti.',
      placeholder: 'p. ex., Recusa a reunião com cortesia e propõe a próxima semana',
      toneLabel: 'Tom:',
      cancel: 'Cancelar',
      draft: 'Esboço',
    },
    toneMenu: {
      title: 'Alterar o tom para…',
    },
    tones: {
      professional: 'Profissional',
      casual: 'Casual',
      friendly: 'Amigável',
      formal: 'Formal',
    },
  },

  threadSummary: {
    title: 'Resumo da conversa',
    messages_one: '{{count}} mensagem',
    messages_other: '{{count}} mensagens',
    keyPoints: 'Pontos-chave',
    actionItems: 'Ações pendentes',
    due: 'Prazo: {{date}}',
  },

  staleThread: {
    consider: 'Considera enviar uma resposta rápida',
    reply: 'Responder',
  },

  followUpReminder: {
    pastDue: 'Compromisso vencido',
    upcoming: 'Compromisso próximo',
    description: 'Disseste «{{text}}» a {{recipient}}',
    deadline: {
      dueToday: 'Vence hoje',
      overdueOneDay: 'Atrasado 1 dia',
      overdueDays: 'Atrasado {{days}} dias',
      dueTomorrow: 'Vence amanhã',
      dueInDays: 'Vence dentro de {{days}} dias',
    },
    fallbackName: 'alguém',
    view: 'Ver',
    done: 'Concluído',
  },

  reminder: {
    create: {
      title: 'Criar lembrete',
      placeholder: 'Do que queres que te lembrem?',
      whenLabel: 'Quando?',
      submit: 'Criar lembrete',
      presets: {
        laterToday: 'Mais tarde hoje',
        tomorrowMorning: 'Amanhã de manhã',
        thisWeekend: 'Este fim de semana',
        nextWeek: 'Próxima semana',
      },
    },
    time: {
      overdue: 'Atrasado · {{date}}, {{time}}',
      today: 'Hoje, {{time}}',
      tomorrow: 'Amanhã, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: 'Adiar até…',
    options: {
      laterToday: 'Mais tarde hoje',
      tomorrow: 'Amanhã',
      thisWeekend: 'Este fim de semana',
      nextWeek: 'Próxima semana',
    },
    time: {
      today: 'Hoje, {{time}}',
      tomorrow: 'Amanhã, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: 'Agendar envio',
    options: {
      laterToday: 'Mais tarde hoje',
      tomorrowMorning: 'Amanhã de manhã',
      tomorrowAfternoon: 'Amanhã à tarde',
      mondayMorning: 'Segunda de manhã',
    },
  },

  template: {
    insert: 'Inserir modelo',
  },

  selection: {
    archive: 'Arquivar',
    delete: 'Eliminar',
    star: 'Marcar com estrela',
    markRead: 'Marcar como lido',
  },

  subscriptions: {
    title: 'Subscrições',
    subtitle:
      'Após cancelar a subscrição, pode demorar alguns dias até deixares de receber mensagens',
    empty: {
      title: 'Nenhuma subscrição encontrada',
      subtitle: 'Aqui aparecerão os remetentes que te escrevem com frequência.',
    },
    unsubscribe: 'Cancelar subscrição',
    block: 'Bloquear',
    frequency: {
      twentyPlus: 'Mais de 20 emails recentes',
      tenToTwenty: '10-20 emails recentes',
      count_one: '{{count}} email recente',
      count_other: '{{count}} emails recentes',
    },
  },

  contacts: {
    searchPlaceholder: 'Pesquisar contactos…',
    addContact: 'Adicionar contacto',
    cancel: 'Cancelar',
    saveContact: 'Guardar contacto',
    save: 'Guardar',
    edit: {
      cancel: 'Cancelar',
    },
    delete: {
      title: 'Eliminar este contacto?',
      description: 'Esta ação não pode ser anulada.',
      cta: 'Eliminar',
    },
    starredFilter: 'Com estrela',
    autoCollected: 'Recolhido automaticamente',
    empty: {
      noMatch: 'Nenhum contacto corresponde à pesquisa.',
      none: 'Ainda não tens contactos.',
    },
    toast: {
      nameEmailRequired: 'Nome e email são obrigatórios.',
      created: 'Contacto criado.',
      updated: 'Contacto atualizado.',
      deleted: 'Contacto eliminado.',
    },
    form: {
      name: 'Nome *',
      email: 'Email *',
      company: 'Empresa',
      notes: 'Notas',
    },
  },

  shortcuts: {
    title: 'Atalhos de teclado',
    close: 'Fechar',
    actions: {
      compose: 'Escrever',
      reply: 'Responder',
      replyAll: 'Responder a todos',
      forward: 'Reencaminhar',
      archive: 'Arquivar',
      delete: 'Eliminar',
      nextMessage: 'Mensagem seguinte',
      previousMessage: 'Mensagem anterior',
      starUnstar: 'Marcar / remover estrela',
      markUnread: 'Marcar como não lido',
      search: 'Pesquisar',
      help: 'Esta ajuda',
    },
  },

  cards: {
    purchase: {
      header: 'Compra',
      order: 'Encomenda n.º',
      moreItems: '+{{count}} mais',
      summary: 'Detalhes da compra',
    },
    bill: {
      header: 'Fatura',
      account: 'Conta',
      due: 'Vence em {{date}}',
      overdue: 'Vencida · {{date}}',
      summary: 'Detalhes da fatura',
    },
    trip: {
      header: 'Viagem',
      confirmation: 'Confirmação',
      summary: 'Detalhes da viagem',
    },
    package: {
      header: 'Encomenda',
      tracking: 'Rastreio',
      estimated: 'Est. {{date}}',
      summary: 'Detalhes da encomenda',
    },
    event: {
      header: 'Evento',
      addToCalendar: 'Adicionar ao calendário',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'Adicionar ao calendário',
      defaultTitle: 'Evento',
      summary: 'Detalhes do evento',
    },
  },

  importance: {
    urgent: 'Urgente',
    action: 'Requer ação',
    important: 'Importante',
    fyi: 'Para a tua informação',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: 'Definições · Inbox · Oxy',
    title: 'Definições',
  },

  auth: {
    gate: {
      title: 'Inicia sessão para aceder à tua caixa',
      subtitle:
        'Liga a tua identidade Oxy para sincronizar mensagens, etiquetas e preferências em todos os dispositivos.',
      footer:
        'Ao iniciar sessão aceitas os nossos Termos e reconheces a nossa Política de Privacidade.',
    },
  },
};

export default pt;
