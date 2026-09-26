const dict = {
  "signin": {
    "title": "登录",
    "subtitle": "使用你的 Oxy 账号",
    "addAccountTitle": "添加其他账号",
    "addAccountSubtitle": "使用另一个账户登录",
    "actions": {
      "continue": "继续",
      "back": "返回"
    },
    "createAccountLink": "初次使用 Oxy？创建账户",
    "status": {
      "signingIn": "正在登录…"
    },
    "subtitleToApp": "以继续前往 {{app}}",
    "orContinueWith": "或使用以下方式继续",
    "qr": {
      "caption": "使用 Commons 扫码登录",
      "renew": "显示新的二维码"
    },
    "errors": {
      "rateLimited": "尝试次数过多。请在 {{seconds}} 秒后重试。",
      "invalidCredentials": "用户名、邮箱或密码不正确。",
      "codeInvalid": "验证码不正确或已过期。",
      "requestExpired": "此次登录已过期。请重新发送邮件。",
      "secondFactorInvalid": "验证码不正确。请使用当前的验证码。",
      "originNotAllowed": "此处无法登录。",
      "generic": "出了点问题，请重试。",
      "notConfigured": "无法登录",
      "notConfiguredDescription": "{{app}} 尚未配置登录功能。请联系该应用的开发者。",
      "failed": "无法开始登录",
      "failedDescription": "出了点问题，请重试。"
    },
    "chooser": {
      "subtitleToApp": "以继续前往 {{app}}",
      "title": "选择账户",
      "subtitle": "使用下方的账户继续，或使用其他账户。",
      "useAnother": "使用其他账户",
      "continueAs": "以 {{name}} 的身份继续"
    },
    "terms": {
      "before": "继续即表示你同意我们的",
      "termsLink": "服务条款",
      "and": "和",
      "privacyLink": "隐私政策"
    },
    "noAccount": "还没有账号？",
    "createAccount": "创建账号",
    "identifier": {
      "label": "邮箱或用户名",
      "placeholder": "you@example.com",
      "required": "请输入你的邮箱或用户名。"
    },
    "checkEmail": {
      "title": "查看你的邮箱",
      "description": "如果有与 {{identifier}} 匹配的账户，我们已向其发送验证码和登录链接。",
      "codeLabel": "验证码",
      "codeHint": "输入邮件中的验证码，或在此浏览器中打开邮件里的链接。",
      "resend": "重新发送邮件",
      "resendIn": "{{seconds}} 秒后可重新发送邮件",
      "resent": "我们已发送新邮件。",
      "retryLater": "我们已发送了多封邮件。请等几分钟后再试。",
      "usePassword": "改用密码",
      "differentAccount": "使用其他账户"
    },
    "password": {
      "title": "输入你的密码",
      "label": "密码",
      "required": "请输入你的密码。",
      "forgot": "忘记密码？通过邮件获取验证码"
    },
    "secondFactor": {
      "title": "两步验证",
      "description": "输入身份验证器应用中的验证码。",
      "backupDescription": "输入一个备用验证码。每个只能使用一次。",
      "label": "身份验证器验证码",
      "backupLabel": "备用验证码",
      "useBackup": "使用备用验证码",
      "useAuthenticator": "使用身份验证器应用"
    },
    "link": {
      "approvedTitle": "你已登录",
      "approvedDescription": "返回你请求登录的应用，它会自动继续。你可以关闭此标签页。",
      "otherDeviceTitle": "请在同一浏览器中打开链接",
      "otherDeviceDescription": "此链接只能在你请求登录的浏览器中使用。请在那里打开，或在应用中输入邮件里的验证码。",
      "invalidTitle": "此链接无法使用",
      "invalidDescription": "链接已过期或已被使用。请在应用中重新获取邮件，或输入最新一封邮件中的验证码。"
    }
  },
  "signup": {
    "title": "创建你的账户",
    "subtitle": "选择你的用户名，然后我们确认你的邮箱。",
    "createInCommons": "改为在 Commons 中创建",
    "backToSignInLink": "已有账户？登录",
    "username": {
      "label": "用户名",
      "placeholder": "yourname",
      "required": "请选择用户名。",
      "taken": "该用户名已被占用。"
    },
    "email": {
      "title": "你的邮箱是什么？",
      "subtitle": "你将用它登录：每次我们都会发送一个验证码。其他人看不到它。",
      "label": "邮箱",
      "placeholder": "you@example.com",
      "invalid": "请输入有效的邮箱地址。"
    },
    "commonsSubtitle": "或者在 Commons 中创建你的身份，自己保管密钥。",
    "laterNote": "你之后可以在账户的安全设置中添加密码或身份验证器应用。"
  },
  "accountSwitcher": {
    "loading": "正在加载账户...",
    "qrHeadline": "使用您的 Oxy 身份登录",
    "signInWithOxy": "使用 Oxy 登录",
    "signUpWithOxy": "使用 Oxy 注册",
    "getCommons": "获取 Commons",
    "commonsNotInstalled": "没有 Commons？获取应用以使用您的 Oxy ID 登录。",
    "showQrAnyway": "我在另一台设备上有 Commons",
    "switchWhileSignedInAs": "切换账号，当前登录为 {{name}}",
    "manageOnDevice": "管理此设备上的账号",
    "continueWithOxy": "使用 Oxy 继续",
    "havingTrouble": "遇到问题？",
    "progress": {
      "preparing": "正在准备请求",
      "awaitingApproval": "正在等待批准",
      "scanWithCommons": "请用手机上的 Commons 扫描",
      "continueInCommons": "请在 Commons 中继续",
      "checkCommons": "请查看手机上的 Commons",
      "openedInCommons": "已在 Commons 中打开",
      "confirming": "正在确认身份",
      "confirmed": "身份已确认"
    },
    "signInFailures": {
      "denied": "登录请求已在 Commons 中被拒绝。",
      "expired": "登录请求已过期，请重试。",
      "network": "无法连接到 Oxy。请检查网络连接后重试。",
      "notConfigured": "此应用尚未设置登录。",
      "unsupportedFlow": "此登录无法在这里完成。",
      "claimFailed": "登录已获批准，但未能完成。请重试。",
      "generic": "登录失败，请重试。"
    },
    "linkOpenFailed": "无法打开链接，请重试。"
  },
  "common": {
    "actions": {
      "back": "返回",
      "continue": "继续",
      "next": "下一步",
      "getStarted": "开始",
      "createAccount": "创建账户",
      "signIn": "登录",
      "verify": "验证",
      "resetPassword": "重置密码",
      "signedOut": "已退出",
      "close": "关闭",
      "tryAgain": "重试"
    },
    "links": {
      "recoverAccount": "恢复您的账户",
      "signUp": "注册"
    },
    "labels": {
      "username": "用户名",
      "email": "电子邮件",
      "password": "密码",
      "confirmPassword": "确认密码"
    },
    "revoke": "Revoke",
    "errors": {
      "signOutAllFailed": "退出所有账户时出现问题。请重试。"
    }
  },
  "notifications": {
    "title": "Notifications",
    "subtitle": "Manage push, email, and security alerts",
    "updateError": "Failed to update notification preferences",
    "sections": {
      "channels": "Channels",
      "alerts": "Alerts",
      "marketing": "Marketing"
    },
    "items": {
      "push": {
        "title": "Push notifications",
        "subtitle": "Real-time alerts on your devices"
      },
      "emailDigest": {
        "title": "Email digest",
        "subtitle": "Periodic summary of your account activity"
      },
      "securityAlerts": {
        "title": "Security alerts",
        "subtitle": "Sign-ins, recovery codes, and key changes"
      },
      "marketingEmails": {
        "title": "Marketing emails",
        "subtitle": "Product news and occasional offers"
      }
    }
  },
  "preferences": {
    "title": "Preferences",
    "subtitle": "Theme, motion, and regional settings",
    "sections": {
      "appearance": "Appearance",
      "language": "Language",
      "region": "Region"
    },
    "theme": {
      "light": "Light",
      "dark": "Dark",
      "system": "System default"
    },
    "items": {
      "theme": {
        "title": "Theme"
      },
      "reduceMotion": {
        "title": "Reduce motion",
        "subtitle": "Minimise animations across Oxy apps",
        "systemOn": "Following system: reduce motion is on"
      },
      "language": {
        "title": "Language"
      },
      "timezone": {
        "title": "Timezone",
        "unknown": "Unable to detect timezone"
      },
      "about": {
        "title": "About preferences",
        "subtitle": "Preferences sync across every Oxy app you sign into"
      }
    }
  },
  "connectedApps": {
    "title": "Connected apps",
    "subtitle": "Manage third-party app access",
    "empty": {
      "title": "No connected apps",
      "subtitle": "Apps you authorize to sign in with your Oxy account will appear here"
    },
    "item": {
      "granted": "已于 {{relative}} 授权",
      "lastUsed": "Last used {{relative}}"
    },
    "confirm": {
      "title": "Revoke access",
      "message": "Revoke {{name}}'s access to your Oxy account?"
    },
    "toasts": {
      "revoked": "Revoked access for {{name}}",
      "revokeFailed": "Failed to revoke access"
    }
  },
  "accountMenu": {
    "label": "账户菜单",
    "manage": "管理您的 Oxy 账户",
    "viewProfile": "查看个人资料",
    "addAnother": "添加其他账户",
    "signOutAll": "退出所有账户",
    "open": "账户菜单",
    "openHint": "打开账户菜单",
    "openWithUser": "{{name}} 的账户菜单",
    "switching": "正在切换账户…",
    "signOutAccount": "退出 {{name}}",
    "greeting": "你好，{{name}}！",
    "switchAccount": "切换账号",
    "storage": {
      "title": "Oxy 存储",
      "usage": "已使用 {{used}} / {{total}}",
      "used": "已用",
      "free": "可用",
      "unavailable": "无法获取用量详情",
      "upgrade": "升级方案",
      "manage": "管理存储"
    },
    "data": "你在 Oxy 中的数据",
    "settings": "Oxy 设置",
    "help": "帮助与反馈",
    "signOut": "退出登录",
    "privacy": "隐私政策",
    "terms": "服务条款"
  },
  "emailCode": {
    "title": "查看你的邮箱",
    "sentTo": "我们已向 {{email}} 发送了 6 位验证码。",
    "label": "验证码",
    "resend": "发送新验证码",
    "resent": "我们已发送新验证码。",
    "changeEmail": "使用其他邮箱",
    "errors": {
      "codeInvalid": "验证码不正确或已过期。",
      "tooManyAttempts": "错误次数过多，请重新获取验证码。",
      "expired": "耗时过长，请重新开始。",
      "unavailable": "Oxy 暂时无法发送邮件，请稍后再试。",
      "rateLimited": "验证码请求过多，请稍后再试。"
    }
  },
  "deleteAccount": {
    "keyless": {
      "subtitle": "@{{username}} 及其中的一切将被永久删除。请输入你的用户名，然后用我们发到你邮箱的验证码确认。",
      "action": "删除账户",
      "done": "你的账户已删除。",
      "doneDescription": "你已退出登录。",
      "keyed": "此账户使用 Commons：请在 Oxy Commons 的“设置 > 删除账户”中用其密钥删除。"
    },
    "handoff": {
      "elsewhereMessage": "删除账户需要你的身份密钥，而它不在此设备上。请在保存密钥的设备上打开 Oxy Commons，前往“设置 > 删除账户”。"
    }
  },
  "linkCommons": {
    "title": "关联 Commons",
    "subtitle": "自己保管密钥：关联 Commons 后，此账户只属于你。它的邮箱会被删除，今后用 Commons 中的恢复短语找回账户。",
    "scan": "在手机上打开 Commons，选择“我在网页上有 Oxy 账户”，然后扫描此码。",
    "waiting": "正在等待 Commons…",
    "compareTitle": "核对代码",
    "compare": "Commons 会显示相同的代码。如果不同，请取消。",
    "confirm": "是的，关联 Commons",
    "cancel": "取消",
    "doneTitle": "Commons 已关联",
    "done": "此账户现在由你自己保管。它的邮箱已删除：今后用 Commons 中的恢复短语找回账户。",
    "already": "此账户已在使用 Commons。",
    "expired": "此代码已过期。",
    "renew": "显示新代码",
    "failed": "无法关联 Commons，请重试。",
    "confirmTitle": "确认关联",
    "confirmDescription": "最后，请用我们发到你邮箱的验证码确认是你本人。",
    "row": "用 Commons 自己保管密钥"
  },
  "reauth": {
    "title": "确认是你本人",
    "emailDescription": "我们会向你的邮箱发送验证码，以确认此项更改。",
    "sendCode": "发送验证码",
    "codeSent": "我们已向你的邮箱发送了 6 位验证码。",
    "codeLabel": "邮件中的验证码",
    "passwordLabel": "当前密码",
    "usePassword": "改用密码",
    "useEmail": "改为通过邮件获取验证码",
    "totpLabel": "身份验证器验证码或备用验证码",
    "errors": {
      "invalid": "验证失败。请检查输入内容后重试。",
      "totpRequired": "还需输入身份验证器应用中的验证码。"
    }
  },
  "signInSecurity": {
    "password": {
      "title": "密码",
      "setTitle": "设置密码",
      "changeTitle": "更改密码",
      "description": "用密码登录，而不是通过邮件验证码。至少使用 {{min}} 个字符。",
      "newLabel": "新密码",
      "repeatLabel": "再次输入密码",
      "tooShort": "至少使用 {{min}} 个字符。",
      "mismatch": "两次输入的密码不一致。",
      "signOutOthers": "在其他所有地方退出登录",
      "save": "保存密码",
      "saved": "你的密码已保存。",
      "row": "可选：使用密码登录"
    },
    "totp": {
      "title": "身份验证器应用",
      "description": "在邮件验证码或密码之后，Oxy 还会要求输入来自 Google Authenticator 或 1Password 等应用的验证码。",
      "setUp": "设置",
      "scan": "用你的身份验证器应用扫描此二维码，或输入设置密钥。",
      "secretLabel": "设置密钥",
      "codeLabel": "应用中的验证码",
      "enable": "开启",
      "enabled": "身份验证器应用已开启。",
      "disable": "关闭身份验证器应用",
      "disabled": "身份验证器应用已关闭。",
      "on": "已开启",
      "off": "已关闭",
      "backupTitle": "保存你的备用验证码",
      "backupDescription": "如果你丢失了手机，每个验证码可让你登录一次。请妥善保管：它们不会再次显示。",
      "copy": "复制验证码",
      "copied": "备用验证码已复制。",
      "savedThem": "我已保存",
      "regenerate": "获取新的备用验证码",
      "regenerateDescription": "你以前的备用验证码将失效。",
      "remaining": "剩余 {{count}} 个备用验证码",
      "row": "登录时的第二步验证"
    }
  }
};
export default dict;
