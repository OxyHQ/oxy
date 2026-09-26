const dict = {
  "signin": {
    "title": "Inicia la sessió",
    "subtitle": "Fes servir el teu compte d'Oxy",
    "addAccountTitle": "Afegeix un altre compte",
    "addAccountSubtitle": "Inicia sessió amb un altre compte",
    "actions": {
      "continue": "Continuar",
      "back": "Enrere"
    },
    "createAccountLink": "Ets nou a Oxy? Crea'n una",
    "status": {
      "signingIn": "Iniciant sessió…"
    },
    "subtitleToApp": "per continuar a {{app}}",
    "orContinueWith": "o continua amb",
    "qr": {
      "caption": "Escaneja amb Commons per entrar",
      "renew": "Mostra un codi nou"
    },
    "errors": {
      "rateLimited": "Massa intents. Torna-ho a provar d’aquí a {{seconds}} s.",
      "invalidCredentials": "El nom d'usuari, el correu o la contrasenya no són correctes.",
      "codeInvalid": "Aquest codi no és correcte o ha caducat.",
      "requestExpired": "Aquest inici de sessió ha caducat. Envia un correu nou.",
      "secondFactorInvalid": "Aquest codi no és correcte. Prova amb l'actual.",
      "originNotAllowed": "Aquí no es pot iniciar sessió.",
      "generic": "Alguna cosa ha anat malament. Torna-ho a provar.",
      "notConfigured": "L'inici de sessió no està disponible",
      "notConfiguredDescription": "{{app}} encara no està configurada per iniciar sessió. Contacta amb qui desenvolupa l'app.",
      "failed": "No s'ha pogut iniciar la sessió",
      "failedDescription": "Alguna cosa ha anat malament. Torna-ho a provar."
    },
    "chooser": {
      "subtitleToApp": "per continuar a {{app}}",
      "title": "Tria un compte",
      "subtitle": "Continua amb un dels teus comptes o fes-ne servir un altre.",
      "useAnother": "Fes servir un altre compte",
      "continueAs": "Continua com a {{name}}"
    },
    "terms": {
      "before": "En continuar, acceptes les nostres",
      "termsLink": "Condicions del servei",
      "and": "i la",
      "privacyLink": "Política de privadesa"
    },
    "noAccount": "No tens compte?",
    "createAccount": "Crea un compte",
    "identifier": {
      "label": "Correu o nom d'usuari",
      "placeholder": "tu@exemple.com",
      "required": "Escriu el teu correu o nom d'usuari."
    },
    "checkEmail": {
      "title": "Mira el correu",
      "description": "Si hi ha un compte amb {{identifier}}, li hem enviat un codi i un enllaç per iniciar sessió.",
      "codeLabel": "Codi",
      "codeHint": "Escriu el codi del correu o obre'n l'enllaç en aquest navegador.",
      "resend": "Envia un correu nou",
      "resendIn": "Envia un correu nou d'aquí a {{seconds}} s",
      "resent": "T'hem enviat un correu nou.",
      "retryLater": "Ja t'hem enviat diversos correus. Espera uns minuts i torna-ho a provar.",
      "usePassword": "Fes servir la contrasenya",
      "differentAccount": "Fes servir un altre compte"
    },
    "password": {
      "title": "Escriu la contrasenya",
      "label": "Contrasenya",
      "required": "Escriu la contrasenya.",
      "forgot": "L'has oblidada? Rep un codi per correu"
    },
    "secondFactor": {
      "title": "Verificació en dos passos",
      "description": "Escriu el codi de la teva app d'autenticació.",
      "backupDescription": "Escriu un dels teus codis de seguretat. Cadascun funciona una sola vegada.",
      "label": "Codi d'autenticació",
      "backupLabel": "Codi de seguretat",
      "useBackup": "Fes servir un codi de seguretat",
      "useAuthenticator": "Fes servir l'app d'autenticació"
    },
    "link": {
      "approvedTitle": "Has iniciat la sessió",
      "approvedDescription": "Torna a l'app on vas demanar iniciar sessió: continuarà sola. Pots tancar aquesta pestanya.",
      "otherDeviceTitle": "Obre l'enllaç al mateix navegador",
      "otherDeviceDescription": "Aquest enllaç només funciona al navegador on vas demanar iniciar sessió. Obre'l allà o escriu a l'app el codi del correu.",
      "invalidTitle": "Aquest enllaç no es pot fer servir",
      "invalidDescription": "Ha caducat o ja s'ha fet servir. Demana un correu nou a l'app o escriu el codi de l'últim."
    }
  },
  "signup": {
    "title": "Crea el teu compte",
    "subtitle": "Tria el teu nom d'usuari. Després confirmem el teu correu.",
    "createInCommons": "Crea-la a Commons",
    "backToSignInLink": "Ja tens compte? Inicia sessió",
    "username": {
      "label": "Nom d'usuari",
      "placeholder": "elteunom",
      "required": "Tria un nom d'usuari.",
      "taken": "Aquest nom d'usuari ja està agafat."
    },
    "email": {
      "title": "Quin és el teu correu?",
      "subtitle": "L'utilitzes per iniciar sessió: t'enviem un codi cada vegada. Ningú més el veu.",
      "label": "Correu",
      "placeholder": "tu@exemple.com",
      "invalid": "Escriu un correu vàlid."
    },
    "commonsSubtitle": "O crea la teva identitat a Commons i guarda la teva pròpia clau.",
    "laterNote": "Més endavant pots afegir una contrasenya o una app d'autenticació a la configuració de seguretat del compte."
  },
  "accountSwitcher": {
    "loading": "S'estan carregant els comptes...",
    "qrHeadline": "Inicia sessió amb la teva identitat d'Oxy",
    "signInWithOxy": "Inicia sessió amb Oxy",
    "signUpWithOxy": "Registra't amb Oxy",
    "getCommons": "Descarrega Commons",
    "commonsNotInstalled": "No tens Commons? Descarrega l'app per iniciar sessió amb el teu Oxy ID.",
    "showQrAnyway": "Tinc Commons en un altre dispositiu",
    "switchWhileSignedInAs": "Canvia de compte, amb la sessió iniciada com a {{name}}",
    "manageOnDevice": "Gestionar comptes en aquest dispositiu",
    "continueWithOxy": "Continua amb Oxy",
    "havingTrouble": "Algun problema?",
    "progress": {
      "preparing": "Preparant la sol·licitud",
      "awaitingApproval": "Esperant l'aprovació",
      "scanWithCommons": "Escaneja amb Commons al teu mòbil",
      "continueInCommons": "Continua a Commons",
      "checkCommons": "Revisa Commons al teu mòbil",
      "openedInCommons": "Obert a Commons",
      "confirming": "Confirmant la identitat",
      "confirmed": "Identitat confirmada"
    },
    "signInFailures": {
      "denied": "S'ha rebutjat l'inici de sessió a Commons.",
      "expired": "La sol·licitud d'inici de sessió ha caducat. Torna-ho a provar.",
      "network": "No s'ha pogut connectar amb Oxy. Comprova la connexió i torna-ho a provar.",
      "notConfigured": "Aquesta app encara no està preparada per iniciar sessió.",
      "unsupportedFlow": "Aquest inici de sessió no es pot completar aquí.",
      "claimFailed": "S'ha aprovat l'inici de sessió, però no l'hem pogut completar. Torna-ho a provar.",
      "generic": "No s'ha pogut iniciar la sessió. Torna-ho a provar."
    },
    "linkOpenFailed": "No s'ha pogut obrir l'enllaç. Torna-ho a provar."
  },
  "common": {
    "actions": {
      "back": "Enrere",
      "continue": "Continuar",
      "next": "Següent",
      "getStarted": "Començar",
      "createAccount": "Crear compte",
      "signIn": "Iniciar sessió",
      "verify": "Verificar",
      "resetPassword": "Restablir contrasenya",
      "signedOut": "Sessió tancada",
      "close": "Tanca",
      "tryAgain": "Torna-ho a provar"
    },
    "links": {
      "recoverAccount": "Recuperar el teu compte",
      "signUp": "Registrar-se"
    },
    "labels": {
      "username": "Nom d'usuari",
      "email": "Correu electrònic",
      "password": "Contrasenya",
      "confirmPassword": "Confirmar contrasenya"
    },
    "revoke": "Revoke",
    "errors": {
      "signOutAllFailed": "Hi ha hagut un problema en tancar la sessió de tots els comptes. Torna-ho a provar."
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
      "granted": "Concedit {{relative}}",
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
    "label": "Menú del compte",
    "manage": "Gestiona el teu compte d'Oxy",
    "viewProfile": "Mostra el perfil",
    "addAnother": "Afegeix un altre compte",
    "signOutAll": "Tanca la sessió de tots els comptes",
    "open": "Menú del compte",
    "openHint": "Obre el menú del compte",
    "openWithUser": "Menú del compte de {{name}}",
    "switching": "Canviant de compte…",
    "signOutAccount": "Tanca la sessió de {{name}}",
    "greeting": "Hola, {{name}}!",
    "switchAccount": "Canviar de compte",
    "storage": {
      "title": "Emmagatzematge d'Oxy",
      "usage": "{{used}} de {{total}} en ús",
      "used": "En ús",
      "free": "Lliure",
      "unavailable": "Detalls d'ús no disponibles",
      "upgrade": "Millorar el pla",
      "manage": "Gestionar l'emmagatzematge"
    },
    "data": "Les teves dades a Oxy",
    "settings": "Configuració d'Oxy",
    "help": "Ajuda i comentaris",
    "signOut": "Tancar sessió",
    "privacy": "Política de privacitat",
    "terms": "Condicions del servei"
  },
  "emailCode": {
    "title": "Mira el correu",
    "sentTo": "Hem enviat un codi de 6 xifres a {{email}}.",
    "label": "Codi",
    "resend": "Envia un codi nou",
    "resent": "T'hem enviat un codi nou.",
    "changeEmail": "Fes servir un altre correu",
    "errors": {
      "codeInvalid": "Aquest codi no és correcte o ha caducat.",
      "tooManyAttempts": "Massa codis incorrectes. Demana-ne un de nou.",
      "expired": "Ha passat massa temps. Torna a començar.",
      "unavailable": "Oxy no pot enviar correus ara. Torna-ho a provar més tard.",
      "rateLimited": "Massa codis. Torna-ho a provar més tard."
    }
  },
  "deleteAccount": {
    "keyless": {
      "subtitle": "@{{username}} i tot el que conté s'eliminen per sempre. Escriu el teu nom d'usuari i confirma amb un codi que t'enviem per correu.",
      "action": "Elimina el compte",
      "done": "El teu compte s'ha eliminat.",
      "doneDescription": "S'ha tancat la sessió.",
      "keyed": "Aquest compte fa servir Commons: elimina'l a Oxy Commons, Configuració > Elimina el compte, amb la seva clau."
    },
    "handoff": {
      "elsewhereMessage": "Per eliminar el compte cal la teva clau d'identitat, i no és en aquest dispositiu. Obre Oxy Commons al dispositiu que la guarda i ves a Configuració > Elimina el compte."
    }
  },
  "linkCommons": {
    "title": "Vincula Commons",
    "subtitle": "Guarda la teva pròpia clau: vincula Commons i aquest compte serà només teu. El seu correu s'elimina, i la frase de recuperació de Commons és com hi tornes a entrar.",
    "scan": "Al mòbil, obre Commons, tria «Tinc un compte d'Oxy al web» i escaneja aquest codi.",
    "waiting": "Esperant Commons…",
    "compareTitle": "Comprova el codi",
    "compare": "Commons mostra el mateix codi. Si no és així, cancel·la.",
    "confirm": "Sí, vincula Commons",
    "cancel": "Cancel·la",
    "doneTitle": "Commons està vinculat",
    "done": "Aquest compte ara és d'autocustòdia. El seu correu s'ha eliminat: la frase de recuperació de Commons és com hi tornes a entrar.",
    "already": "Aquest compte ja fa servir Commons.",
    "expired": "Aquest codi ha caducat.",
    "renew": "Mostra un codi nou",
    "failed": "No s'ha pogut vincular Commons. Torna-ho a provar.",
    "confirmTitle": "Confirma la vinculació",
    "confirmDescription": "Per acabar, confirma que ets tu amb un codi que t'enviem per correu.",
    "row": "Guarda la teva pròpia clau amb Commons"
  },
  "reauth": {
    "title": "Confirma que ets tu",
    "emailDescription": "T'enviarem un codi al correu per confirmar aquest canvi.",
    "sendCode": "Envia el codi",
    "codeSent": "Hem enviat un codi de 6 xifres al teu correu.",
    "codeLabel": "Codi del correu",
    "passwordLabel": "Contrasenya actual",
    "usePassword": "Fes servir la contrasenya",
    "useEmail": "Rep un codi per correu",
    "totpLabel": "Codi d'autenticació o de seguretat",
    "errors": {
      "invalid": "No ha funcionat. Revisa el que has escrit i torna-ho a provar.",
      "totpRequired": "Escriu també el codi de la teva app d'autenticació."
    }
  },
  "signInSecurity": {
    "password": {
      "title": "Contrasenya",
      "setTitle": "Crea una contrasenya",
      "changeTitle": "Canvia la contrasenya",
      "description": "Inicia sessió amb la contrasenya en lloc d'un codi per correu. Fes servir almenys {{min}} caràcters.",
      "newLabel": "Contrasenya nova",
      "repeatLabel": "Repeteix la contrasenya",
      "tooShort": "Fes servir almenys {{min}} caràcters.",
      "mismatch": "Les contrasenyes no coincideixen.",
      "signOutOthers": "Tanca la sessió a tots els altres llocs",
      "save": "Desa la contrasenya",
      "saved": "S'ha desat la contrasenya.",
      "row": "Opcional: inicia sessió amb contrasenya"
    },
    "totp": {
      "title": "App d'autenticació",
      "description": "Després del codi per correu o de la contrasenya, Oxy també et demana un codi d'una app com Google Authenticator o 1Password.",
      "setUp": "Configura",
      "scan": "Escaneja aquest codi QR amb la teva app d'autenticació o escriu la clau de configuració.",
      "secretLabel": "Clau de configuració",
      "codeLabel": "Codi de l'app",
      "enable": "Activa",
      "enabled": "L'app d'autenticació està activada.",
      "disable": "Desactiva l'app d'autenticació",
      "disabled": "L'app d'autenticació està desactivada.",
      "on": "Activada",
      "off": "Desactivada",
      "backupTitle": "Desa els codis de seguretat",
      "backupDescription": "Si perds el mòbil, cada codi et permet iniciar sessió una vegada. Guarda'ls en un lloc segur: no es tornaran a mostrar.",
      "copy": "Copia els codis",
      "copied": "S'han copiat els codis de seguretat.",
      "savedThem": "Ja els he desat",
      "regenerate": "Obtén codis de seguretat nous",
      "regenerateDescription": "Els codis de seguretat anteriors deixaran de funcionar.",
      "remaining": "Queden {{count}} codis de seguretat",
      "row": "Un segon pas en iniciar sessió"
    }
  }
};
export default dict;
