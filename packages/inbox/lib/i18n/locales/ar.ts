import type { LocaleDict } from '../types';

/**
 * Arabic (ar-SA) translation dictionary for the Inbox app.
 *
 * Note: Arabic is right-to-left. RTL layout is wired in the app root via
 * `I18nManager.allowRTL(true)` and a `forceRTL` toggle on locale change.
 */
const ar: LocaleDict = {
  common: {
    cancel: 'إلغاء',
    save: 'حفظ',
    ok: 'حسناً',
    continue: 'متابعة',
    back: 'رجوع',
    next: 'التالي',
    done: 'تم',
    close: 'إغلاق',
    loading: 'جارٍ التحميل…',
    error: 'خطأ',
    success: 'تم',
    retry: 'إعادة المحاولة',
    delete: 'حذف',
    edit: 'تعديل',
    remove: 'إزالة',
    confirm: 'تأكيد',
    submit: 'إرسال',
    search: 'بحث',
    yes: 'نعم',
    no: 'لا',
    or: 'أو',
    and: 'و',
    open: 'فتح',
    discard: 'تجاهل',
    of: 'من',
    more: 'المزيد',
    less: 'أقل',
  },

  app: {
    name: 'Inbox',
    title: 'Inbox من Oxy',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: 'البريد الوارد',
    search: 'بحث',
    settings: 'الإعدادات',
  },

  drawer: {
    starred: 'المميّزة',
    snoozed: 'مؤجَّلة',
    subscriptions: 'الاشتراكات',
    labels: 'التصنيفات',
    more: 'المزيد',
    less: 'أقل',
    notSignedIn: 'لم يتم تسجيل الدخول',
    accountSwitcher: 'مبدّل الحسابات',
    addAnotherAccount: 'إضافة حساب آخر',
    signOut: 'تسجيل الخروج',
    switchAccount: 'تبديل الحساب، مسجّل دخول كـ {{name}}',
    switchingAccount: 'جارٍ تبديل الحساب…',
    expandSidebar: 'توسيع الشريط الجانبي',
    collapseSidebar: 'طي الشريط الجانبي',
    signedOut: {
      title: 'سجّل الدخول لإدارة بريدك',
      subtitle: 'استعرض صناديق البريد والتصنيفات وأنشئ رسائل جديدة.',
    },
    mailboxes: {
      Inbox: 'البريد الوارد',
      Sent: 'المرسلة',
      Drafts: 'المسوّدات',
      Trash: 'المهملات',
      Spam: 'البريد المزعج',
      Archive: 'الأرشيف',
      Starred: 'المميّزة',
      Snoozed: 'مؤجَّلة',
    },
    mailboxA11y: '{{name}}، {{count}} غير مقروءة',
  },

  home: {
    greeting: {
      morning: 'صباح الخير',
      afternoon: 'مساء الخير',
      evening: 'مساء الخير',
      withName: '{{greeting}}، {{name}}',
    },
    todaysBrief: 'ملخّص اليوم',
    openMenu: 'فتح القائمة',
    jumpToToday: 'الانتقال إلى اليوم',
    previousWeek: 'الأسبوع السابق',
    nextWeek: 'الأسبوع التالي',
    regenerateBrief: 'إعادة إنشاء الملخّص',
    inboxSection: 'البريد الوارد',
    needsResponse: 'يحتاج إلى رد',
    followUp: 'متابعة',
    needsResponseA11y_one: 'يحتاج إلى رد، {{count}} رسالة',
    needsResponseA11y_other: 'يحتاج إلى رد، {{count}} رسائل',
    followUpA11y_one: 'متابعة، {{count}} رسالة',
    followUpA11y_other: 'متابعة، {{count}} رسائل',
    days: {
      sun: 'الأحد',
      mon: 'الإثنين',
      tue: 'الثلاثاء',
      wed: 'الأربعاء',
      thu: 'الخميس',
      fri: 'الجمعة',
      sat: 'السبت',
    },
    stats: {
      unread: '{{count}} غير مقروءة',
      starred: '{{count}} مميّزة',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'تقوم Alia بتحليل بريدك الوارد…',
      unavailable: 'تعذّر إنشاء الملخّص الآن.',
      empty: 'لا توجد رسائل للتلخيص بعد.',
    },
    feedEmpty: {
      title: 'تم تحديث كل شيء',
      subtitle: 'لا جديد في بريدك.',
    },
    signedOut: {
      subtitle:
        'سجّل الدخول لرؤية ملخّصك اليومي والرسائل التي تحتاج إلى رد والمتابعات.',
    },
  },


  inbox: {
    title: 'البريد الوارد',
    starredTitle: 'المميّزة',
    searchInMailbox: 'البحث في {{mailbox}}',
    emptyTitle: 'لا شيء هنا',
    emptyAllCaught: 'لقد قرأت كل شيء.',
    emptySignIn: 'سجّل الدخول للوصول إلى بريدك.',
    pagination: '{{from}}–{{to}} من {{total}}',
    remind: 'تذكير',
    bundled: 'مجمّعة',
    flat: 'قائمة',
    composeFab: 'كتابة رسالة جديدة',
    composeFabLabel: 'كتابة',
    askAlia: 'اسأل Alia',
    askAliaHint: 'يفتح المساعد الذكي Alia لطرح أسئلة حول بريدك',
    sections: {
      reminders: 'التذكيرات',
      pinned: 'المثبَّتة',
      today: 'اليوم',
      yesterday: 'أمس',
      thisWeek: 'هذا الأسبوع',
      thisMonth: 'هذا الشهر',
      earlier: 'سابقاً',
    },
    aliaSuggestions: {
      unread: {
        label: 'الرسائل غير المقروءة',
        prompt: 'أيّ الرسائل تحتاج إلى اهتمامي؟',
      },
      todaysSummary: {
        label: 'ملخّص اليوم',
        prompt: 'لخّص رسائلي اليوم',
      },
      withAttachments: {
        label: 'مع مرفقات',
        prompt: 'ابحث عن الرسائل التي تحتوي على مرفقات',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'مجلد الأرشيف غير متاح.',
      trashUnavailable: 'مجلد المهملات غير متاح.',
      offlineSync_one: 'تمت مزامنة {{count}} إجراء دون اتصال.',
      offlineSync_other: 'تمت مزامنة {{count}} إجراءات دون اتصال.',
      newVersionAvailable: 'تتوفّر نسخة جديدة — أعد التحميل للتحديث.',
      newEmail: 'رسالة جديدة من {{sender}}',
    },
  },

  message: {
    detail: {
      noSubject: '(بدون موضوع)',
      emptyMessage: '(رسالة فارغة)',
      messagesInConversation_one: '{{count}} رسالة في هذه المحادثة',
      messagesInConversation_other: '{{count}} رسائل في هذه المحادثة',
      toRecipients: 'إلى {{recipients}}',
      ccRecipients: '، نسخة: {{recipients}}',
    },
    actions: {
      archive: 'أرشفة',
      delete: 'حذف',
      markUnread: 'تحديد كغير مقروءة',
      markRead: 'تحديد كمقروءة',
      reply: 'رد',
      replyAll: 'الرد على الجميع',
      forward: 'إعادة توجيه',
      pin: 'تثبيت الرسالة',
      unpin: 'إلغاء التثبيت',
      star: 'تمييز الرسالة',
      unstar: 'إزالة التمييز',
      snooze: 'تأجيل',
      print: 'طباعة',
      more: 'مزيد من الإجراءات',
      moreInline: 'المزيد',
      reportSpam: 'الإبلاغ كبريد مزعج',
      label: 'تصنيف',
      downloadEml: 'تنزيل .eml',
      messageActions: 'إجراءات الرسالة',
    },
    labelPicker: {
      title: 'التصنيفات',
      empty: 'لا توجد تصنيفات بعد',
    },
    toast: {
      attachmentFailed: 'تعذّر تنزيل المرفق.',
      fileSystemUnavailable: 'نظام الملفات غير متاح على هذا الجهاز.',
      sharingUnavailable: 'المشاركة غير متاحة على هذا الجهاز.',
      printFailed: 'فشلت طباعة الرسالة.',
      downloadFailed: 'فشل تنزيل الرسالة.',
      saveEmailDialog: 'حفظ الرسالة',
    },
  },

  empty: {
    selectConversation: 'اختر محادثة',
    nothingHere: 'لا شيء هنا',
  },

  notFound: {
    title:
      'تعذّر العثور على هذه المحادثة. ربما تم نقلها أو أرشفتها أو حذفها.',
    back: 'العودة إلى البريد الوارد',
  },

  search: {
    placeholder: 'البحث في البريد',
    clear: 'مسح البحث',
    openMenu: 'فتح القائمة',
    goBack: 'رجوع',
    filters: {
      from: 'من',
      fromValue: 'من: {{value}}',
      hasAttachment: 'يحتوي على مرفق',
    },
    nl: {
      understanding: 'جارٍ فهم البحث…',
      searching: 'البحث: {{filters}}',
      allEmails: 'جميع الرسائل',
      fromValue: 'من {{value}}',
      toValue: 'إلى {{value}}',
      subjectContains: 'الموضوع يحتوي على "{{value}}"',
      withAttachments: 'مع مرفقات',
      starred: 'المميّزة',
      unread: 'غير المقروءة',
      read: 'المقروءة',
    },
    empty: {
      noResults: 'لم يتم العثور على نتائج',
      idle: 'ابحث في بريدك',
    },
    results_one: '{{count}} نتيجة',
    results_other: '{{count}} نتائج',
  },

  compose: {
    titleCompose: 'كتابة',
    titleReply: 'رد',
    titleForward: 'إعادة توجيه',
    headTitleCompose: 'كتابة · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · كتابة · Oxy',
    placeholders: {
      to: 'المستلمون',
      subject: 'الموضوع',
      body: 'اكتب الرسالة',
    },
    fields: {
      from: 'من',
      to: 'إلى',
      cc: 'نسخة',
      bcc: 'نسخة مخفية',
    },
    actions: {
      send: 'إرسال',
      sendNow: 'إرسال الآن',
      moreSendOptions: 'مزيد من خيارات الإرسال',
      sendOptions: 'خيارات الإرسال',
      scheduleSend: 'جدولة الإرسال',
      saveDraft: 'حفظ كمسودة',
      discard: 'تجاهل',
    },
    saveDraftPrompt: {
      title: 'حفظ المسودة؟',
      description: 'هل تريد حفظ هذه الرسالة كمسودة؟',
    },
    dropZone: 'أفلت الملفات هنا للإرفاق',
    toast: {
      addRecipient: 'أضف مستلمًا واحدًا على الأقل.',
      invalidEmail: 'أدخل عنوان بريد إلكتروني صالحًا.',
      sendFailed: 'تعذّر إرسال الرسالة. حاول مرة أخرى.',
      scheduleFailed: 'تعذّر جدولة الرسالة. حاول مرة أخرى.',
      scheduled: 'الرسالة مجدولة في {{time}}',
      uploadFailed: 'تعذّر رفع المرفق.',
      signatureFailed: 'تعذّر تحميل التوقيع.',
    },
  },

  inlineReply: {
    placeholder: 'اكتب ردك…',
    forwardTo: 'إعادة توجيه إلى:',
    replyAllTo: 'الرد على الجميع إلى:',
    replyTo: 'الرد إلى:',
    cc: 'نسخة:',
    bcc: 'نسخة مخفية:',
    ccBccToggle: 'نسخة/نسخة مخفية',
    addRecipients: 'إضافة مستلمين',
    send: 'إرسال',
    quotedPrefix: 'في {{date}}، كتب {{author}}:',
    forwardHeader:
      '\n\n---------- رسالة معادة التوجيه ----------\nمن: {{from}}\nالتاريخ: {{date}}\nالموضوع: {{subject}}\nإلى: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'ردود سريعة',
  },

  ai: {
    toolbar: {
      draft: 'مسودة',
      polish: 'تحسين',
      shorter: 'أقصر',
      longer: 'أطول',
      tone: 'الأسلوب',
      suggestSubject: 'اقترح موضوعًا',
    },
    draftModal: {
      title: 'الكتابة بمساعدة الذكاء الاصطناعي',
      subtitle: 'صف ما تريد قوله وستقوم Alia بصياغته من أجلك.',
      placeholder: 'مثال: رفض الاجتماع بأدب واقتراح الأسبوع القادم بدلاً منه',
      toneLabel: 'الأسلوب:',
      cancel: 'إلغاء',
      draft: 'مسودة',
    },
    toneMenu: {
      title: 'تغيير الأسلوب إلى…',
    },
    tones: {
      professional: 'مهني',
      casual: 'غير رسمي',
      friendly: 'ودّي',
      formal: 'رسمي',
    },
  },

  threadSummary: {
    title: 'ملخّص المحادثة',
    messages_one: '{{count}} رسالة',
    messages_other: '{{count}} رسائل',
    keyPoints: 'النقاط الرئيسية',
    actionItems: 'بنود التنفيذ',
    due: 'الموعد: {{date}}',
  },

  staleThread: {
    consider: 'فكّر في إرسال رد سريع',
    reply: 'رد',
  },

  followUpReminder: {
    pastDue: 'التزام فات موعده',
    upcoming: 'التزام قادم',
    description: 'لقد قلت "{{text}}" لـ {{recipient}}',
    deadline: {
      dueToday: 'الموعد اليوم',
      overdueOneDay: 'متأخّر بيوم واحد',
      overdueDays: 'متأخّر بـ {{days}} أيام',
      dueTomorrow: 'الموعد غدًا',
      dueInDays: 'الموعد خلال {{days}} أيام',
    },
    fallbackName: 'شخص ما',
    view: 'عرض',
    done: 'تم',
  },

  reminder: {
    create: {
      title: 'إنشاء تذكير',
      placeholder: 'بماذا تريد أن نذكّرك؟',
      whenLabel: 'متى؟',
      submit: 'إنشاء تذكير',
      presets: {
        laterToday: 'لاحقًا اليوم',
        tomorrowMorning: 'صباح الغد',
        thisWeekend: 'نهاية الأسبوع',
        nextWeek: 'الأسبوع القادم',
      },
    },
    time: {
      overdue: 'فات موعده · {{date}}، {{time}}',
      today: 'اليوم، {{time}}',
      tomorrow: 'غدًا، {{time}}',
      onDate: '{{date}}، {{time}}',
    },
  },

  snooze: {
    title: 'تأجيل حتى…',
    options: {
      laterToday: 'لاحقًا اليوم',
      tomorrow: 'غدًا',
      thisWeekend: 'نهاية الأسبوع',
      nextWeek: 'الأسبوع القادم',
    },
    time: {
      today: 'اليوم، {{time}}',
      tomorrow: 'غدًا، {{time}}',
      onDate: '{{date}}، {{time}}',
    },
  },

  schedule: {
    title: 'جدولة الإرسال',
    options: {
      laterToday: 'لاحقًا اليوم',
      tomorrowMorning: 'صباح الغد',
      tomorrowAfternoon: 'بعد ظهر الغد',
      mondayMorning: 'صباح الإثنين',
    },
  },

  template: {
    insert: 'إدراج قالب',
  },

  selection: {
    archive: 'أرشفة',
    delete: 'حذف',
    star: 'تمييز',
    markRead: 'تحديد كمقروءة',
  },

  subscriptions: {
    title: 'الاشتراكات',
    subtitle:
      'بعد إلغاء الاشتراك، قد يستغرق الأمر بضعة أيام للتوقف عن استلام الرسائل',
    empty: {
      title: 'لم يتم العثور على اشتراكات',
      subtitle: 'سيظهر هنا المرسلون الذين يراسلونك بشكل متكرر.',
    },
    unsubscribe: 'إلغاء الاشتراك',
    block: 'حظر',
    frequency: {
      twentyPlus: 'أكثر من 20 رسالة مؤخراً',
      tenToTwenty: '10-20 رسالة مؤخراً',
      count_one: '{{count}} رسالة مؤخراً',
      count_other: '{{count}} رسائل مؤخراً',
    },
  },

  contacts: {
    searchPlaceholder: 'البحث في جهات الاتصال…',
    addContact: 'إضافة جهة اتصال',
    cancel: 'إلغاء',
    saveContact: 'حفظ جهة الاتصال',
    save: 'حفظ',
    edit: {
      cancel: 'إلغاء',
    },
    delete: {
      title: 'حذف جهة الاتصال هذه؟',
      description: 'لا يمكن التراجع عن هذا الإجراء.',
      cta: 'حذف',
    },
    starredFilter: 'المميّزة',
    autoCollected: 'تم جمعها تلقائياً',
    empty: {
      noMatch: 'لا توجد جهات اتصال تطابق البحث.',
      none: 'لا توجد جهات اتصال بعد.',
    },
    toast: {
      nameEmailRequired: 'الاسم والبريد الإلكتروني مطلوبان.',
      created: 'تم إنشاء جهة الاتصال.',
      updated: 'تم تحديث جهة الاتصال.',
      deleted: 'تم حذف جهة الاتصال.',
    },
    form: {
      name: 'الاسم *',
      email: 'البريد الإلكتروني *',
      company: 'الشركة',
      notes: 'ملاحظات',
    },
  },

  shortcuts: {
    title: 'اختصارات لوحة المفاتيح',
    close: 'إغلاق',
    actions: {
      compose: 'كتابة',
      reply: 'رد',
      replyAll: 'الرد على الجميع',
      forward: 'إعادة توجيه',
      archive: 'أرشفة',
      delete: 'حذف',
      nextMessage: 'الرسالة التالية',
      previousMessage: 'الرسالة السابقة',
      starUnstar: 'تمييز / إزالة',
      markUnread: 'تحديد كغير مقروءة',
      search: 'بحث',
      help: 'هذه المساعدة',
    },
  },

  cards: {
    purchase: {
      header: 'شراء',
      order: 'طلب رقم',
      moreItems: '+{{count}} أخرى',
      summary: 'تفاصيل الشراء',
    },
    bill: {
      header: 'فاتورة',
      account: 'الحساب',
      due: 'موعد الاستحقاق {{date}}',
      overdue: 'متأخرة · {{date}}',
      summary: 'تفاصيل الفاتورة',
    },
    trip: {
      header: 'رحلة',
      confirmation: 'التأكيد',
      summary: 'تفاصيل الرحلة',
    },
    package: {
      header: 'طرد',
      tracking: 'التتبّع',
      estimated: 'متوقّع {{date}}',
      summary: 'تفاصيل الطرد',
    },
    event: {
      header: 'فعالية',
      addToCalendar: 'إضافة إلى التقويم',
      googleCalendar: 'Google Calendar',
      addToCalendarDialog: 'إضافة إلى التقويم',
      defaultTitle: 'فعالية',
      summary: 'تفاصيل الفعالية',
    },
  },

  importance: {
    urgent: 'عاجل',
    action: 'يتطلّب إجراءً',
    important: 'مهم',
    fyi: 'للعلم',
  },

  attachment: {
    sizeBytes: '{{value}} بايت',
    sizeKb: '{{value}} ك.ب',
    sizeMb: '{{value}} م.ب',
  },

  settings: {
    head: 'الإعدادات · Inbox · Oxy',
    title: 'الإعدادات',
  },

  auth: {
    gate: {
      title: 'سجّل الدخول للوصول إلى بريدك الوارد',
      subtitle:
        'اربط هوية Oxy الخاصة بك لمزامنة الرسائل والتصنيفات والتفضيلات عبر كل أجهزتك.',
      footer:
        'بتسجيل الدخول، فإنك توافق على شروطنا وتقرّ بسياسة الخصوصية لدينا.',
    },
  },
};

export default ar;
