# PROPUESTA — Autenticación autónoma de una cuenta bot como sí misma

> **Estado: PROPUESTA pendiente de aprobación de Nate.** Nada de este documento
> está implementado ni habilitado. No crea credenciales, no emite tokens a bots
> y no amplía permisos. Issue: [#1520 (I01)](https://github.com/OxyHQ/oxy/issues/1520),
> padre [#1519](https://github.com/OxyHQ/oxy/issues/1519). PR: #1530.

## Requisito (sin rebajar)

Un bot es una cuenta propia controlada por una IA. Tiene las mismas capacidades
disponibles que una cuenta humana bajo las políticas comunes, posee recursos,
roles y plan, y tiene **sus propios fondos**: recibe y paga desde su saldo.
Actúa de forma autónoma **como sí mismo**. La delegación sirve solo para actuar
**por otra cuenta**. No se convierte en una aplicación de confianza ni recibe
privilegios adicionales por ser bot.

## 1. Flujo actual (código en `4b145040a` + #1530)

### Cómo nace un bot y quién lo posee

- `POST /accounts` (`packages/api/src/routes/accounts.ts:487`) crea un hijo de
  cualquier `ChildAccountKind`, `bot` incluido. Lo autoriza el **operador**
  humano con `children:create` sobre el padre (`accounts.ts:527-536`).
- `accountService.createChildAccount` (`services/account.service.ts:428`)
  inserta la fila **sin `publicKey`, sin `email` y sin contraseña**, y una
  membresía `owner` para el creador (`account.service.ts:517`).
- Resultado: el bot existe, tiene propietario y no tiene **ninguna** vía de
  entrada propia. Lo comprueba `services/__tests__/botHasNoWayInOfItsOwn.test.ts`.

### Cómo se autentica hoy una persona

| Vía | Dónde | ¿Sirve para un bot? |
|---|---|---|
| Clave raíz Commons (secp256k1): `POST /auth/challenge` + `POST /auth/verify` | `routes/auth.ts:355,413`; `controllers/session.controller.ts:341-470` | No. Busca `users.publicKey`, y la raíz solo se enlaza a una cuenta `personal` (`services/identityLink.service.ts:83-99`, `IDENTITY_NOT_PERSONAL_ACCOUNT`). |
| Email con código o enlace (ADR 0030) | `services/emailSignIn.service.ts:130` | No. Exige `kind === 'personal'`; probado en `routes/__tests__/signIn.test.ts:169`. |
| Contraseña opcional | `services/password.service.ts`, `routes/signIn.ts` | No. Personal-only; `signIn.test.ts:464`. |
| TOTP | `routes/accountSecurity.ts:94` | No. `accountSecurity.test.ts:316`. |
| AuthSession / QR / bridge (ADR 0028/0029) | `routes/auth.ts:628,1130,1791`; `services/authSession.service.ts` | Solo aprueba quien ya tiene sesión. Ver el hallazgo de abajo. |

### Credenciales que existen y por qué ninguna hace del bot su propio sujeto

| Credencial | Principal que produce | Por qué no sirve |
|---|---|---|
| Service token (`POST /auth/service-token`, `routes/auth.ts:3649`) | una **aplicación** (`appId`, `ownerAccountId`, scopes de app) | Solo apps de confianza o credenciales solo de pagos (`auth.ts:3718-3726`). El sujeto es la app, no el bot. Dárselo al bot es exactamente el privilegio extra que el requisito prohíbe. |
| Workload (`/auth/service-token/workload/*`, ADR 0026) | un workload first-party | Identidad de servicio, no de cuenta. |
| `machine` (`oxy_sk_…`, `middleware/machineCredential.ts`) | una aplicación en el carril de inferencia | Bearer de larga vida sin prueba de posesión, ligado a la app. |
| `confidential` / `public` (OAuth) | un cliente OAuth que actúa **por** un usuario | Es delegación: requiere un humano que consienta. `client_credentials` no está soportado (`auth.ts:2924`). |
| Pagos (`payments:*` en credencial `service`) | una app comerciante | Mismo problema que el service token. |

### `actAs` y el switch, hoy

- `POST /accounts/:id/switch` (`accounts.ts:363`): una persona **ocupa** una
  cuenta gestionada. Rechaza `bot` y `channel` (`isOperatorSwitchTargetKind`).
  Graba `operatedByUserId`.
- `POST /internal/accounts/:id/service-switch` (`routes/internal.ts:490`): una
  app de confianza actúa **como** una cuenta (bot incluido,
  `isDelegatedActAsEligibleKind`) por autoridad de una persona; graba
  `operatedByUserId` = esa persona.
- Una sesión operada se recomprueba cada `MANAGED_SESSION_RECHECK_MS` = 60 s
  (`session.service.ts:90`), y al instante en lecturas de decisión
  (`useCache: false`).
- #1530 añade la cadena de actor leída de la fila de sesión (`AccountActorChain`):
  bot sin operador → actor = bot; con operador → actor = la persona.

### Hallazgo corregido en #1530 (commit `0b7f33696`)

`POST /auth/session/authorize/:sessionToken` y
`POST /auth/session/authorize-code/:authorizeCode` creaban la sesión del sujeto
que aprobaba **sin** `operatedByUserId`. Desde una sesión operada eso
**blanqueaba el asiento**:

- **Organización:** la persona obtenía una sesión de la org sin operador. Al
  quitarla de la org, esa sesión **seguía viva**, porque la recomprobación solo
  corre en sesiones operadas.
- **Bot:** la persona obtenía el asiento del bot, que el switch le prohíbe, y
  sus acciones quedaban auditadas como el bot actuando solo.

Reproducido con un test que fallaba (6/6 en rojo) contra Postgres real y el
`authMiddleware` real. Ahora la sesión creada hereda el operador; el asiento de
un bot o canal se rechaza antes de escribir nada. Test:
`routes/__tests__/operatedApprovalKeepsOperator.test.ts` (8/8). Solo restringe.

## 2. Diseño propuesto: clave de agente

### Idea

El bot tiene **su propio par de claves**, generado y custodiado por el runtime
de la IA. Oxy registra solo la clave pública como **método de autenticación de
la cuenta bot**. El bot firma un challenge y obtiene una **sesión normal de su
propia cuenta**: sin operador, con los mismos scopes, límites y RBAC que la
sesión de una persona, y **sin** scopes de app ni carril de servicio.

Es el mismo modelo que Commons para una persona: prueba de posesión de una clave
privada que nunca sale de su dueño. Sin passkeys, sin cookies, sin contraseñas.

### Algoritmo

**secp256k1**, el mismo que la raíz Commons. Así se reutilizan
`SignatureService` (`verifySignature`, `canonicalizePublicKey`,
`isTimestampFresh`) y su tooling, y hay un solo camino de verificación que
auditar. Ed25519 también serviría, pero añade un segundo verificador sin
ventaja de seguridad relevante aquí (decisión D6).

### Dónde vive la clave pública en Oxy

**No** en `users.publicKey`. Ese campo es la raíz de identidad personal
(ADR 0024), con DID, recuperación por Commons y efectos laterales: borra el
email, la contraseña y el TOTP al enlazarse (`identityLink.service.ts:117-126`).
Mezclar las dos cosas convertiría al bot en una "persona" a medias.

Propuesta: `user_auth_methods` con un tipo nuevo `agent_key`
(`AUTH_METHOD_TYPES` hoy es solo `['identity']`, `db/schema/userAuthMethods.ts:21`).
Cada fila lleva:

- `methodPublicKey` canónica (única globalmente);
- `label` (p. ej. "worker eu-1");
- `enrolledByUserId` (quién la dio de alta) y `enrolledVia` (`owner_reauth` | `key_rotation`);
- `createdAt`, `lastUsedAt`, `revokedAt`, `revokedReason`.

Varias claves activas por bot (una por runtime o réplica, más el solape de la
rotación), con un tope pequeño (p. ej. 5). Solo se admiten en cuentas `kind = 'bot'`.

### Alta: la primera clave

1. El runtime genera el par y conserva la privada.
2. Una persona con autoridad sobre el bot la registra:
   `POST /accounts/:botId/agent-keys` con `{ publicKey, label, proof }`.
   - `proof` = firma de la **clave nueva** sobre
     `{action:'agent_key_enroll', botId, publicKey, challenge, timestamp}`.
     Es la prueba de posesión, igual que el paso 4 de `rotate_key`
     (`routes/authLinking.ts:343-353`). Impide registrar la clave pública de otro.
   - Autoridad: el **operador** humano con un permiso nuevo
     `credentials:manage` sobre el bot (por defecto `owner` y `admin`; no
     `editor`). Si el bot cuelga de una org, vale la membresía heredada.
   - **Reauth fresco** de esa persona (ADR 0030: contraseña o código por email,
     más TOTP si lo tiene). Sin reauth, 401.
3. Auditoría del **alta**: actor = la persona, efectiva = el bot, acción
   `agent_key.enrolled`. Es un acto de gobierno sobre el bot, no una acción
   del bot. A partir de ahí la persona **no** aparece como actor de nada de lo
   que el bot haga.

La persona solo aporta la prueba inicial. No obtiene ninguna sesión del bot ni
puede firmar por él: no tiene la clave privada.

### Inicio de sesión del bot

```text
POST /auth/agent/challenge   { publicKey }
  → { challenge, expiresAt }                       (TTL 60 s, un solo uso)
POST /auth/agent/verify      { publicKey, challenge, signature, timestamp }
  → AuthSuccess de la cuenta bot                   (misma forma que /auth/verify)
```

- El mensaje firmado está ligado a la acción y la audiencia:
  `{action:'agent_signin', aud:'oxy-api', botId, publicKey, challenge, timestamp}`.
  Así una firma de alta o de rotación no sirve para entrar, ni al revés.
- `auth_challenges` gana `purpose = 'agent_signin'`. La quema atómica es la
  misma que en `verifyChallenge` (`session.controller.ts:447-455`), y
  `expires_at > now()` se filtra en la consulta.
- La sesión creada:
  - `userId = botId`, `operatedByUserId = null`;
  - **nueva columna** `sessions.auth_method_id` = la fila `agent_key`, para
    revocar por clave;
  - mismo TTL y refresco que una sesión personal; el refresco comprueba que la
    clave sigue activa.
- `/auth/challenge` y `/auth/verify` **no** cambian: siguen siendo solo para la
  raíz personal.
- Rate limit igual que el login personal, por clave (`publicKey`) y por IP con
  `hashedIpKey`. No se persiste ninguna IP.

### Custodia

- La clave privada vive **solo** en el runtime de la IA. Oxy nunca la recibe, ni
  siquiera cifrada.
- Recomendado: no exportable, en un KMS o HSM del runtime (p. ej. AWS KMS
  `ECC_SECG_P256K1` con `Sign`) o en un enclave. Lo mínimo es un secreto del
  runtime fuera del repositorio y de los logs.
- Una clave por runtime. Al perder un runtime se revoca su clave sin tocar las demás.

### Rotación y recuperación

- **Rotación por el propio bot.** Una sesión del bot autenticada con la clave A
  añade la clave B con la firma de A **y** la prueba de posesión de B. Es el
  esquema de `rotate_key` (`authLinking.ts:276-447`), sin persona en medio.
  Luego puede revocar A.
- **Recuperación** cuando el bot pierde todas sus claves:
  - una persona con `credentials:manage` y **reauth fresco** revoca todas las
    claves del bot y da de alta una nueva (el alta de arriba);
  - se revocan en la misma transacción todas las sesiones autenticadas con las
    claves revocadas;
  - sin reauth → 401; sin `credentials:manage` → 403.
- La recuperación no da a la persona acceso a los fondos ni a los recursos del
  bot. Solo restablece una vía de entrada que sigue estando en manos del runtime.

### Revocación

| Qué se revoca | Efecto | Plazo objetivo |
|---|---|---|
| Una clave | Se desactivan sus sesiones (`auth_method_id`) en la misma transacción, se invalida `sessionCache`/`userCache` y se emite `session_update` | Inmediato en lecturas de decisión; ≤ 60 s en la ruta normal |
| Todas las sesiones del bot | `deactivateAllSessions(botId)` | Igual |
| El bot entero (archivo o suspensión) | Todas las claves y sesiones; challenges pendientes inválidos | Igual |

La sesión de un bot no está operada, así que hoy no pasaría por
`ensureManagedSessionAuthorized`. La propuesta añade una recomprobación
equivalente para las sesiones con `auth_method_id`: la clave sigue activa y el
bot no está archivado. Usa la misma cadencia de 60 s
(`MANAGED_SESSION_RECHECK_MS`) y `useCache:false` en las decisiones de
autoridad. El plazo final lo fija I03 (#1522); esta propuesta solo se alinea
con él.

### Límites

Los mismos que para una persona: rate limits por cuenta, cuotas por plan,
límites de capacidad y de gasto. **No hay ningún límite extra por ser bot ni
ninguna aprobación del propietario por ser bot.** Si una política común exige
algo, lo exige igual a los dos.

### Auditoría

La cadena de actor de #1530 ya responde lo correcto con una sesión sin operador:

```json
{ "schemaVersion": 1, "effectiveAccountId": "<bot>", "actorAccountId": "<bot>", "delegated": false }
```

Además, `securityActivity` registra `agent_signin` con `authMethod: 'agent_key'`
y el id de la clave (no la clave). El propietario humano no aparece como actor de
ninguna acción hecha con la sesión del bot.

### Fondos propios

#1530 ya fija que el efecto financiero se atribuye a la cuenta efectiva
(`attributeFinancialEffect`) y prueba que el saldo y los recibos del bot no tocan
los del propietario. Con su propia sesión, el bot:

- recibe fondos en su saldo con las mismas reglas que una persona;
- paga desde su saldo con las mismas reglas, sin aprobación del propietario.

Cuando una acción sensible exige a una persona un **reauth fresco** (borrado,
cambio de método de entrada, pagos por encima de un umbral si la política
común lo pide), el equivalente del bot es una **firma fresca de su clave ligada
a esa acción** (`{action, payloadDigest, challenge}`). Es la misma regla con el
factor que tiene un bot, no una regla distinta.

Pagos reales a terceros por Peable (I08) y cumplimiento normativo (KYC) de un
receptor no humano son una cuestión aparte (decisión D5).

### Capacidades sobre su propia cuenta

Hoy `capabilityAuthority.service.ts:245-252` exige un `DelegationGrant` a
cualquier actor `agent`, **también cuando la cuenta efectiva es el propio bot**.
Con sesión propia, la cuenta efectiva igual al actor no es una delegación. Basta
con la autoridad de la cuenta sobre sí misma, igual que una persona en su cuenta
personal. El grant sigue siendo obligatorio para actuar sobre **otra** cuenta
(ADR 0018). Toca a I03/I04 (decisión D4).

### Propiedad de sí mismo

`resolveEffectiveAccess(bot, bot)` hoy es `null`
(`botHasNoWayInOfItsOwn.test.ts`; #1530 lo dejó así a propósito).

Propuesta: una sesión del bot **autenticada con su clave** es `owner` de su
propia cuenta en recursos, contenido, hijos, saldo y pagos. La **gobernanza** de
la cuenta bot sigue en manos de quien la creó: quién puede recuperarla,
suspenderla o archivarla, y la membresía `owner` humana. El bot no puede
quitarse a su propietario ni transferir su propiedad (decisión D3).

Sin una vía de entrada propia, esto **no** debe activarse. Una sesión delegada
cuya lectura de operador falle pasaría a tener permisos de propietario. Por eso
se ata a `auth_method_id`, no a "sesión sin operador".

## 3. Alternativas descartadas

1. **Credencial de app de confianza o service token para el bot. Descartada
   explícitamente.**
   - El principal sería una aplicación con scopes de app y acceso al carril
     `/internal`, no la cuenta bot.
   - Se salta el RBAC por cuenta y daría al bot exactamente el privilegio extra
     que el requisito prohíbe.
   - Además, mezcla el gobierno de apps (Console) con el de cuentas.
2. **Raíz Commons (`users.publicKey`) en el bot.**
   - La raíz es identidad personal con DID y recuperación de Commons.
   - Al enlazarla se borran el email, la contraseña y el TOTP.
   - Es una sola clave, sin multi-runtime, y rompe la regla de que la raíz es
     solo personal (`IDENTITY_NOT_PERSONAL_ACCOUNT`).
3. **Contraseña, código por email o TOTP para el bot.**
   - Son secretos compartidos y repetibles; el email exige un buzón que la IA
     controle.
   - Por diseño son personales (ADR 0030) y sus tests lo fijan.
4. **Credencial `machine` (`oxy_sk_…`).** Es un bearer de larga vida sin prueba
   de posesión, propiedad de una app y limitado al carril de inferencia.
5. **Dejarlo como está (sesión delegada operada por el propietario).** Graba a la
   persona como actor, que es justo lo que el requisito no quiere para la acción
   autónoma del bot.
6. **OAuth `client_credentials`.** No está soportado, y su principal es el cliente.
7. **JWT autofirmado por el bot en cada petición, sin sesión.** Cada servicio
   tendría que verificarlo, sin revocación central ni cadena de actor. Sería un
   segundo sistema de sesiones.

## 4. Pruebas contra suplantación y escalada

Las marcadas **hoy** existen y pasan en #1530 sin habilitar nada. El resto son
pruebas de aceptación de la implementación propuesta.

| # | Caso | Resultado esperado | Estado |
|---|---|---|---|
| T1 | Un bot creado por la vía real no tiene clave, email ni contraseña | Ninguna vía humana lo resuelve | **hoy** `botHasNoWayInOfItsOwn` |
| T2 | Enlazar la raíz Commons a un bot | 403 `IDENTITY_NOT_PERSONAL_ACCOUNT`, `publicKey` sigue `null` | **hoy** `botHasNoWayInOfItsOwn` |
| T3 | Email, contraseña o TOTP en un bot | Rechazado | **hoy** `signIn.test.ts:169,464`, `accountSecurity.test.ts:316` |
| T4 | El bearer de sesión de un bot presentado como service token | `verifyServiceToken` no lo acepta | **hoy** `botHasNoWayInOfItsOwn` |
| T5 | Cabeceras `x-oxy-user-id`/`actor-id`/`operator-id` falsificadas | El actor no cambia | **hoy** `botAccountParity` |
| T6 | Una persona que opera un bot aprueba un inicio de sesión | 403; ninguna sesión sin operador para el bot | **hoy** `operatedApprovalKeepsOperator` |
| T7 | Una persona que opera una org aprueba un inicio de sesión, y luego la quitan de la org | La sesión creada lleva su operador y muere | **hoy** `operatedApprovalKeepsOperator` |
| T8 | El bot actúa como su propietario o como otro bot | Denegado (`verifyActingAs` → `null`) | **hoy** `botHasNoWayInOfItsOwn` |
| T9 | Un bot de la org A intenta actuar en la org B | Denegado | **hoy** `botHasNoWayInOfItsOwn` |
| T10 | Un bot crea otro bot | El hijo no hereda autoridad sobre la org ni sobre su creador; un `editor` no tiene `children:create` | **hoy** `botHasNoWayInOfItsOwn` |
| T11 | Un bot sin operador no es propietario de sí mismo | `resolveEffectiveAccess(bot, bot)` → `null` | **hoy** (cambia con D3) |
| P1 | Sesión con clave de agente | Actor = bot, `delegated:false`; el propietario no aparece | propuesta |
| P2 | Sesión con clave de agente contra `/internal/*` o como service token | 401/403; sin scopes de app | propuesta |
| P3 | Replay del challenge `agent_signin` | La segunda vez 401 (quema atómica); dos `verify` concurrentes → una sola sesión | propuesta |
| P4 | Firma de `agent_key_enroll` o `rotate` usada como `agent_signin` | 401 (acción y audiencia en el mensaje) | propuesta |
| P5 | Clave revocada | Challenge y verify → 401; sus sesiones mueren al instante en decisión y en ≤ 60 s en la ruta normal; el refresco → 401 | propuesta |
| P6 | Alta de una clave pública ajena, sin prueba de posesión | 400 | propuesta |
| P7 | Alta o recuperación sin reauth fresco, o sin `credentials:manage` | 401 / 403 | propuesta |
| P8 | Alta de `agent_key` en una cuenta que no es bot | 403 | propuesta |
| P9 | El bot, con su sesión, intenta quitar a su propietario, transferir la propiedad o desarchivarse | 403 (gobierno ≠ capacidad, D3) | propuesta |
| P10 | El bot rota su clave sin persona | Correcto con firma de la vieja + prueba de la nueva; sin la vieja → 400 | propuesta |
| P11 | Recibe fondos y paga con su sesión | Saldo y recibo del bot; el saldo del propietario no se mueve; sin aprobación del propietario | propuesta (simulado) |
| P12 | Misma acción con mismo rol y plan, persona vs bot con clave | Mismo resultado y mismo tratamiento comercial | propuesta |
| P13 | Bot archivado | Challenge → 404; sesiones muertas | propuesta |
| P14 | La clave pública de un bot ya registrada en otro bot | 409 (única global) | propuesta |

## 5. Lo que le falta a #1530 para cumplir #1520

Casilla a casilla de la ficha:

| Casilla | Estado en #1530 | Falta |
|---|---|---|
| Contrato y compatibilidad revisados | Hecho: `accountSubject.ts`, cadena de actor, sujeto financiero, matriz de consumidores | Añadir al contrato `AccountAuthMethod = 'identity' \| 'agent_key'` y el método en la cadena de actor cuando se apruebe |
| Implementación verificada dentro del alcance | **Parcial.** Bot como actor propio en el contrato y la auditoría, actor leído de la fila, blanqueo de operador corregido | La **vía de entrada propia** (este documento), propietario de sí mismo (D3), capacidades sobre su cuenta sin grant (D4), recomprobación por clave |
| Paridad e aislamiento verificados con evidencia | Roles, aislamiento, delegación revocada, fondos simulados y T1–T11 | P1–P14 con una sesión real del bot, no solo con sesiones creadas en el test |
| Hija y padre actualizadas | — | Lo hace el coordinador |

Cambios que implicaría la propuesta:

- **Contratos (`@oxy.so/contracts`):** esquemas `agentKey*` (alta, lista,
  revocación, challenge y verify), `AccountAuthMethod`, el permiso
  `credentials:manage` en el catálogo de permisos de cuenta, y versión
  `ACCOUNT_SUBJECT_CONTRACT_VERSION` 2 si cambia la cadena de actor.
- **Migración** (`packages/api/drizzle`, el siguiente índice libre; 0131 está en
  disputa entre #1529 y #1531):
  - `user_auth_methods.type` admite `agent_key`, más las columnas `label`,
    `enrolled_by_user_id`, `enrolled_via`, `last_used_at`, `revoked_at` y
    `revoked_reason`;
  - un CHECK de que `agent_key` solo existe en un `kind = 'bot'` (vía trigger o
    validación en servicio);
  - `auth_challenges.purpose` admite `agent_signin`, `agent_key_enroll` y `agent_key_rotate`;
  - `sessions.auth_method_id` (FK nullable, `on delete set null` + desactivación en servicio).
- **API:**
  - rutas `POST /auth/agent/challenge` y `POST /auth/agent/verify`, y
    `GET|POST|DELETE /accounts/:botId/agent-keys`;
  - rotación propia del bot;
  - recomprobación por clave en `session.service`;
  - `resolveEffectiveAccess` del bot con clave (D3) y `capabilityAuthority` sin
    grant cuando la cuenta efectiva es el actor (D4);
  - `securityActivity`.
- **SDK:** un cliente de agente solo para servidor (p. ej. en
  `@oxy.so/core/server`) que firme el challenge con un firmante inyectado
  (KMS/HSM), nunca la clave en claro. **Nada** en `@oxy.so/services` ni en el
  navegador.
- **Docs:** ADR nuevo, «La cuenta bot entra como sí misma con su clave de
  agente», que enmiende ADR 0018 y ADR 0024 y cambie `principals-and-account-contexts.md`.

Impacto en otras hijas:

- **I03 (#1522):** fija el plazo de revocación que aquí se toma como ≤ 60 s y la
  invalidación por clave. También la regla de D4 de que, cuando la cuenta
  efectiva es el propio actor, no hace falta grant.
- **I04 (#1523):** el principal MCP de una sesión de bot. Interno, verificado por
  Oxy y con actor `agent`, no un OAuth externo. Las herramientas sobre la propia
  cuenta del bot no exigen ticket de delegación.
- **I07 (#1525):** el bot como beneficiario y pagador de su plan. Los derechos se
  resuelven por sujeto, sin mirar el `kind`; el contrato de #1530 ya lo declara.
- **I08 (Peable#87):** el bot como receptor y pagador real; atribución de saldo
  y recibo; KYC de un receptor no humano (D5).

## 6. Decisiones para Nate

| # | Decisión | Recomendación | Consecuencias |
|---|---|---|---|
| D1 | Aprobar la **clave de agente** como la vía de entrada propia del bot: un par de claves registrado como método de autenticación, que entra con challenge y firma y obtiene una sesión normal sin operador | **Sí.** | Cumple el requisito sin privilegio extra. Exige migración, rutas nuevas y un ADR. Sin esto, I01 sigue bloqueada |
| D2 | Quién da de alta y recupera las claves | **El operador con `credentials:manage`** sobre el bot (`owner` o `admin`, heredado de la org si cuelga de ella), siempre con reauth fresco | Una org gobierna sus bots sin depender de una sola persona. Un `editor` no puede tomar el control de un bot. Hace falta añadir el permiso al catálogo |
| D3 | El bot con sesión de clave es **propietario de sí mismo** en recursos y fondos. La **gobernanza** (recuperar, suspender, archivar, membresía `owner` humana) sigue en su creador | **Sí, separando capacidad de gobernanza.** | El bot actúa en lo suyo sin pedir permiso. Hay alguien que puede pararlo o recuperarlo y el bot no puede deshacerse de esa persona. Alternativa: soberanía total, en la que el bot puede quitarse al propietario; se pierde la recuperación y la responsabilidad legal queda sin dueño |
| D4 | Las capacidades sobre su **propia** cuenta no exigen `DelegationGrant` | **Sí.** El grant solo hace falta para actuar sobre otra cuenta (ADR 0018) | Quita una restricción por ser bot que hoy existe (`capabilityAuthority.service.ts:245-252`). Lo implementa I03/I04 |
| D5 | Fondos reales que salen de la plataforma (pagos a terceros, retiradas) para un receptor no humano: a quién se aplica el KYC | **Saldo interno con las mismas reglas que una persona.** Para retirar a un banco o a un tercero externo, el KYC es el de la persona u organización legal responsable del bot | Cumple con «sus propios fondos» dentro de Oxy y Peable sin inventar una identidad legal para la IA. Las retiradas externas pasan por una verificación que el bot no puede hacer solo. Afecta a I08 |
| D6 | El algoritmo de la clave | **secp256k1**, como Commons | Un único verificador (`SignatureService`). AWS KMS lo soporta (`ECC_SECG_P256K1`). Ed25519 sería un segundo camino sin ganancia |
| D7 | El plazo de revocación de una clave o un bot | **Inmediato en decisiones de autoridad; ≤ 60 s en la ruta normal** | Mismo contrato que las sesiones operadas. I03 puede endurecerlo para todos |

## 7. Lo que este documento NO hace

- No implementa ni habilita ninguna ruta, credencial, método de entrada ni permiso.
- No crea ninguna clave, sesión ni membresía en ningún entorno.
- No cambia las reglas financieras. Solo usa el sujeto financiero de #1530.
