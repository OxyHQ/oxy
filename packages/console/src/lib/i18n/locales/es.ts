import type { LocaleDict } from '../types';

/**
 * Spanish (es-ES) translation dictionary for the Oxy Cloud Console.
 *
 * Tone: informal "tú" — matches the rest of the Oxy ecosystem.
 */
const es: LocaleDict = {
  common: {
    cancel: 'Cancelar',
    save: 'Guardar',
    continue: 'Continuar',
    back: 'Atrás',
    next: 'Siguiente',
    delete: 'Eliminar',
    edit: 'Editar',
    create: 'Crear',
    update: 'Actualizar',
    confirm: 'Confirmar',
    loading: 'Cargando…',
    error: 'Error',
    success: 'Listo',
    copy: 'Copiar',
    copied: 'Copiado',
    search: 'Buscar',
    settings: 'Ajustes',
    learnMore: 'Más información',
  },

  app: {
    name: 'Oxy Cloud',
    title: 'Consola de Oxy Cloud',
  },

  language: {
    picker: {
      label: 'Idioma',
      ariaLabel: 'Elegir idioma',
    },
  },

  nav: {
    dashboard: 'Panel',
    apps: 'Apps',
    models: 'Modelos',
    playground: 'Playground',
    usage: 'Uso',
    billing: 'Facturación',
    documentation: 'Documentación',
    examples: 'Ejemplos',
    settings: 'Ajustes',
  },

  dashboard: {
    title: 'Panel',
    subtitle: 'Tu actividad en Oxy Cloud de un vistazo.',
    sections: {
      recentActivity: 'Actividad reciente',
      yourApps: 'Tus apps',
      quickActions: 'Acciones rápidas',
    },
  },

  apps: {
    title: 'Apps',
    subtitle: 'Gestiona apps de desarrollador y sus credenciales.',
    empty: {
      title: 'Aún no tienes apps',
      subtitle: 'Crea tu primera app para empezar a integrar con Oxy.',
      cta: 'Crear app',
    },
    create: {
      title: 'Crear app nueva',
      nameLabel: 'Nombre de la app',
      namePlaceholder: 'Mi app increíble',
      submit: 'Crear app',
    },
    keys: {
      title: 'Credenciales',
      subtitle: 'Gestiona las credenciales de esta app.',
      create: 'Crear credencial',
      reveal: 'Mostrar una vez',
      copyValue: 'Copiar client ID',
      copySecret: 'Copiar secreto',
      revealHint:
        'Los secretos se muestran solo una vez al crearlos. Copia el tuyo ahora — Oxy no volverá a mostrarlo. El client ID es público y puedes copiarlo cuando quieras.',
    },
    usage: {
      title: 'Uso',
      subtitle: 'Solicitudes, tokens y cuota de esta app.',
    },
    settings: {
      title: 'Ajustes de la app',
      delete: {
        title: 'Eliminar app',
        description:
          'Eliminar esta app revoca sus claves de forma permanente y finaliza todas las sesiones activas. No se puede deshacer.',
        cta: 'Eliminar app',
        confirmTitle: '¿Eliminar esta app?',
        confirmBody: 'Escribe el nombre de la app para confirmar.',
      },
    },
  },

  billing: {
    title: 'Facturación',
    subtitle: 'Planes, facturas y métodos de pago.',
    sections: {
      plan: 'Plan',
      invoices: 'Facturas',
      paymentMethod: 'Método de pago',
    },
  },

  usage: {
    title: 'Uso',
    subtitle: 'Solicitudes, tokens y límites en tus apps.',
  },

  models: {
    title: 'Modelos',
    subtitle: 'Modelos de IA disponibles y sus capacidades.',
  },

  playground: {
    title: 'Playground',
    subtitle: 'Prueba prompts contra cualquier modelo.',
    send: 'Enviar',
    clear: 'Vaciar conversación',
  },

  documentation: {
    title: 'Documentación',
    quickstart: 'Inicio rápido',
    authentication: 'Autenticación',
    chatCompletions: 'Chat completions',
    sdks: 'SDKs',
    models: 'Modelos',
  },

  settings: {
    title: 'Ajustes de la cuenta',
    account: {
      title: 'Cuenta',
      nameLabel: 'Nombre de la cuenta',
    },
    language: {
      title: 'Idioma',
      subtitle: 'Elige el idioma de la interfaz.',
    },
  },

  examples: {
    title: 'Ejemplos',
  },

  account: {
    signedInAs: 'Sesión iniciada como {{name}}',
    signOut: 'Cerrar sesión',
  },
};

export default es;
