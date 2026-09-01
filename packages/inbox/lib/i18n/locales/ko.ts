import type { LocaleDict } from '../types';

/**
 * Korean (ko-KR) translation dictionary for the Inbox app.
 *
 * Tone: polite 해요체 — matches the rest of the Oxy ecosystem.
 */
const ko: LocaleDict = {
  common: {
    cancel: '취소',
    save: '저장',
    ok: '확인',
    continue: '계속',
    back: '뒤로',
    next: '다음',
    done: '완료',
    close: '닫기',
    loading: '불러오는 중…',
    error: '오류',
    success: '완료',
    retry: '다시 시도',
    delete: '삭제',
    edit: '편집',
    remove: '제거',
    confirm: '확인',
    submit: '제출',
    search: '검색',
    yes: '예',
    no: '아니요',
    or: '또는',
    and: '그리고',
    open: '열기',
    discard: '폐기',
    of: '/',
    more: '더 보기',
    less: '접기',
  },

  app: {
    name: 'Inbox',
    title: 'Oxy Inbox',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: '받은편지함',
    search: '검색',
    settings: '설정',
  },

  drawer: {
    starred: '별표',
    snoozed: '다시 알림',
    subscriptions: '구독',
    labels: '라벨',
    more: '더 보기',
    less: '접기',
    notSignedIn: '로그인하지 않음',
    accountSwitcher: '계정 전환',
    addAnotherAccount: '다른 계정 추가',
    signOut: '로그아웃',
    switchAccount: '계정 전환, {{name}}(으)로 로그인됨',
    switchingAccount: '계정을 전환하는 중…',
    expandSidebar: '사이드바 펼치기',
    collapseSidebar: '사이드바 접기',
    signedOut: {
      title: '메일을 관리하려면 로그인하세요',
      subtitle: '메일함과 라벨에 접근하고 새 메시지를 작성하세요.',
    },
    mailboxes: {
      Inbox: '받은편지함',
      Sent: '보낸편지함',
      Drafts: '임시보관함',
      Trash: '휴지통',
      Spam: '스팸',
      Archive: '보관함',
      Starred: '별표',
      Snoozed: '다시 알림',
    },
    mailboxA11y: '{{name}}, 읽지 않음 {{count}}개',
  },

  home: {
    greeting: {
      morning: '좋은 아침이에요',
      afternoon: '안녕하세요',
      evening: '좋은 저녁이에요',
      withName: '{{greeting}}, {{name}}님',
    },
    todaysBrief: '오늘의 요약',
    openMenu: '메뉴 열기',
    jumpToToday: '오늘로 이동',
    previousWeek: '이전 주',
    nextWeek: '다음 주',
    regenerateBrief: '요약 다시 만들기',
    inboxSection: '받은편지함',
    needsResponse: '답장 필요',
    followUp: '후속 조치',
    needsResponseA11y_one: '답장 필요, 메일 {{count}}개',
    needsResponseA11y_other: '답장 필요, 메일 {{count}}개',
    followUpA11y_one: '후속 조치, 메일 {{count}}개',
    followUpA11y_other: '후속 조치, 메일 {{count}}개',
    days: {
      sun: '일',
      mon: '월',
      tue: '화',
      wed: '수',
      thu: '목',
      fri: '금',
      sat: '토',
    },
    stats: {
      unread: '읽지 않음 {{count}}',
      starred: '별표 {{count}}',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia가 받은편지함을 분석하고 있어요…',
      unavailable: '지금은 요약을 만들 수 없어요.',
      empty: '아직 요약할 메일이 없어요.',
    },
    feedEmpty: {
      title: '모두 처리됨',
      subtitle: '받은편지함에 새로운 내용이 없어요.',
    },
    signedOut: {
      subtitle:
        '로그인하면 일일 요약, 답장이 필요한 메일, 후속 조치 항목을 볼 수 있어요.',
    },
  },


  inbox: {
    title: '받은편지함',
    starredTitle: '별표',
    searchInMailbox: '{{mailbox}}에서 검색',
    emptyTitle: '아무것도 없어요',
    emptyAllCaught: '모두 확인했어요.',
    emptySignIn: '메일을 보려면 로그인하세요.',
    pagination: '{{from}}–{{to}} / {{total}}',
    remind: '리마인더',
    bundled: '묶음',
    flat: '목록',
    composeFab: '새 메일 작성',
    composeFabLabel: '작성',
    askAlia: 'Alia에게 물어보기',
    askAliaHint: 'AI 어시스턴트 Alia를 열어 받은편지함에 대해 질문할 수 있어요',
    sections: {
      reminders: '리마인더',
      pinned: '고정됨',
      today: '오늘',
      yesterday: '어제',
      thisWeek: '이번 주',
      thisMonth: '이번 달',
      earlier: '이전',
    },
    aliaSuggestions: {
      unread: {
        label: '읽지 않은 메일',
        prompt: '어떤 메일에 주의를 기울여야 할까요?',
      },
      todaysSummary: {
        label: '오늘의 요약',
        prompt: '오늘의 메일을 요약해 주세요',
      },
      withAttachments: {
        label: '첨부 있음',
        prompt: '첨부 파일이 있는 메일 찾기',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: '보관함 폴더를 사용할 수 없어요.',
      trashUnavailable: '휴지통 폴더를 사용할 수 없어요.',
      offlineSync_one: '오프라인 작업 {{count}}개를 동기화했어요.',
      offlineSync_other: '오프라인 작업 {{count}}개를 동기화했어요.',
      newVersionAvailable: '새 버전이 있어요 — 새로고침해서 업데이트하세요.',
      newEmail: '{{sender}}님의 새 메일',
    },
  },

  message: {
    detail: {
      noSubject: '(제목 없음)',
      emptyMessage: '(빈 메시지)',
      messagesInConversation_one: '이 대화의 메시지 {{count}}개',
      messagesInConversation_other: '이 대화의 메시지 {{count}}개',
      toRecipients: '받는 사람: {{recipients}}',
      ccRecipients: ', cc: {{recipients}}',
    },
    actions: {
      archive: '보관',
      delete: '삭제',
      markUnread: '읽지 않음으로 표시',
      markRead: '읽음으로 표시',
      reply: '답장',
      replyAll: '전체 답장',
      forward: '전달',
      pin: '메시지 고정',
      unpin: '고정 해제',
      star: '별표 표시',
      unstar: '별표 해제',
      snooze: '다시 알림',
      print: '인쇄',
      more: '더 많은 작업',
      moreInline: '더 보기',
      reportSpam: '스팸 신고',
      label: '라벨',
      downloadEml: '.eml 다운로드',
      messageActions: '메시지 작업',
    },
    labelPicker: {
      title: '라벨',
      empty: '아직 라벨이 없어요',
    },
    toast: {
      attachmentFailed: '첨부 파일을 다운로드하지 못했어요.',
      fileSystemUnavailable: '이 기기에서 파일 시스템을 사용할 수 없어요.',
      sharingUnavailable: '이 기기에서 공유를 사용할 수 없어요.',
      printFailed: '메일을 인쇄하지 못했어요.',
      downloadFailed: '메일을 다운로드하지 못했어요.',
      saveEmailDialog: '메일 저장',
    },
  },

  empty: {
    selectConversation: '대화를 선택하세요',
    nothingHere: '아무것도 없어요',
  },

  notFound: {
    title:
      '대화를 찾을 수 없어요. 이동, 보관 또는 삭제되었을 수 있어요.',
    back: '받은편지함으로 돌아가기',
  },

  search: {
    placeholder: '메일 검색',
    clear: '검색 지우기',
    openMenu: '메뉴 열기',
    goBack: '뒤로',
    filters: {
      from: '보낸 사람',
      fromValue: '보낸 사람: {{value}}',
      hasAttachment: '첨부 있음',
    },
    nl: {
      understanding: '검색을 해석하는 중…',
      searching: '검색: {{filters}}',
      allEmails: '모든 메일',
      fromValue: '{{value}}에게서',
      toValue: '{{value}}에게',
      subjectContains: '제목에 "{{value}}" 포함',
      withAttachments: '첨부 있음',
      starred: '별표',
      unread: '읽지 않음',
      read: '읽음',
    },
    empty: {
      noResults: '결과를 찾을 수 없어요',
      idle: '메일을 검색해 보세요',
    },
    results_one: '결과 {{count}}개',
    results_other: '결과 {{count}}개',
  },

  compose: {
    titleCompose: '작성',
    titleReply: '답장',
    titleForward: '전달',
    headTitleCompose: '작성 · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · 작성 · Oxy',
    placeholders: {
      to: '받는 사람',
      subject: '제목',
      body: '메일 작성',
    },
    fields: {
      from: '보낸 사람',
      to: '받는 사람',
      cc: '참조',
      bcc: '숨은참조',
    },
    actions: {
      send: '보내기',
      sendNow: '지금 보내기',
      moreSendOptions: '더 많은 전송 옵션',
      sendOptions: '전송 옵션',
      scheduleSend: '예약 전송',
      saveDraft: '임시 저장',
      discard: '폐기',
    },
    saveDraftPrompt: {
      title: '임시 저장하시겠어요?',
      description: '이 메시지를 임시 저장할까요?',
    },
    dropZone: '파일을 끌어다 놓으면 첨부됩니다',
    toast: {
      addRecipient: '받는 사람을 한 명 이상 추가하세요.',
      invalidEmail: '유효한 이메일 주소를 입력하세요.',
      sendFailed: '메일을 보내지 못했어요. 다시 시도해 주세요.',
      scheduleFailed: '메일 예약에 실패했어요. 다시 시도해 주세요.',
      scheduled: '{{time}}에 메일이 예약되었어요',
      uploadFailed: '첨부 파일을 업로드하지 못했어요.',
      signatureFailed: '서명을 불러오지 못했어요.',
    },
  },

  inlineReply: {
    placeholder: '답장을 입력하세요…',
    forwardTo: '전달:',
    replyAllTo: '전체 답장:',
    replyTo: '답장:',
    cc: '참조:',
    bcc: '숨은참조:',
    ccBccToggle: '참조/숨은참조',
    addRecipients: '받는 사람 추가',
    send: '보내기',
    quotedPrefix: '{{date}}, {{author}}님이 작성:',
    forwardHeader:
      '\n\n---------- 전달된 메시지 ----------\n보낸 사람: {{from}}\n날짜: {{date}}\n제목: {{subject}}\n받는 사람: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: '빠른 답장',
  },

  ai: {
    toolbar: {
      draft: '초안',
      polish: '다듬기',
      shorter: '짧게',
      longer: '길게',
      tone: '톤',
      suggestSubject: '제목 제안',
    },
    draftModal: {
      title: 'AI로 작성',
      subtitle: '하고 싶은 말을 알려주시면 Alia가 초안을 작성해 드려요.',
      placeholder: '예: 회의를 정중히 거절하고 다음 주를 제안',
      toneLabel: '톤:',
      cancel: '취소',
      draft: '초안',
    },
    toneMenu: {
      title: '톤 변경…',
    },
    tones: {
      professional: '전문적',
      casual: '캐주얼',
      friendly: '친근함',
      formal: '격식',
    },
  },

  threadSummary: {
    title: '대화 요약',
    messages_one: '메시지 {{count}}개',
    messages_other: '메시지 {{count}}개',
    keyPoints: '핵심 내용',
    actionItems: '실행 항목',
    due: '기한: {{date}}',
  },

  staleThread: {
    consider: '짧은 답장을 보내 보세요',
    reply: '답장',
  },

  followUpReminder: {
    pastDue: '기한이 지난 약속',
    upcoming: '다가오는 약속',
    description: '{{recipient}}에게 "{{text}}"라고 말했어요',
    deadline: {
      dueToday: '오늘 마감',
      overdueOneDay: '1일 지남',
      overdueDays: '{{days}}일 지남',
      dueTomorrow: '내일 마감',
      dueInDays: '{{days}}일 후 마감',
    },
    fallbackName: '누군가',
    view: '보기',
    done: '완료',
  },

  reminder: {
    create: {
      title: '리마인더 만들기',
      placeholder: '무엇을 다시 알려드릴까요?',
      whenLabel: '언제?',
      submit: '리마인더 만들기',
      presets: {
        laterToday: '오늘 늦게',
        tomorrowMorning: '내일 아침',
        thisWeekend: '이번 주말',
        nextWeek: '다음 주',
      },
    },
    time: {
      overdue: '지남 · {{date}}, {{time}}',
      today: '오늘, {{time}}',
      tomorrow: '내일, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  snooze: {
    title: '다시 알림…',
    options: {
      laterToday: '오늘 늦게',
      tomorrow: '내일',
      thisWeekend: '이번 주말',
      nextWeek: '다음 주',
    },
    time: {
      today: '오늘, {{time}}',
      tomorrow: '내일, {{time}}',
      onDate: '{{date}}, {{time}}',
    },
  },

  schedule: {
    title: '예약 전송',
    options: {
      laterToday: '오늘 늦게',
      tomorrowMorning: '내일 아침',
      tomorrowAfternoon: '내일 오후',
      mondayMorning: '월요일 아침',
    },
  },

  template: {
    insert: '템플릿 삽입',
  },

  selection: {
    archive: '보관',
    delete: '삭제',
    star: '별표',
    markRead: '읽음으로 표시',
  },

  subscriptions: {
    title: '구독',
    subtitle:
      '구독을 취소해도 메시지가 더 이상 도착하지 않기까지 며칠이 걸릴 수 있어요',
    empty: {
      title: '구독을 찾을 수 없어요',
      subtitle: '자주 메일을 보내는 발신자가 여기에 표시돼요.',
    },
    unsubscribe: '구독 취소',
    block: '차단',
    frequency: {
      twentyPlus: '최근 20개 이상',
      tenToTwenty: '최근 10-20개',
      count_one: '최근 {{count}}개',
      count_other: '최근 {{count}}개',
    },
  },

  contacts: {
    searchPlaceholder: '연락처 검색…',
    addContact: '연락처 추가',
    cancel: '취소',
    saveContact: '연락처 저장',
    save: '저장',
    edit: {
      cancel: '취소',
    },
    delete: {
      title: '이 연락처를 삭제할까요?',
      description: '이 작업은 되돌릴 수 없어요.',
      cta: '삭제',
    },
    starredFilter: '별표',
    autoCollected: '자동 수집',
    empty: {
      noMatch: '검색에 일치하는 연락처가 없어요.',
      none: '아직 연락처가 없어요.',
    },
    toast: {
      nameEmailRequired: '이름과 이메일이 필요해요.',
      created: '연락처를 만들었어요.',
      updated: '연락처를 업데이트했어요.',
      deleted: '연락처를 삭제했어요.',
    },
    form: {
      name: '이름 *',
      email: '이메일 *',
      company: '회사',
      notes: '메모',
    },
  },

  shortcuts: {
    title: '키보드 단축키',
    close: '닫기',
    actions: {
      compose: '작성',
      reply: '답장',
      replyAll: '전체 답장',
      forward: '전달',
      archive: '보관',
      delete: '삭제',
      nextMessage: '다음 메시지',
      previousMessage: '이전 메시지',
      starUnstar: '별표 / 해제',
      markUnread: '읽지 않음으로 표시',
      search: '검색',
      help: '이 도움말',
    },
  },

  cards: {
    purchase: {
      header: '구매',
      order: '주문 번호',
      moreItems: '+{{count}}개 더',
      summary: '구매 상세',
    },
    bill: {
      header: '청구',
      account: '계정',
      due: '{{date}} 마감',
      overdue: '연체 · {{date}}',
      summary: '청구 상세',
    },
    trip: {
      header: '여행',
      confirmation: '확인',
      summary: '여행 상세',
    },
    package: {
      header: '배송',
      tracking: '추적',
      estimated: '예정 {{date}}',
      summary: '배송 상세',
    },
    event: {
      header: '이벤트',
      addToCalendar: '캘린더에 추가',
      googleCalendar: 'Google 캘린더',
      addToCalendarDialog: '캘린더에 추가',
      defaultTitle: '이벤트',
      summary: '이벤트 상세',
    },
  },

  importance: {
    urgent: '긴급',
    action: '조치 필요',
    important: '중요',
    fyi: '참고',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: '설정 · Inbox · Oxy',
    title: '설정',
  },

  auth: {
    gate: {
      title: '로그인해서 받은편지함에 접근하세요',
      subtitle:
        'Oxy ID를 연결해 모든 기기에서 메시지, 라벨, 환경설정을 동기화하세요.',
      footer:
        '로그인하면 이용 약관에 동의하고 개인정보 보호 정책을 확인한 것으로 간주됩니다.',
    },
  },
};

export default ko;
