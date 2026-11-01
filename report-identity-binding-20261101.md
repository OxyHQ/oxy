# Auditoría: identidad síncrona y revisión del bearer

Base: `origin/main` de Oxy, `522628212423f562ad4fff469fd4c98f7b22dc82` (`@oxy.so/core` 7.10.6), en este worktree aislado. La rama no modifica código de producción ni credenciales. El archivo de pruebas no está comprometido.

## Resultado reproducido

El guard de Mention toma su epoch al iniciar la operación y solo rechaza el ID del bearer si es conocido. Si se ha instalado el bearer B mientras React y el estado de dispositivo aún muestran A, el epoch capturado ya es el de B y permanece estable. No prueba que B corresponda a A.

La prueba `packages/core/src/__tests__/opaqueSubjectEpoch.repro.test.ts` ejecuta el cliente y el `refreshDeviceSecretArm` real con almacén en memoria y respuestas HTTP simuladas. Tanto un mint de un bearer opaco para A como uno para B completan correctamente y proporcionan `result.userId` distinto, pero producen los mismos valores públicos al guard: bearer presente, `session.userId === null`, epoch incrementado una vez y proyección retenida en A. No se conecta a ningún servidor ni prueba que el emisor Oxy actual emita bearers opacos. También comprueba que un JWT sintético decodificable con `sub` pero sin `userId` se envía mientras el getter devuelve null; la prueba usa una respuesta simulada y no demuestra que el servidor acepte o emita dicho token. Los tokens reales de Oxy documentados incluyen `userId`.

Matiz de transporte: `HttpService.getAuthHeader()` devuelve null si no puede decodificar el bearer opaco; una petición HTTP implícita de este SDK se envía sin Authorization en ese caso, y `getAuthenticatedAccessToken` rechaza. Por tanto esta reproducción establece una insuficiencia del contrato de identidad local, no una mutación autenticada real bajo B con bearer opaco por dicho transporte.

Comando desde `packages/core`:

```
bun run test --runInBand --runTestsByPath src/__tests__/opaqueSubjectEpoch.repro.test.ts src/session/__tests__/refresh.contextCas.test.ts src/__tests__/httpActorContextFence.test.ts
```

Resultado: tres suites, 26 pruebas superadas, incluidos los conjuntos previos de CAS de refresh y de contextos HTTP. Instalación aislada `bun install --frozen-lockfile --minimum-release-age=0`; no se ha publicado nada.

## Evidencia y límites

- `packages/core/src/HttpService.ts`: `sessionEpoch` cambia ante bearers opacos distintos, pero conserva rotaciones JWT aparentemente del mismo contexto; es una cerca temporal de operaciones, no una revisión de cada cambio de bytes ni una prueba de identidad. La lectura de claims es local y no sustituye validación del servidor.
- `packages/core/src/api/session.ts`: `userId` decodifica `userId`/`id`, no verifica claims y devuelve null para opacos o JWT que solo use `sub`.
- `packages/services/src/ui/context/OxyContext.tsx`: el listener instala el estado de token y programa reconciliación. `createOxyRuntime.ts` reconcilia tras una petición asíncrona de perfiles, por lo que es posible observar el bearer nuevo antes de la nueva proyección.
- `SessionClient.applyState` planta el token antes de notificar: el orden es intencional, y cambiarlo sin un contrato compartido introduciría otras inconsistencias.
- El contrato de mint anterior tiene el token y el estado de dispositivo, pero `DeviceSessionState` es plano y no basta por sí solo para identificar inequívocamente un contexto delegado: varios principales pueden actuar sobre la misma cuenta. La selección por accountId no demuestra el actor. El mint fijado a identidad usa además `accountId` distinto de la cuenta activa del dispositivo.
- `/session/device/context-token-v1` ya entrega token y cuenta, actor, contexto y sesión en una respuesta comprobada por el servidor. Es opt-in account-mode; no admite identidad fijada ni OAuth aislado. No debe extenderse a ellos por inferencia ni añadir llamadas obligatorias por operación.
- El intercambio OAuth devuelve conjuntamente sesión, bearer y `user.id` tras verificar state/PKCE en el finalizador. Debe conservarse la separación de esa sesión, sin dispositivo compartido. Debe verificarse el alcance exacto de su evidencia antes de admitir actor/contexto que no entregue.
- Cold boot, setters públicos de bearer, acceso enlazado y los caminos de sign-in/refresh ofrecen distintos grados de evidencia; no todos pueden dar una asociación conocida de inmediato.

## Contrato propuesto para revisar

Un único snapshot inmutable sin bearer ni hash expuesto, compartido entre core y la proyección de services, con estado conocido/desconocido y un identificador opaco de generación de contexto. Debe asociar cada proyección solo con el bearer exacto al que corresponde una respuesta de autoridad, a través de una revisión interna que cambie en toda sustitución real de bytes y que no reutilice `sessionEpoch`. Un setter sin evidencia invalida inmediatamente la asociación. El cambio de bearer y su evidencia deben hacerse atómicamente antes de notificar; los resultados asíncronos deben comprobar por CAS revisión exacta y ciclo de vida para descartar sustituciones, logout y ABA.

Una operación solo obtiene su lease si la proyección ya está ligada a la misma generación vigente, y sus continuaciones verifican esa generación. Una sustitución con evidencia fiable del mismo contexto puede preservar generación; una sustitución desconocida, otro contexto o sign-out la invalidan. No se debe recuperar la validez de un lease anterior tras A→B→A. Cuando falte evidencia debe quedar desconocido hasta reconciliarse; con una renovación opaca por setter sin evidencia no es posible distinguir correctamente A→A de A→B.

Esta es una cerca de consistencia de cliente, no autorización. El servidor sigue verificando token, sujeto, actor, scopes y revocación. No se deben inferir autoridad, actores ni equivalencia a partir de claims sin verificar, un hash, accountId aislado, un estado React o un valor proporcionado por el consumidor. Se necesita definir primero cómo cada flujo obtiene evidencia y cómo se comportan los cambios durante refresh preflight, respuestas tardías, suscriptores reentrantes y linked clients antes de publicar una API o prometer equivalencia entre plataformas.

## Inventario de escrituras y decisiones pendientes

| Ruta | Evidencia inmediata y trabajo necesario |
| --- | --- |
| `session.setAccessToken`, `HttpService.setTokens` | El setter público solo recibe bytes. Una asociación anterior pasa a desconocida cuando cambian; cambiar su comportamiento de transporte o impedir los setters existentes sería incompatible. |
| `HttpService.syncAccessTokenFromProvider`, `createLinkedClient` | El provider puede cambiar entre notificación y request y los listeners son reentrantes. El espejo requiere sincronizar también la revisión y la asociación sin aceptar una callback ya desfasada. |
| `HttpService.refreshAccessToken` | Un handler de extensión devuelve únicamente token. El refresh gestionado puede haber plantado ya el resultado, pero un handler genérico no prueba identidad: hace falta una vía interna tipada de commit atómico y seguir admitiendo el handler histórico como desconocido. |
| 401, `clearTokens`, `endSession`, `dispose`, reset de test | El 401 limpia el `tokenStore` directamente; todas las rutas deben invalidar la asociación antes de notificar. `endSession` debe invalidar incluso sin token; el reset de test debe conservar la semántica documentada o aislarse de producción. |
| `refreshDeviceSecretArm`, `refreshSharedDeviceArm` | Mint, persistencia y CAS se completan antes de plantar. El resultado plano identifica la cuenta pero no garantiza por sí solo desambiguación del actor: el endpoint v1 une contexto/actor/sesión, con cobertura account-mode limitada. Mantener la prueba del guard de contexto y la rotación concurrente del holder. |
| `SessionClient` apply/commitSync/activate | Las respuestas directas llevan token junto al estado o directorio; un push puede no llevar token, y un restate de igual revisión puede plantar después. Las rutas deben comprobar dispositivo, revisión y pin y preservar la secuencia de notificación. El directorio no debe emparejarse con un token de otra respuesta/revisión. |
| `auth` sign-in, `verifyChallenge`, `claimSession`, `accounts.actAs` | Los resultados de servidor incluyen distintas combinaciones de sesión/cuenta/bearer. Hay que normalizar únicamente los campos que el contrato de cada respuesta acredita, validar la forma y la vigencia, y no presumir actor cuando falte. |
| `completeOAuthCode`, `OxyContext.commitSession`, consent | La respuesta del exchange tiene cuenta y sesión, pero no contexto de dispositivo. El estado PKCE y las validaciones de consentimiento deben ejecutarse antes del commit; no combinar con device secret, estado de dispositivo o pin. El API directo también planta por defecto. |
| Cold boot y pintura de caché | Un perfil y bearer persistidos pueden pintarse antes de lectura remota, y el modo identidad aplica además un pin local. No se puede convertir ese par guardado en asociación de autoridad solo por tener IDs coincidentes: marcar como desconocido puede bloquear temporalmente operaciones que hoy funcionan offline. Se necesita decisión de producto y prueba de restauración en ambos entornos. |
| `accountDialogController` | Instala un bearer provisional y lo restaura al cancelar/fallar solo si no se sustituyó. El rollback no debe devolver vigencia a un lease previo ni atribuir el contexto provisional a una sesión posterior. |
| `OxyServer` y sesión anónima | El cliente de servidor puede plantar identidad de servicio; el proveedor anónimo no es una sesión de usuario. La nueva asociación no debe extrapolarse a ellos ni alterar esos transportes. |

Cobertura necesaria antes de implementación: cada ruta de escritura y clear, evento reentrante, `strict mode`/montaje, carga fría online y offline, cuenta delegada con dos actores, pin distinto del contexto activo, OAuth aislado y consentimiento, setters públicos, refresh preflight y handler genérico, `linked` con provider que cambia durante un await, resultados atrasados y ABA, preservar señales de cancelación/cache, y paridad web/nativo. Las pruebas actuales reproducen la insuficiencia del contrato y el CAS existente, no son una implementación de este snapshot ni una demostración end-to-end.
