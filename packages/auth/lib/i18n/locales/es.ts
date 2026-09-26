import type { LocaleDict } from '../types';

/**
 * Spanish (es-ES) translation dictionary for the auth web app.
 *
 * Tone: informal "tú" — matches the rest of the Oxy ecosystem.
 */
const es: LocaleDict = {
  language: {
    picker: {
      label: 'Idioma',
      ariaLabel: 'Elegir idioma',
    },
  },
  mcpLink: {
    title: 'Conectar esta cuenta a {{client}}',
    subtitle: 'Al aprobar, añades {{handle}} a la conexión de {{app}} que tu asistente ya tiene. Tus otras cuentas no se ven afectadas.',
    scopesTitle: 'Qué podrá hacer la conexión con esta cuenta',
    revokeHint: 'Esta cuenta recibe su propia autorización. Puedes revocarla cuando quieras desde los ajustes de Oxy, sin tocar las demás cuentas de la conexión.',
    alreadyLinked: '{{handle}} ya está conectada. Aprobar de nuevo solo la renueva.',
    approve: 'Conectar esta cuenta',
    useAnother: 'Usar otra cuenta',
    thisAccount: 'esta cuenta',
    theAssistant: 'tu asistente',
    connectedTitle: 'Cuenta conectada',
    connectedDesc: '{{handle}} ya está disponible en {{client}}. Vuelve y pídele que cambie a esta cuenta.',
    noRequestTitle: 'No hay ninguna solicitud de conexión',
    noRequestDesc: 'Esta página se abre desde un enlace que genera tu asistente. Pídele que conecte otra cuenta.',
    unavailableTitle: 'Este enlace ya no es válido',
    unavailableDesc: 'Los enlaces de cuenta son de un solo uso y caducan pronto. Pide uno nuevo a tu asistente.',
    errors: {
      loadFailed: 'No se pudo cargar esta solicitud de conexión.',
      approveFailed: 'No se pudo conectar la cuenta. Pide un enlace nuevo a tu asistente.',
      switchFailed: 'No se pudo seleccionar esa cuenta. Vuelve a iniciar sesión para continuar.',
    },
  },
  device: {
    noRequestTitle: 'No hay ninguna solicitud de inicio de sesión',
    noRequestDesc: 'Esta página se abre desde el enlace que muestra un dispositivo al pedirte que inicies sesión; por ejemplo, "codea login" en una terminal.',
    unavailableTitle: 'Esta solicitud de inicio de sesión no se puede usar',
    loadFailed: 'No se encontró esta solicitud de inicio de sesión. Vuelve a empezar en tu dispositivo.',
    codeHint: 'Continúa solo si este código coincide con el que muestra tu dispositivo:',
    ackVerified: 'He iniciado yo este inicio de sesión en {{app}}.',
    ackUnverified: 'No pudimos verificar de dónde viene esta solicitud. Entiendo el riesgo y he iniciado yo este inicio de sesión en {{app}}.',
    approvedTitle: 'Sesión iniciada',
    approvedDesc: '{{app}} continuará por su cuenta. Ya puedes cerrar esta pestaña.',
    deniedTitle: 'Inicio de sesión rechazado',
    deniedDesc: 'No se ha autorizado nada. Ya puedes cerrar esta pestaña.',
    errors: {
      approveFailed: 'No se pudo completar el inicio de sesión. Vuelve a empezar en tu dispositivo.',
      noToken: 'Tu sesión ha caducado. Vuelve a iniciar sesión para continuar.',
      switchFailed: 'No se pudo seleccionar esa cuenta. Vuelve a iniciar sesión para continuar.',
    },
  },
  authorize: {
    title: 'Continuar a {{app}}',
    cancel: 'Cancelar',
    signingIn: 'Iniciando sesión…',
    relayFailedTitle: 'No se pudo completar el inicio de sesión',
    silentUnsupportedTitle: 'Oxy siempre te pregunta antes',
    silentUnsupportedDesc: 'Esta app pidió iniciar tu sesión sin mostrarte nada. Oxy no autoriza el acceso de esa forma. Vuelve a la app e inicia sesión de nuevo.',
    requestTitle: 'Solicitud de autorización',
    requestUnavailable: 'No pudimos cargar los detalles de esta solicitud.',
    completeTitle: 'Autorización completada',
    deniedTitle: 'Autorización denegada',
    completeChild: 'Esta ventana se cerrará automáticamente.',
    completeDesc: 'Puedes cerrar esta ventana.',
    deniedDesc: 'La solicitud fue denegada. Puedes cerrar esta ventana.',
    noRequestTitle: 'Sin solicitud de autorización',
    noRequestDesc: 'Abre la app en la que quieres iniciar sesión e inténtalo de nuevo. La solicitud de autorización empieza ahí.',
    goToSignIn: 'Ir a iniciar sesión',
    commons: {
      description: 'Apruébalo en Oxy desde tu móvil. No hace falta que inicies sesión aquí primero.',
      openOnThisDevice: 'Tengo Oxy en este dispositivo',
      signInHere: 'Iniciar sesión en este dispositivo',
      errors: {
        startFailed: 'No pudimos iniciar esta solicitud. Inténtalo de nuevo.',
        requestExpired: 'Esta solicitud caducó antes de que se aprobara.',
        unreachable: 'Perdimos el contacto con esta solicitud y no pudimos saber si se aprobó.',
        finalizeFailed: 'No pudimos completar esta autorización. Inicia una solicitud nueva para volver a intentarlo.',
        redirectMismatch: 'Esta autorización no se pudo entregar de forma segura. Vuelve a la app y empieza de nuevo.',
      },
    },
  },
};

export default es;
