import type { LocaleDict } from '../types';

/**
 * Japanese (ja-JP) translation dictionary for the Inbox app.
 *
 * Tone: polite, modern Japanese — matches the rest of the Oxy ecosystem.
 */
const ja: LocaleDict = {
  common: {
    cancel: 'キャンセル',
    save: '保存',
    ok: 'OK',
    continue: '続ける',
    back: '戻る',
    next: '次へ',
    done: '完了',
    close: '閉じる',
    loading: '読み込み中…',
    error: 'エラー',
    success: '完了',
    retry: '再試行',
    delete: '削除',
    edit: '編集',
    remove: '削除',
    confirm: '確認',
    submit: '送信',
    search: '検索',
    yes: 'はい',
    no: 'いいえ',
    or: 'または',
    and: 'および',
    open: '開く',
    discard: '破棄',
    of: '/',
    more: 'もっと見る',
    less: '折りたたむ',
  },

  app: {
    name: 'Inbox',
    title: 'Oxy Inbox',
    titleSuffix: '· Oxy',
  },

  tabs: {
    inbox: '受信箱',
    search: '検索',
    settings: '設定',
  },

  drawer: {
    starred: 'スター付き',
    snoozed: 'スヌーズ中',
    subscriptions: '購読',
    labels: 'ラベル',
    more: 'もっと見る',
    less: '折りたたむ',
    notSignedIn: 'サインインしていません',
    accountSwitcher: 'アカウント切り替え',
    addAnotherAccount: '別のアカウントを追加',
    signOut: 'サインアウト',
    switchAccount: 'アカウントを切り替える ({{name}} としてサインイン中)',
    switchingAccount: 'アカウントを切り替え中…',
    expandSidebar: 'サイドバーを展開',
    collapseSidebar: 'サイドバーを折りたたむ',
    signedOut: {
      title: 'メールを管理するにはサインインしてください',
      subtitle: 'メールボックス、ラベルにアクセスし、新しいメッセージを作成できます。',
    },
    mailboxes: {
      Inbox: '受信箱',
      Sent: '送信済み',
      Drafts: '下書き',
      Trash: 'ゴミ箱',
      Spam: '迷惑メール',
      Archive: 'アーカイブ',
      Starred: 'スター付き',
      Snoozed: 'スヌーズ中',
    },
    mailboxA11y: '{{name}}、未読 {{count}} 件',
  },

  home: {
    greeting: {
      morning: 'おはようございます',
      afternoon: 'こんにちは',
      evening: 'こんばんは',
      withName: '{{greeting}}、{{name}} さん',
    },
    todaysBrief: '今日のブリーフ',
    openMenu: 'メニューを開く',
    jumpToToday: '今日へ移動',
    previousWeek: '前の週',
    nextWeek: '次の週',
    regenerateBrief: 'ブリーフを再生成',
    inboxSection: '受信箱',
    needsResponse: '要返信',
    followUp: 'フォローアップ',
    needsResponseA11y_one: '要返信、メール {{count}} 件',
    needsResponseA11y_other: '要返信、メール {{count}} 件',
    followUpA11y_one: 'フォローアップ、メール {{count}} 件',
    followUpA11y_other: 'フォローアップ、メール {{count}} 件',
    days: {
      sun: '日',
      mon: '月',
      tue: '火',
      wed: '水',
      thu: '木',
      fri: '金',
      sat: '土',
    },
    stats: {
      unread: '未読 {{count}} 件',
      starred: 'スター {{count}} 件',
      attachments: '{{count}}',
    },
    brief: {
      analyzing: 'Alia が受信箱を分析しています…',
      unavailable: '現在ブリーフを生成できません。',
      empty: 'まだ要約するメールがありません。',
    },
    feedEmpty: {
      title: 'すべて処理済み',
      subtitle: '受信箱に新しいものはありません。',
    },
    signedOut: {
      subtitle:
        'サインインすると、今日のブリーフ、返信が必要なメール、フォローアップを表示できます。',
    },
  },


  inbox: {
    title: '受信箱',
    starredTitle: 'スター付き',
    searchInMailbox: '{{mailbox}} を検索',
    emptyTitle: '何もありません',
    emptyAllCaught: 'すべて確認済みです。',
    emptySignIn: 'メールを表示するにはサインインしてください。',
    pagination: '{{from}}–{{to}} / {{total}}',
    remind: 'リマインド',
    bundled: 'まとめ表示',
    flat: 'リスト',
    composeFab: '新しいメールを作成',
    composeFabLabel: '作成',
    askAlia: 'Alia に質問',
    askAliaHint: 'AI アシスタント Alia を開き、受信箱について質問できます',
    sections: {
      reminders: 'リマインダー',
      pinned: 'ピン留め',
      today: '今日',
      yesterday: '昨日',
      thisWeek: '今週',
      thisMonth: '今月',
      earlier: '以前',
    },
    aliaSuggestions: {
      unread: {
        label: '未読メール',
        prompt: '注意が必要なメールはどれですか?',
      },
      todaysSummary: {
        label: '今日のサマリー',
        prompt: '今日のメールを要約してください',
      },
      withAttachments: {
        label: '添付付き',
        prompt: '添付ファイルのあるメールを探して',
      },
    },
    aliaClientContext:
      'User is in the Inbox app viewing their email. Use oxy_inbox tools to access their emails.',
    toast: {
      archiveUnavailable: 'アーカイブフォルダが利用できません。',
      trashUnavailable: 'ゴミ箱フォルダが利用できません。',
      offlineSync_one: 'オフライン操作 {{count}} 件を同期しました。',
      offlineSync_other: 'オフライン操作 {{count}} 件を同期しました。',
      newVersionAvailable: '新しいバージョンが利用可能です — 更新してください。',
      newEmail: '{{sender}}から新着メール',
    },
  },

  message: {
    detail: {
      noSubject: '(件名なし)',
      emptyMessage: '(本文なし)',
      messagesInConversation_one: 'このスレッドのメッセージ {{count}} 件',
      messagesInConversation_other: 'このスレッドのメッセージ {{count}} 件',
      toRecipients: '宛先: {{recipients}}',
      ccRecipients: '、cc: {{recipients}}',
    },
    actions: {
      archive: 'アーカイブ',
      delete: '削除',
      markUnread: '未読にする',
      markRead: '既読にする',
      reply: '返信',
      replyAll: '全員に返信',
      forward: '転送',
      pin: 'メッセージをピン留め',
      unpin: 'ピン留めを解除',
      star: 'スターを付ける',
      unstar: 'スターを外す',
      snooze: 'スヌーズ',
      print: '印刷',
      more: 'その他の操作',
      moreInline: 'その他',
      reportSpam: '迷惑メールとして報告',
      label: 'ラベル',
      downloadEml: '.eml をダウンロード',
      messageActions: 'メッセージ操作',
    },
    labelPicker: {
      title: 'ラベル',
      empty: 'ラベルはまだありません',
    },
    toast: {
      attachmentFailed: '添付ファイルをダウンロードできませんでした。',
      fileSystemUnavailable: 'このデバイスではファイルシステムを利用できません。',
      sharingUnavailable: 'このデバイスでは共有できません。',
      printFailed: 'メールを印刷できませんでした。',
      downloadFailed: 'メールをダウンロードできませんでした。',
      saveEmailDialog: 'メールを保存',
    },
  },

  empty: {
    selectConversation: 'スレッドを選択してください',
    nothingHere: '何もありません',
  },

  notFound: {
    title:
      'そのスレッドが見つかりません。移動、アーカイブ、または削除された可能性があります。',
    back: '受信箱に戻る',
  },

  search: {
    placeholder: 'メールを検索',
    clear: '検索をクリア',
    openMenu: 'メニューを開く',
    goBack: '戻る',
    filters: {
      from: '差出人',
      fromValue: '差出人: {{value}}',
      hasAttachment: '添付ファイルあり',
    },
    nl: {
      understanding: '検索を解析しています…',
      searching: '検索中: {{filters}}',
      allEmails: 'すべてのメール',
      fromValue: '{{value}} から',
      toValue: '{{value}} 宛',
      subjectContains: '件名に「{{value}}」を含む',
      withAttachments: '添付付き',
      starred: 'スター付き',
      unread: '未読',
      read: '既読',
    },
    empty: {
      noResults: '結果が見つかりません',
      idle: 'メールを検索しましょう',
    },
    results_one: '{{count}} 件の結果',
    results_other: '{{count}} 件の結果',
  },

  compose: {
    titleCompose: '作成',
    titleReply: '返信',
    titleForward: '転送',
    headTitleCompose: '作成 · Inbox · Oxy',
    headTitleWithSubject: '{{subject}} · 作成 · Oxy',
    placeholders: {
      to: '宛先',
      subject: '件名',
      body: 'メールを作成',
    },
    fields: {
      from: '差出人',
      to: '宛先',
      cc: 'Cc',
      bcc: 'Bcc',
    },
    actions: {
      send: '送信',
      sendNow: '今すぐ送信',
      moreSendOptions: 'その他の送信オプション',
      sendOptions: '送信オプション',
      scheduleSend: '送信予約',
      saveDraft: '下書きを保存',
      discard: '破棄',
    },
    saveDraftPrompt: {
      title: '下書きを保存しますか?',
      description: 'このメッセージを下書きとして保存しますか?',
    },
    dropZone: 'ファイルをドロップして添付',
    toast: {
      addRecipient: '宛先を 1 件以上追加してください。',
      invalidEmail: '有効なメールアドレスを入力してください。',
      sendFailed: 'メールを送信できませんでした。もう一度お試しください。',
      scheduleFailed: '送信予約に失敗しました。もう一度お試しください。',
      scheduled: '{{time}} に送信予約しました',
      uploadFailed: '添付ファイルをアップロードできませんでした。',
      signatureFailed: '署名を読み込めませんでした。',
    },
  },

  inlineReply: {
    placeholder: '返信を入力…',
    forwardTo: '転送先:',
    replyAllTo: '全員に返信:',
    replyTo: '返信先:',
    cc: 'Cc:',
    bcc: 'Bcc:',
    ccBccToggle: 'Cc/Bcc',
    addRecipients: '宛先を追加',
    send: '送信',
    quotedPrefix: '{{date}}、{{author}} は次のように書きました:',
    forwardHeader:
      '\n\n---------- 転送メッセージ ----------\n差出人: {{from}}\n日付: {{date}}\n件名: {{subject}}\n宛先: {{to}}\n\n',
  },

  smartReply: {
    quickReplies: 'クイック返信',
  },

  ai: {
    toolbar: {
      draft: '下書き',
      polish: '推敲',
      shorter: '短く',
      longer: '長く',
      tone: 'トーン',
      suggestSubject: '件名を提案',
    },
    draftModal: {
      title: 'AI で作成',
      subtitle: '言いたいことを伝えれば、Alia が下書きを作成します。',
      placeholder: '例: 会議を丁寧に断り、来週を提案する',
      toneLabel: 'トーン:',
      cancel: 'キャンセル',
      draft: '下書き',
    },
    toneMenu: {
      title: 'トーンを変更…',
    },
    tones: {
      professional: 'プロフェッショナル',
      casual: 'カジュアル',
      friendly: 'フレンドリー',
      formal: 'フォーマル',
    },
  },

  threadSummary: {
    title: 'スレッドの要約',
    messages_one: 'メッセージ {{count}} 件',
    messages_other: 'メッセージ {{count}} 件',
    keyPoints: '要点',
    actionItems: 'アクション項目',
    due: '期限: {{date}}',
  },

  staleThread: {
    consider: '簡単な返信を送ることをご検討ください',
    reply: '返信',
  },

  followUpReminder: {
    pastDue: '期限を過ぎた約束',
    upcoming: 'まもなくの約束',
    description: '{{recipient}} に「{{text}}」と伝えました',
    deadline: {
      dueToday: '今日が期限',
      overdueOneDay: '1 日遅れ',
      overdueDays: '{{days}} 日遅れ',
      dueTomorrow: '明日が期限',
      dueInDays: 'あと {{days}} 日',
    },
    fallbackName: '誰か',
    view: '表示',
    done: '完了',
  },

  reminder: {
    create: {
      title: 'リマインダーを作成',
      placeholder: '何を思い出させますか?',
      whenLabel: 'いつ?',
      submit: 'リマインダーを作成',
      presets: {
        laterToday: '今日のあと',
        tomorrowMorning: '明日の朝',
        thisWeekend: '今週末',
        nextWeek: '来週',
      },
    },
    time: {
      overdue: '期限切れ · {{date}}、{{time}}',
      today: '今日、{{time}}',
      tomorrow: '明日、{{time}}',
      onDate: '{{date}}、{{time}}',
    },
  },

  snooze: {
    title: 'スヌーズ先…',
    options: {
      laterToday: '今日のあと',
      tomorrow: '明日',
      thisWeekend: '今週末',
      nextWeek: '来週',
    },
    time: {
      today: '今日、{{time}}',
      tomorrow: '明日、{{time}}',
      onDate: '{{date}}、{{time}}',
    },
  },

  schedule: {
    title: '送信予約',
    options: {
      laterToday: '今日のあと',
      tomorrowMorning: '明日の朝',
      tomorrowAfternoon: '明日の午後',
      mondayMorning: '月曜の朝',
    },
  },

  template: {
    insert: 'テンプレートを挿入',
  },

  selection: {
    archive: 'アーカイブ',
    delete: '削除',
    star: 'スター',
    markRead: '既読にする',
  },

  subscriptions: {
    title: '購読',
    subtitle:
      '購読を解除しても、メッセージが届かなくなるまで数日かかる場合があります',
    empty: {
      title: '購読は見つかりません',
      subtitle: '頻繁にメールを送ってくる差出人がここに表示されます。',
    },
    unsubscribe: '購読を解除',
    block: 'ブロック',
    frequency: {
      twentyPlus: '直近 20+ 件のメール',
      tenToTwenty: '直近 10-20 件のメール',
      count_one: '直近 {{count}} 件のメール',
      count_other: '直近 {{count}} 件のメール',
    },
  },

  contacts: {
    searchPlaceholder: '連絡先を検索…',
    addContact: '連絡先を追加',
    cancel: 'キャンセル',
    saveContact: '連絡先を保存',
    save: '保存',
    edit: {
      cancel: 'キャンセル',
    },
    delete: {
      title: 'この連絡先を削除しますか?',
      description: 'この操作は取り消せません。',
      cta: '削除',
    },
    starredFilter: 'スター付き',
    autoCollected: '自動収集',
    empty: {
      noMatch: '検索に一致する連絡先がありません。',
      none: 'まだ連絡先がありません。',
    },
    toast: {
      nameEmailRequired: '名前とメールアドレスは必須です。',
      created: '連絡先を作成しました。',
      updated: '連絡先を更新しました。',
      deleted: '連絡先を削除しました。',
    },
    form: {
      name: '名前 *',
      email: 'メール *',
      company: '会社',
      notes: 'メモ',
    },
  },

  shortcuts: {
    title: 'キーボードショートカット',
    close: '閉じる',
    actions: {
      compose: '作成',
      reply: '返信',
      replyAll: '全員に返信',
      forward: '転送',
      archive: 'アーカイブ',
      delete: '削除',
      nextMessage: '次のメッセージ',
      previousMessage: '前のメッセージ',
      starUnstar: 'スター / 解除',
      markUnread: '未読にする',
      search: '検索',
      help: 'このヘルプ',
    },
  },

  cards: {
    purchase: {
      header: '購入',
      order: '注文番号',
      moreItems: '+{{count}} 件',
      summary: '購入の詳細',
    },
    bill: {
      header: '請求',
      account: 'アカウント',
      due: '期限 {{date}}',
      overdue: '期限切れ · {{date}}',
      summary: '請求の詳細',
    },
    trip: {
      header: '旅行',
      confirmation: '確認',
      summary: '旅行の詳細',
    },
    package: {
      header: '荷物',
      tracking: '追跡',
      estimated: '予定 {{date}}',
      summary: '荷物の詳細',
    },
    event: {
      header: 'イベント',
      addToCalendar: 'カレンダーに追加',
      googleCalendar: 'Google カレンダー',
      addToCalendarDialog: 'カレンダーに追加',
      defaultTitle: 'イベント',
      summary: 'イベントの詳細',
    },
  },

  importance: {
    urgent: '緊急',
    action: '対応が必要',
    important: '重要',
    fyi: '参考',
  },

  attachment: {
    sizeBytes: '{{value}} B',
    sizeKb: '{{value}} KB',
    sizeMb: '{{value}} MB',
  },

  settings: {
    head: '設定 · Inbox · Oxy',
    title: '設定',
  },

  auth: {
    gate: {
      title: 'サインインして受信箱にアクセス',
      subtitle:
        'Oxy のアイデンティティを接続して、メッセージ、ラベル、設定をすべてのデバイスで同期しましょう。',
      footer:
        'サインインすると、利用規約に同意し、プライバシーポリシーを承認したことになります。',
    },
  },
};

export default ja;
