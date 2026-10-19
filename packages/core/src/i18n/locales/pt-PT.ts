const dict = {
  signin: {
    title: 'Iniciar sessão',
    subtitle: 'Usa a tua conta Oxy',
    addAccountTitle: 'Adicionar outra conta',
    addAccountSubtitle: 'Iniciar sessão com outra conta',
    actions: {
      continue: 'Continuar',
      back: 'Voltar',
    },
    createAccountLink: 'Novo no Oxy? Crie uma conta',
    status: {
      signingIn: 'A iniciar sessão…',
    },
    subtitleToApp: 'para continuar para {{app}}',
    orContinueWith: 'ou continua com',
    qr: {
      caption: 'Lê com o Commons para entrar',
      renew: 'Mostrar um código novo',
    },
    errors: {
      rateLimited: 'Demasiadas tentativas. Tenta novamente dentro de {{seconds}} s.',
      invalidCredentials:
        'O nome de utilizador, o email ou a palavra-passe não estão certos. Se várias contas usam este email, entra com o nome de utilizador.',
      emailAccountsFull: 'Este email já tem todas as contas que pode ter.',
      codeInvalid: 'Esse código não está certo ou expirou.',
      requestExpired: 'Este início de sessão expirou. Envia um novo email.',
      secondFactorInvalid: 'Esse código não está certo. Experimenta o atual.',
      originNotAllowed: 'Não é possível iniciar sessão aqui.',
      generic: 'Algo correu mal. Tenta novamente.',
      notConfigured: 'Não é possível iniciar sessão',
      notConfiguredDescription:
        '{{app}} ainda não está configurada para iniciar sessão. Contacta quem desenvolve a app.',
      failed: 'Não foi possível iniciar sessão',
      failedDescription: 'Algo correu mal. Tenta novamente.',
    },
    emailAccounts: {
      title: 'Escolhe uma conta',
      description: '{{identifier}} tem várias contas. Escolhe com qual queres entrar.',
    },
    chooser: {
      subtitleToApp: 'para continuar para {{app}}',
      title: 'Escolhe uma conta',
      subtitle: 'Continua com uma das tuas contas ou usa outra.',
      useAnother: 'Usar outra conta',
      continueAs: 'Continuar como {{name}}',
    },
    terms: {
      before: 'Ao continuar, aceitas os nossos',
      termsLink: 'Termos de serviço',
      and: 'e a',
      privacyLink: 'Política de privacidade',
    },
    noAccount: 'Não tens conta?',
    createAccount: 'Criar conta',
    identifier: {
      label: 'Email ou nome de utilizador',
      placeholder: 'tu@exemplo.pt',
      required: 'Escreve o teu email ou nome de utilizador.',
    },
    checkEmail: {
      title: 'Vê o teu email',
      description:
        'Se houver uma conta com {{identifier}}, enviámos-lhe um código e uma ligação para iniciar sessão.',
      codeLabel: 'Código',
      codeHint: 'Escreve o código do email ou abre a ligação dele neste navegador.',
      codeHasLetters: 'O teu código tem letras?',
      codeDigitsOnly: 'O teu código só tem números?',
      resend: 'Enviar um novo email',
      resendIn: 'Enviar um novo email dentro de {{seconds}} s',
      resent: 'Enviámos um novo email.',
      retryLater: 'Já enviámos vários emails. Espera alguns minutos e tenta novamente.',
      usePassword: 'Usar antes a palavra-passe',
      differentAccount: 'Usar outra conta',
    },
    password: {
      title: 'Escreve a tua palavra-passe',
      label: 'Palavra-passe',
      required: 'Escreve a tua palavra-passe.',
      forgot: 'Esqueceste-a? Recebe um código por email',
    },
    secondFactor: {
      title: 'Verificação em dois passos',
      description: 'Escreve o código da tua app de autenticação.',
      backupDescription: 'Escreve um dos teus códigos de segurança. Cada um só funciona uma vez.',
      label: 'Código de autenticação',
      backupLabel: 'Código de segurança',
      useBackup: 'Usar um código de segurança',
      useAuthenticator: 'Usar a tua app de autenticação',
    },
    link: {
      approvedTitle: 'Tens sessão iniciada',
      approvedDescription:
        'Volta à app onde pediste para iniciar sessão: ela continua sozinha. Podes fechar este separador.',
      otherDeviceTitle: 'Abre a ligação no mesmo navegador',
      otherDeviceDescription:
        'Esta ligação só funciona no navegador onde pediste para iniciar sessão. Abre-a lá ou escreve na app o código do email.',
      invalidTitle: 'Esta ligação não pode ser usada',
      invalidDescription:
        'Expirou ou já foi usada. Pede um novo email na app ou escreve o código do mais recente.',
    },
  },
  signup: {
    title: 'Cria a tua conta',
    subtitle: 'Escolhe o teu nome de utilizador. Depois confirmamos o teu email.',
    createInCommons: 'Criá-la antes no Commons',
    backToSignInLink: 'Já tens conta? Inicia sessão',
    username: {
      label: 'Nome de utilizador',
      placeholder: 'oteunome',
      required: 'Escolhe um nome de utilizador.',
      taken: 'Esse nome de utilizador já está em uso.',
    },
    email: {
      title: 'Qual é o teu email?',
      subtitle:
        'É com ele que inicias sessão: enviamos-te um código de cada vez. Mais ninguém o vê.',
      label: 'Email',
      placeholder: 'tu@exemplo.pt',
      invalid: 'Escreve um email válido.',
    },
    commonsSubtitle: 'Ou cria a tua identidade no Commons e guarda a tua própria chave.',
    laterNote:
      'Mais tarde podes adicionar uma palavra-passe ou uma app de autenticação nas definições de segurança da tua conta.',
  },
  accountSwitcher: {
    loading: 'A carregar contas...',
    qrHeadline: 'Inicie sessão com a sua identidade Oxy',
    signInWithOxy: 'Iniciar sessão com Oxy',
    signUpWithOxy: 'Registar-se com Oxy',
    getCommons: 'Obter o Commons',
    commonsNotInstalled: 'Não tem o Commons? Obtenha a app para iniciar sessão com o seu Oxy ID.',
    showQrAnyway: 'Tenho o Commons noutro dispositivo',
    switchWhileSignedInAs: 'Mudar de conta, com sessão iniciada como {{name}}',
    manageOnDevice: 'Gerir contas neste dispositivo',
    continueWithOxy: 'Continuar com Oxy',
    havingTrouble: 'Algum problema?',
    progress: {
      preparing: 'A preparar o pedido',
      awaitingApproval: 'A aguardar aprovação',
      scanWithCommons: 'Digitalize com o Commons no seu telemóvel',
      continueInCommons: 'Continue no Commons',
      checkCommons: 'Verifique o Commons no seu telemóvel',
      openedInCommons: 'Aberto no Commons',
      confirming: 'A confirmar a identidade',
      confirmed: 'Identidade confirmada',
    },
    signInFailures: {
      denied: 'O início de sessão foi recusado no Commons.',
      expired: 'O pedido de início de sessão expirou. Tente novamente.',
      network: 'Não foi possível contactar a Oxy. Verifique a ligação e tente novamente.',
      notConfigured: 'Esta app ainda não está preparada para iniciar sessão.',
      unsupportedFlow: 'Este início de sessão não pode ser concluído aqui.',
      claimFailed:
        'O início de sessão foi aprovado, mas não conseguimos concluí-lo. Tente novamente.',
      generic: 'Não foi possível iniciar sessão. Tente novamente.',
    },
    linkOpenFailed: 'Não foi possível abrir a ligação. Tente novamente.',
  },
  common: {
    stepOf: 'Passo {{step}} de {{total}}',
    actions: {
      back: 'Voltar',
      continue: 'Continuar',
      next: 'Seguinte',
      getStarted: 'Começar',
      createAccount: 'Criar conta',
      signIn: 'Iniciar sessão',
      verify: 'Verificar',
      resetPassword: 'Repor palavra-passe',
      signedOut: 'Sessão terminada',
      close: 'Fechar',
      tryAgain: 'Tentar novamente',
    },
    links: {
      recoverAccount: 'Recuperar a sua conta',
      signUp: 'Registar-se',
    },
    labels: {
      username: 'Nome de utilizador',
      email: 'Email',
      password: 'Palavra-passe',
      confirmPassword: 'Confirmar palavra-passe',
    },
    revoke: 'Revoke',
    errors: {
      signOutAllFailed:
        'Ocorreu um problema ao terminar sessão em todas as contas. Tente novamente.',
    },
  },
  notifications: {
    title: 'Notifications',
    subtitle: 'Manage push, email, and security alerts',
    updateError: 'Failed to update notification preferences',
    sections: {
      channels: 'Channels',
      alerts: 'Alerts',
      marketing: 'Marketing',
    },
    items: {
      push: {
        title: 'Push notifications',
        subtitle: 'Real-time alerts on your devices',
      },
      emailDigest: {
        title: 'Email digest',
        subtitle: 'Periodic summary of your account activity',
      },
      securityAlerts: {
        title: 'Security alerts',
        subtitle: 'Sign-ins, recovery codes, and key changes',
      },
      marketingEmails: {
        title: 'Marketing emails',
        subtitle: 'Product news and occasional offers',
      },
    },
  },
  preferences: {
    title: 'Preferences',
    subtitle: 'Theme, motion, and regional settings',
    sections: {
      appearance: 'Appearance',
      language: 'Language',
      region: 'Region',
    },
    theme: {
      light: 'Light',
      dark: 'Dark',
      system: 'System default',
    },
    items: {
      theme: {
        title: 'Theme',
      },
      reduceMotion: {
        title: 'Reduce motion',
        subtitle: 'Minimise animations across Oxy apps',
        systemOn: 'Following system: reduce motion is on',
      },
      language: {
        title: 'Language',
      },
      timezone: {
        title: 'Timezone',
        unknown: 'Unable to detect timezone',
      },
      about: {
        title: 'About preferences',
        subtitle: 'Preferences sync across every Oxy app you sign into',
      },
    },
  },
  connectedApps: {
    title: 'Connected apps',
    subtitle: 'Manage third-party app access',
    empty: {
      title: 'No connected apps',
      subtitle: 'Apps you authorize to sign in with your Oxy account will appear here',
    },
    item: {
      granted: 'Concedido {{relative}}',
      lastUsed: 'Last used {{relative}}',
    },
    confirm: {
      title: 'Revoke access',
      message: "Revoke {{name}}'s access to your Oxy account?",
    },
    toasts: {
      revoked: 'Revoked access for {{name}}',
      revokeFailed: 'Failed to revoke access',
    },
  },
  accountMenu: {
    label: 'Menu da conta',
    manage: 'Gerir a sua conta Oxy',
    viewProfile: 'Ver perfil',
    addAnother: 'Adicionar outra conta',
    signOutAll: 'Terminar sessão em todas as contas',
    open: 'Menu da conta',
    openHint: 'Abre o menu da conta',
    openWithUser: 'Menu da conta de {{name}}',
    switching: 'A mudar de conta…',
    signOutAccount: 'Terminar sessão de {{name}}',
    greeting: 'Olá, {{name}}!',
    switchAccount: 'Mudar de conta',
    storage: {
      title: 'Armazenamento Oxy',
      usage: '{{used}} de {{total}} em uso',
      used: 'Em uso',
      free: 'Livre',
      unavailable: 'Detalhes de utilização indisponíveis',
      upgrade: 'Atualizar plano',
      manage: 'Gerir armazenamento',
    },
    data: 'Os seus dados no Oxy',
    settings: 'Definições do Oxy',
    help: 'Ajuda e feedback',
    signOut: 'Terminar sessão',
    privacy: 'Política de privacidade',
    terms: 'Termos de serviço',
  },
  emailCode: {
    title: 'Vê o teu email',
    sentTo: 'Enviámos um código de 6 dígitos para {{email}}.',
    label: 'Código',
    resend: 'Enviar um novo código',
    resent: 'Enviámos um novo código.',
    changeEmail: 'Usar outro email',
    errors: {
      codeInvalid: 'Esse código não está certo ou expirou.',
      tooManyAttempts: 'Demasiados códigos errados. Pede um novo.',
      expired: 'Passou demasiado tempo. Recomeça.',
      unavailable: 'O Oxy não consegue enviar emails agora. Tenta mais tarde.',
      rateLimited: 'Demasiados códigos. Tenta mais tarde.',
    },
  },
  deleteAccount: {
    keyless: {
      subtitle:
        '@{{username}} e tudo o que contém são eliminados para sempre. Escreve o teu nome de utilizador e confirma com um código que te enviamos por email.',
      action: 'Eliminar conta',
      done: 'A tua conta foi eliminada.',
      doneDescription: 'Terminaste sessão.',
      keyed:
        'Esta conta usa o Commons: elimina-a no Oxy Commons, Definições > Eliminar conta, com a sua chave.',
    },
    handoff: {
      elsewhereMessage:
        'Eliminar a tua conta requer a tua chave de identidade, e ela não está neste dispositivo. Abre o Oxy Commons no dispositivo que a guarda e vai a Definições > Eliminar conta.',
    },
  },
  linkCommons: {
    title: 'Associar o Commons',
    subtitle:
      'Guarda a tua própria chave: associa o Commons e esta conta passa a ser só tua. O email é eliminado e a tua frase de recuperação no Commons é como voltas a entrar.',
    scan: 'No telemóvel, abre o Commons, escolhe «Tenho uma conta Oxy na web» e digitaliza este código.',
    waiting: 'À espera do Commons…',
    compareTitle: 'Verifica o código',
    compare: 'O Commons mostra o mesmo código. Se não mostrar, cancela.',
    confirm: 'Sim, associar o Commons',
    cancel: 'Cancelar',
    doneTitle: 'O Commons está associado',
    done: 'Esta conta passou a ser de autocustódia. O email foi eliminado: a tua frase de recuperação no Commons é como voltas a entrar.',
    already: 'Esta conta já usa o Commons.',
    expired: 'Este código expirou.',
    renew: 'Mostrar um novo código',
    failed: 'Não foi possível associar o Commons. Tenta de novo.',
    confirmTitle: 'Confirma a associação',
    confirmDescription:
      'Para terminar, confirma que és tu com um código que te enviamos por email.',
    confirmPasswordDescription: 'Para terminar, confirma que és tu com a tua palavra-passe.',
    row: 'Guarda a tua própria chave com o Commons',
  },
  reauth: {
    title: 'Confirma que és tu',
    emailDescription: 'Vamos enviar um código para o teu email para confirmar esta alteração.',
    sendCode: 'Enviar código',
    codeSent: 'Enviámos um código de 6 dígitos para o teu email.',
    codeLabel: 'Código do email',
    passwordLabel: 'Palavra-passe atual',
    usePassword: 'Usar antes a palavra-passe',
    useEmail: 'Receber antes um código por email',
    errors: {
      invalid: 'Não resultou. Verifica o que escreveste e tenta novamente.',
      totpRequired: 'Escreve também o código da tua app de autenticação.',
    },
  },
  signInSecurity: {
    title: 'Início de sessão e segurança',
    subtitle: 'Email, palavra-passe, app de autenticação e onde tens sessão iniciada',
    methodsTitle: 'Como inicias sessão',
    notPersonal:
      'Só uma conta pessoal inicia sessão com email, palavra-passe ou app de autenticação.',
    loadFailed: 'Não foi possível carregar como esta conta inicia sessão.',
    retry: 'Tentar de novo',
    noEmailWarning:
      'Esta conta não tem email. Só podes entrar com a tua palavra-passe e, se a esqueceres, não há forma de recuperar a conta.',
    status: {
      on: 'Ativada',
      off: 'Desativada',
    },
    commons: {
      title: 'Commons',
    },
    errors: {
      lastSignInMethod: 'É a tua única forma de iniciar sessão. Adiciona outra primeiro.',
      passwordRequired: 'Define primeiro uma palavra-passe e confirma com ela.',
      emailUnchanged: 'Esse já é o teu email.',
    },
    email: {
      title: 'Email',
      none: 'Sem email',
      description:
        'Os códigos e links para iniciar sessão e os avisos de segurança chegam a este endereço.',
      noneDescription:
        'Adiciona um email para iniciar sessão com um código ou um link, e para recuperar a conta se esqueceres a palavra-passe.',
      change: 'Alterar email',
      add: 'Adicionar um email',
      remove: 'Remover email',
      removeNeedsPassword:
        'Para remover o teu email, define primeiro uma palavra-passe: será a tua única forma de iniciar sessão.',
      newLabel: 'Novo endereço de email',
      newDescription: 'Vamos enviar um código para o novo endereço para confirmar que é teu.',
      invalid: 'Escreve um endereço de email válido.',
      sendCode: 'Enviar código',
      confirmTitle: 'Confirma o novo email',
      confirmDescription: 'Escreve o código que enviámos para {{email}} e confirma que és tu.',
      codeLabel: 'Código enviado para o novo email',
      save: 'Guardar email',
      saved: 'O teu email foi atualizado. A sessão foi terminada nos outros dispositivos.',
      removeTitle: 'Remover o teu email',
      removeDescription:
        'Só vais poder iniciar sessão com a tua palavra-passe. Se a esqueceres, não há forma de recuperar a conta. Confirma com a tua palavra-passe.',
      removed: 'O teu email foi removido. A sessão foi terminada nos outros dispositivos.',
    },
    password: {
      title: 'Palavra-passe',
      setTitle: 'Definir uma palavra-passe',
      changeTitle: 'Alterar a palavra-passe',
      description:
        'Inicia sessão com a tua palavra-passe em vez de um código por email. Usa pelo menos {{min}} caracteres.',
      newLabel: 'Nova palavra-passe',
      repeatLabel: 'Repete a palavra-passe',
      tooShort: 'Usa pelo menos {{min}} caracteres.',
      mismatch: 'As palavras-passe não coincidem.',
      signOutOthers: 'Terminar sessão em todos os outros sítios',
      save: 'Guardar palavra-passe',
      saved: 'A tua palavra-passe foi guardada.',
      row: 'Opcional: iniciar sessão com palavra-passe',
      remove: 'Remover palavra-passe',
      removeTitle: 'Remover a tua palavra-passe',
      removeDescription: 'Vais iniciar sessão com um código ou um link enviado para o teu email.',
      removed: 'A tua palavra-passe foi removida. A sessão foi terminada nos outros dispositivos.',
    },
    totp: {
      title: 'App de autenticação',
      description:
        'Depois do código por email ou da palavra-passe, o Oxy pede também um código de uma app como o Google Authenticator ou o 1Password.',
      setUp: 'Configurar',
      scan: 'Lê este código QR com a tua app de autenticação ou escreve a chave de configuração.',
      secretLabel: 'Chave de configuração',
      codeLabel: 'Código da app',
      enable: 'Ativar',
      enabled: 'A app de autenticação está ativada.',
      disable: 'Desativar a app de autenticação',
      disabled: 'A app de autenticação está desativada.',
      on: 'Ativada',
      off: 'Desativada',
      backupTitle: 'Guarda os teus códigos de segurança',
      backupDescription:
        'Se perderes o telemóvel, cada código permite-te iniciar sessão uma vez. Guarda-os num local seguro: não voltam a ser mostrados.',
      copy: 'Copiar códigos',
      copied: 'Códigos de segurança copiados.',
      savedThem: 'Já os guardei',
      regenerate: 'Obter novos códigos de segurança',
      regenerateDescription: 'Os teus códigos de segurança antigos deixam de funcionar.',
      remaining: 'Restam {{count}} códigos de segurança',
      row: 'Um segundo passo ao iniciar sessão',
      onWithCodes: 'Ativada · restam {{count}} códigos de segurança',
    },
  },
  fileManagement: {
    deleteFile: 'Eliminar ficheiro',
    confirm: 'Confirmar',
    retry: 'Tentar novamente',
    loadError: {
      description: 'Algo correu mal. Verifique a sua ligação e tente novamente.',
    },
    moveToTrash: 'Mover para o lixo',
    moveToTrashCount: 'Mover para o lixo ({{count}})',
    appAccess: {
      title: 'Apps com acesso',
      description:
        'Estas apps podem abrir este ficheiro por si. Revogue uma app para lhe retirar esse acesso.',
      empty: 'Nenhuma app pode abrir este ficheiro por si.',
      loadError: 'Não foi possível carregar as apps que podem abrir este ficheiro',
      via: {
        upload: 'Guardou este ficheiro por si',
        link: 'Foi partilhado por si',
      },
      revoke: 'Revogar',
      confirm: {
        title: 'Revogar {{name}}?',
        message:
          '{{name}} deixará de poder abrir este ficheiro e qualquer reprodução que tenha iniciado termina agora.',
      },
      toasts: {
        revoked: '{{name}} já não pode abrir este ficheiro',
        revokeFailed: 'Não foi possível revogar o acesso de {{name}}',
      },
      a11y: {
        revoke: 'Revogar o acesso de {{name}} a este ficheiro',
      },
    },
    trashView: {
      title: 'Lixo',
      subtitle: 'Restaure ficheiros ou elimine-os definitivamente',
      notice:
        'Os ficheiros ficam no lixo até os restaurar ou eliminar, e continuam a contar para o seu armazenamento.',
      emptyTitle: 'O lixo está vazio',
      emptyDescription:
        'Os ficheiros que mover para o lixo aparecem aqui. Pode restaurá-los ou eliminá-los definitivamente.',
      trashedOn: 'Movido para o lixo a {{date}}',
      deleteForever: 'Eliminar definitivamente',
      loadError: 'Não foi possível carregar o lixo',
      a11y: {
        restore: 'Restaurar {{name}}',
        deleteForever: 'Eliminar {{name}} definitivamente',
      },
    },
    a11y: {
      moveToTrash: 'Mover {{name}} para o lixo',
      deleteFile: 'Eliminar {{name}}',
      openTrash: 'Abrir o lixo',
    },
    toasts: {
      movedToTrash: 'Movido para o lixo. Pode restaurá-lo a partir do lixo.',
      bulkMovedToTrash: '{{count}} ficheiro(s) movido(s) para o lixo',
      moveToTrashFailed: 'Não foi possível mover o ficheiro para o lixo',
      restored: 'Ficheiro restaurado',
      notInTrash: 'Este ficheiro já não está no lixo.',
      restoreFailed: 'Não foi possível restaurar o ficheiro',
      deletedForever: 'Ficheiro eliminado definitivamente',
      deleteSuccess: 'Ficheiro eliminado',
      deleteFailed: 'Não foi possível eliminar o ficheiro',
      fileNotFound: 'Ficheiro não encontrado. Pode já ter sido eliminado.',
      noPermission: 'Não tem permissão para eliminar este ficheiro.',
      bulkDeleteSuccess: '{{count}} ficheiro(s) eliminado(s)',
      bulkDeleteFailed: 'Não foi possível eliminar {{count}} ficheiro(s)',
      bulkDeleteError: 'Não foi possível eliminar os ficheiros',
    },
    confirms: {
      deleteFile:
        'Tem a certeza de que pretende eliminar «{{filename}}»? Esta ação não pode ser anulada.',
      moveToTrash:
        'Mover «{{filename}}» para o lixo? Deixa de ser mostrado em qualquer lado e pode restaurá-lo a partir do lixo.',
      moveFilesToTrash:
        'Mover {{count}} ficheiro(s) para o lixo? Deixam de ser mostrados em qualquer lado e pode restaurá-los a partir do lixo.',
      deleteForever: 'Eliminar «{{filename}}» definitivamente? Esta ação não pode ser anulada.',
      deleteForeverInUse:
        '«{{filename}}» ainda é usado em {{count}} sítio(s) nas suas aplicações. Ao eliminá-lo, desaparece também daí. Eliminá-lo definitivamente?',
    },
  },
};
export default dict;
