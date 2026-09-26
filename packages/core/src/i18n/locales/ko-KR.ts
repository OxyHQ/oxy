const dict = {
  "signin": {
    "title": "로그인",
    "subtitle": "Oxy 계정 사용",
    "addAccountTitle": "다른 계정 추가",
    "addAccountSubtitle": "다른 계정으로 로그인",
    "actions": {
      "continue": "계속",
      "back": "뒤로"
    },
    "createAccountLink": "Oxy가 처음이신가요? 계정 만들기",
    "status": {
      "signingIn": "로그인 중…"
    },
    "subtitleToApp": "{{app}}(으)로 계속",
    "orContinueWith": "또는 다음으로 계속",
    "qr": {
      "caption": "Commons로 스캔하여 로그인",
      "renew": "새 코드 표시"
    },
    "errors": {
      "rateLimited": "시도 횟수가 너무 많습니다. {{seconds}}초 후에 다시 시도하세요.",
      "invalidCredentials": "사용자 이름, 이메일 또는 비밀번호가 올바르지 않습니다.",
      "codeInvalid": "코드가 올바르지 않거나 만료되었습니다.",
      "requestExpired": "이 로그인은 만료되었습니다. 새 이메일을 보내세요.",
      "secondFactorInvalid": "코드가 올바르지 않습니다. 현재 코드를 입력하세요.",
      "originNotAllowed": "여기서는 로그인할 수 없습니다.",
      "generic": "문제가 발생했습니다. 다시 시도하세요.",
      "notConfigured": "로그인을 사용할 수 없습니다",
      "notConfiguredDescription": "{{app}}은(는) 아직 로그인이 설정되지 않았습니다. 앱 개발자에게 문의하세요.",
      "failed": "로그인을 시작할 수 없습니다",
      "failedDescription": "문제가 발생했습니다. 다시 시도하세요."
    },
    "chooser": {
      "subtitleToApp": "{{app}}(으)로 계속",
      "title": "계정 선택",
      "subtitle": "아래 계정으로 계속하거나 다른 계정을 사용하세요.",
      "useAnother": "다른 계정 사용",
      "continueAs": "{{name}}(으)로 계속"
    },
    "terms": {
      "before": "계속하면 다음에 동의하게 됩니다:",
      "termsLink": "서비스 약관",
      "and": "및",
      "privacyLink": "개인정보처리방침"
    },
    "noAccount": "계정이 없으신가요?",
    "createAccount": "계정 만들기",
    "identifier": {
      "label": "이메일 또는 사용자 이름",
      "placeholder": "you@example.com",
      "required": "이메일 또는 사용자 이름을 입력하세요."
    },
    "checkEmail": {
      "title": "이메일을 확인하세요",
      "description": "{{identifier}}와(과) 일치하는 계정이 있다면 코드와 로그인 링크를 보냈습니다.",
      "codeLabel": "코드",
      "codeHint": "이메일의 코드를 입력하거나 이 브라우저에서 이메일의 링크를 여세요.",
      "resend": "새 이메일 보내기",
      "resendIn": "{{seconds}}초 후 새 이메일 보내기",
      "resent": "새 이메일을 보냈습니다.",
      "retryLater": "이미 이메일을 여러 번 보냈습니다. 몇 분 기다린 후 다시 시도하세요.",
      "usePassword": "비밀번호 사용하기",
      "differentAccount": "다른 계정 사용"
    },
    "password": {
      "title": "비밀번호 입력",
      "label": "비밀번호",
      "required": "비밀번호를 입력하세요.",
      "forgot": "잊으셨나요? 이메일로 코드 받기"
    },
    "secondFactor": {
      "title": "2단계 인증",
      "description": "인증 앱의 코드를 입력하세요.",
      "backupDescription": "백업 코드 중 하나를 입력하세요. 각 코드는 한 번만 사용할 수 있습니다.",
      "label": "인증 코드",
      "backupLabel": "백업 코드",
      "useBackup": "백업 코드 사용",
      "useAuthenticator": "인증 앱 사용"
    },
    "link": {
      "approvedTitle": "로그인되었습니다",
      "approvedDescription": "로그인을 요청한 앱으로 돌아가세요. 자동으로 계속됩니다. 이 탭은 닫아도 됩니다.",
      "otherDeviceTitle": "같은 브라우저에서 링크를 여세요",
      "otherDeviceDescription": "이 링크는 로그인을 요청한 브라우저에서만 작동합니다. 그 브라우저에서 열거나, 이메일의 코드를 앱에 입력하세요.",
      "invalidTitle": "이 링크는 사용할 수 없습니다",
      "invalidDescription": "만료되었거나 이미 사용된 링크입니다. 앱에서 새 이메일을 요청하거나 가장 최근 이메일의 코드를 입력하세요."
    }
  },
  "signup": {
    "title": "계정 만들기",
    "subtitle": "사용자 이름을 정하세요. 그다음 이메일을 확인합니다.",
    "createInCommons": "Commons에서 만들기",
    "backToSignInLink": "이미 계정이 있으신가요? 로그인",
    "username": {
      "label": "사용자 이름",
      "placeholder": "yourname",
      "required": "사용자 이름을 정하세요.",
      "taken": "이미 사용 중인 사용자 이름입니다."
    },
    "email": {
      "title": "이메일 주소가 무엇인가요?",
      "subtitle": "이 이메일로 로그인합니다. 매번 코드를 보내 드립니다. 다른 사람에게는 보이지 않습니다.",
      "label": "이메일",
      "placeholder": "you@example.com",
      "invalid": "올바른 이메일 주소를 입력하세요."
    },
    "commonsSubtitle": "또는 Commons에서 아이덴티티를 만들고 직접 키를 보관하세요.",
    "laterNote": "비밀번호나 인증 앱은 나중에 계정의 보안 설정에서 추가할 수 있습니다."
  },
  "accountSwitcher": {
    "loading": "계정을 불러오는 중...",
    "qrHeadline": "Oxy ID로 로그인",
    "signInWithOxy": "Oxy로 로그인",
    "signUpWithOxy": "Oxy로 가입하기",
    "getCommons": "Commons 다운로드",
    "commonsNotInstalled": "Commons가 없으신가요? 앱을 다운로드하여 Oxy ID로 로그인하세요.",
    "showQrAnyway": "다른 기기에 Commons가 있습니다",
    "switchWhileSignedInAs": "계정 전환, {{name}}(으)로 로그인됨",
    "manageOnDevice": "이 기기의 계정 관리",
    "continueWithOxy": "Oxy로 계속하기",
    "havingTrouble": "문제가 있으신가요?",
    "progress": {
      "preparing": "요청 준비 중",
      "awaitingApproval": "승인 대기 중",
      "scanWithCommons": "휴대폰의 Commons로 스캔하세요",
      "continueInCommons": "Commons에서 계속하세요",
      "checkCommons": "휴대폰에서 Commons를 확인하세요",
      "openedInCommons": "Commons에서 열림",
      "confirming": "신원 확인 중",
      "confirmed": "신원 확인 완료"
    },
    "signInFailures": {
      "denied": "Commons에서 로그인이 거부되었습니다.",
      "expired": "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
      "network": "Oxy에 연결할 수 없습니다. 연결을 확인하고 다시 시도해 주세요.",
      "notConfigured": "이 앱은 아직 로그인이 설정되지 않았습니다.",
      "unsupportedFlow": "이 로그인은 여기에서 완료할 수 없습니다.",
      "claimFailed": "로그인이 승인되었지만 완료하지 못했습니다. 다시 시도해 주세요.",
      "generic": "로그인하지 못했습니다. 다시 시도해 주세요."
    },
    "linkOpenFailed": "링크를 열 수 없습니다. 다시 시도해 주세요."
  },
  "common": {
    "actions": {
      "back": "뒤로",
      "continue": "계속",
      "next": "다음",
      "getStarted": "시작하기",
      "createAccount": "계정 만들기",
      "signIn": "로그인",
      "verify": "확인",
      "resetPassword": "비밀번호 재설정",
      "signedOut": "로그아웃됨",
      "close": "닫기",
      "tryAgain": "다시 시도"
    },
    "links": {
      "recoverAccount": "계정 복구",
      "signUp": "가입하기"
    },
    "labels": {
      "username": "사용자 이름",
      "email": "이메일",
      "password": "비밀번호",
      "confirmPassword": "비밀번호 확인"
    },
    "revoke": "Revoke",
    "errors": {
      "signOutAllFailed": "모든 계정에서 로그아웃하는 중 문제가 발생했습니다. 다시 시도해 주세요."
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
      "granted": "{{relative}}에 부여됨",
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
    "label": "계정 메뉴",
    "manage": "Oxy 계정 관리",
    "viewProfile": "프로필 보기",
    "addAnother": "다른 계정 추가",
    "signOutAll": "모든 계정에서 로그아웃",
    "open": "계정 메뉴",
    "openHint": "계정 메뉴를 엽니다",
    "openWithUser": "{{name}}의 계정 메뉴",
    "switching": "계정 전환 중…",
    "signOutAccount": "{{name}} 로그아웃",
    "greeting": "안녕하세요, {{name}}님!",
    "switchAccount": "계정 전환",
    "storage": {
      "title": "Oxy 저장소",
      "usage": "{{total}} 중 {{used}} 사용",
      "used": "사용됨",
      "free": "여유",
      "unavailable": "사용량 정보를 사용할 수 없음",
      "upgrade": "플랜 업그레이드",
      "manage": "저장소 관리"
    },
    "data": "Oxy의 데이터",
    "settings": "Oxy 설정",
    "help": "도움말 및 피드백",
    "signOut": "로그아웃",
    "privacy": "개인정보 처리방침",
    "terms": "서비스 약관"
  },
  "emailCode": {
    "title": "이메일을 확인하세요",
    "sentTo": "{{email}}(으)로 6자리 코드를 보냈습니다.",
    "label": "코드",
    "resend": "새 코드 보내기",
    "resent": "새 코드를 보냈습니다.",
    "changeEmail": "다른 이메일 사용",
    "errors": {
      "codeInvalid": "코드가 올바르지 않거나 만료되었습니다.",
      "tooManyAttempts": "틀린 코드가 너무 많습니다. 새 코드를 요청하세요.",
      "expired": "시간이 너무 오래 걸렸습니다. 다시 시작하세요.",
      "unavailable": "지금은 Oxy가 이메일을 보낼 수 없습니다. 나중에 다시 시도하세요.",
      "rateLimited": "코드가 너무 많습니다. 나중에 다시 시도하세요."
    }
  },
  "deleteAccount": {
    "keyless": {
      "subtitle": "@{{username}}과(와) 그 안의 모든 것이 영구적으로 삭제됩니다. 사용자 이름을 입력한 다음 이메일로 받은 코드로 확인하세요.",
      "action": "계정 삭제",
      "done": "계정이 삭제되었습니다.",
      "doneDescription": "로그아웃되었습니다.",
      "keyed": "이 계정은 Commons를 사용합니다. Oxy Commons의 설정 > 계정 삭제에서 해당 키로 삭제하세요."
    },
    "handoff": {
      "elsewhereMessage": "계정을 삭제하려면 아이덴티티 키가 필요한데, 이 기기에는 없습니다. 키가 있는 기기에서 Oxy Commons를 열고 설정 > 계정 삭제로 이동하세요."
    }
  },
  "linkCommons": {
    "title": "Commons 연결",
    "subtitle": "직접 키를 보관하세요. Commons를 연결하면 이 계정은 오직 당신의 것이 됩니다. 이메일은 삭제되고, Commons의 복구 문구로 다시 들어올 수 있습니다.",
    "scan": "휴대폰에서 Commons를 열고 “웹에 Oxy 계정이 있어요”를 선택한 다음 이 코드를 스캔하세요.",
    "waiting": "Commons를 기다리는 중…",
    "compareTitle": "코드 확인",
    "compare": "Commons에 같은 코드가 표시됩니다. 다르면 취소하세요.",
    "confirm": "네, Commons 연결",
    "cancel": "취소",
    "doneTitle": "Commons가 연결되었습니다",
    "done": "이 계정은 이제 자기 보관 계정입니다. 이메일은 삭제되었습니다. Commons의 복구 문구로 다시 들어올 수 있습니다.",
    "already": "이 계정은 이미 Commons를 사용합니다.",
    "expired": "이 코드는 만료되었습니다.",
    "renew": "새 코드 보기",
    "failed": "Commons를 연결하지 못했습니다. 다시 시도하세요.",
    "confirmTitle": "연결 확인",
    "confirmDescription": "마지막으로, 이메일로 보내 드리는 코드로 본인임을 확인하세요.",
    "row": "Commons로 직접 키 보관하기"
  },
  "reauth": {
    "title": "본인 확인",
    "emailDescription": "이 변경을 확인하기 위해 이메일로 코드를 보내 드립니다.",
    "sendCode": "코드 보내기",
    "codeSent": "이메일로 6자리 코드를 보냈습니다.",
    "codeLabel": "이메일의 코드",
    "passwordLabel": "현재 비밀번호",
    "usePassword": "비밀번호 사용하기",
    "useEmail": "이메일로 코드 받기",
    "totpLabel": "인증 코드 또는 백업 코드",
    "errors": {
      "invalid": "확인하지 못했습니다. 입력한 내용을 확인하고 다시 시도하세요.",
      "totpRequired": "인증 앱의 코드도 입력하세요."
    }
  },
  "signInSecurity": {
    "password": {
      "title": "비밀번호",
      "setTitle": "비밀번호 설정",
      "changeTitle": "비밀번호 변경",
      "description": "이메일 코드 대신 비밀번호로 로그인하세요. {{min}}자 이상을 사용하세요.",
      "newLabel": "새 비밀번호",
      "repeatLabel": "비밀번호 다시 입력",
      "tooShort": "{{min}}자 이상을 사용하세요.",
      "mismatch": "비밀번호가 일치하지 않습니다.",
      "signOutOthers": "다른 모든 곳에서 로그아웃",
      "save": "비밀번호 저장",
      "saved": "비밀번호가 저장되었습니다.",
      "row": "선택 사항: 비밀번호로 로그인"
    },
    "totp": {
      "title": "인증 앱",
      "description": "이메일 코드나 비밀번호를 입력한 후, Oxy가 Google Authenticator나 1Password 같은 앱의 코드도 요청합니다.",
      "setUp": "설정",
      "scan": "인증 앱으로 이 QR 코드를 스캔하거나 설정 키를 입력하세요.",
      "secretLabel": "설정 키",
      "codeLabel": "앱의 코드",
      "enable": "켜기",
      "enabled": "인증 앱이 켜졌습니다.",
      "disable": "인증 앱 끄기",
      "disabled": "인증 앱이 꺼졌습니다.",
      "on": "켜짐",
      "off": "꺼짐",
      "backupTitle": "백업 코드 저장",
      "backupDescription": "휴대폰을 잃어버려도 각 코드로 한 번 로그인할 수 있습니다. 안전한 곳에 보관하세요. 다시 표시되지 않습니다.",
      "copy": "코드 복사",
      "copied": "백업 코드를 복사했습니다.",
      "savedThem": "저장했습니다",
      "regenerate": "새 백업 코드 받기",
      "regenerateDescription": "이전 백업 코드는 더 이상 작동하지 않습니다.",
      "remaining": "백업 코드 {{count}}개 남음",
      "row": "로그인할 때 추가 확인 단계"
    }
  }
};
export default dict;
