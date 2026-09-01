import type { LocaleDict } from '../types';

/**
 * Spanish (es-ES) translation dictionary for the auth web app.
 *
 * Tone: informal "tú" — matches the rest of the Oxy ecosystem.
 */
const es: LocaleDict = {
  common: {
    cancel: 'Cancelar',
    save: 'Guardar',
    continue: 'Continuar',
    back: 'Atrás',
    signOut: 'Cerrar sesión',
    delete: 'Eliminar',
    loading: 'Cargando…',
    error: 'Error',
    success: 'Listo',
  },

  app: {
    name: 'Oxy',
    title: 'Inicia sesión · Oxy',
  },

  language: {
    picker: {
      label: 'Idioma',
      ariaLabel: 'Elegir idioma',
    },
  },

  footer: {
    terms: 'Términos',
    privacy: 'Privacidad',
    help: 'Ayuda',
    copyright: '© {{year}} Oxy',
  },

  settings: {
    title: 'Ajustes de la cuenta',
    sections: {
      password: 'Contraseña',
      sessions: 'Sesiones',
      linkedAccounts: 'Cuentas vinculadas',
      language: 'Idioma',
    },
    password: {
      title: 'Cambiar contraseña',
      currentLabel: 'Contraseña actual',
      newLabel: 'Nueva contraseña',
      confirmLabel: 'Confirma la nueva contraseña',
      submit: 'Cambiar contraseña',
      success: 'Contraseña cambiada.',
      error: 'No se pudo cambiar la contraseña.',
    },
    sessions: {
      title: 'Sesiones activas',
      subtitle: 'Dispositivos con sesión iniciada en tu cuenta.',
      currentBadge: 'Este dispositivo',
      revoke: 'Cerrar sesión',
      revokeAll: 'Cerrar sesión en los demás dispositivos',
      revokedToast: 'Sesión cerrada.',
      empty: 'No hay otras sesiones activas.',
    },
    linkedAccounts: {
      title: 'Cuentas vinculadas',
      subtitle: 'Proveedores externos conectados a tu cuenta de Oxy.',
      link: 'Vincular',
      unlink: 'Desvincular',
      none: 'No hay cuentas vinculadas.',
    },
  },

  authorize: {
    title: 'Continuar a {{app}}',
    subtitle:
      'Usa tu cuenta de Oxy para iniciar sesión en {{app}}. Revisa qué implica esta conexión antes de continuar.',
    benefits: {
      title: 'Qué implica esto',
      secure:
        'Inicia sesión de forma segura con tu cuenta de Oxy, sin nuevas contraseñas',
      oneAccount: 'Una sola cuenta para todas las apps de Oxy',
      youControl:
        'Tú decides qué compartes y puedes revocar el acceso cuando quieras',
    },
    provenance: {
      title: 'Quién solicita acceso',
      official: 'Aplicación oficial de Oxy',
      internal: 'Aplicación interna de Oxy',
      developer: 'Publicada por {{developer}}',
      thirdParty: 'Aplicación de terceros',
    },
    permissions: {
      title: 'Permisos solicitados',
      basic: 'Iniciar sesión y leer tu perfil básico',
    },
    continue: 'Continuar a {{app}}',
    cancel: 'Cancelar',
    notYou: '¿No eres tú?',
    switchAccount: 'Usar otra cuenta',
    disclaimer:
      'Al continuar, {{app}} podrá iniciar sesión con tu cuenta de Oxy. Puedes gestionar las apps conectadas cuando quieras en los ajustes de tu cuenta de Oxy.',
    expiresAt: 'La solicitud caduca a las {{time}}.',
    signingIn: 'Iniciando sesión…',
    // La entrega por ventana emergente informó de un fallo a la app que abrió
    // esta ventana.
    relayFailedTitle: 'No se pudo completar el inicio de sesión',
    // Una solicitud que pedía completarse sin mostrar nada (`prompt=none`). Oxy
    // nunca autoriza sin preguntarte, así que se rechaza.
    silentUnsupportedTitle: 'Oxy siempre te pregunta antes',
    silentUnsupportedDesc:
      'Esta app pidió iniciar tu sesión sin mostrarte nada. Oxy no autoriza el acceso de esa forma. Vuelve a la app e inicia sesión de nuevo.',
    requestTitle: 'Solicitud de autorización',
    requestUnavailable: 'No pudimos cargar los detalles de esta solicitud.',
    completeTitle: 'Autorización completada',
    deniedTitle: 'Autorización denegada',
    completeChild: 'Esta ventana se cerrará automáticamente.',
    completeDesc: 'Puedes cerrar esta ventana.',
    deniedDesc: 'La solicitud fue denegada. Puedes cerrar esta ventana.',
    noRequestTitle: 'Sin solicitud de autorización',
    noRequestDesc:
      'Abre la app en la que quieres iniciar sesión e inténtalo de nuevo. La solicitud de autorización empieza ahí.',
    goToSignIn: 'Ir a iniciar sesión',
    // La vía de Commons: aprobar la autorización directamente en Oxy, sin
    // iniciar sesión antes en este sitio. El titular y los mensajes de progreso
    // vienen del diccionario compartido `accountSwitcher.*` de `@oxyhq/core`,
    // así que aquí solo viven las cadenas propias de esta vía.
    commons: {
      description:
        'Apruébalo en Oxy desde tu móvil. No hace falta que inicies sesión aquí primero.',
      openOnThisDevice: 'Tengo Oxy en este dispositivo',
      signInHere: 'Iniciar sesión en este dispositivo',
      errors: {
        startFailed: 'No pudimos iniciar esta solicitud. Inténtalo de nuevo.',
        requestExpired: 'Esta solicitud caducó antes de que se aprobara.',
        unreachable: 'Perdimos el contacto con esta solicitud y no pudimos saber si se aprobó.',
        finalizeFailed:
          'No pudimos completar esta autorización. Inicia una solicitud nueva para volver a intentarlo.',
        redirectMismatch:
          'Esta autorización no se pudo entregar de forma segura. Vuelve a la app y empieza de nuevo.',
      },
    },
  },
};

export default es;
