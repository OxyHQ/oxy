> **ARCHIVED — historical, not current.** Last substantive change 2026-07-08 (`1c3b8e41`), archived 2026-08-11.
>
> This document predates the multi-principal device model and describes a
> state of the world that no longer exists. It is kept for provenance.
> For what is actually built, and what is decided but unbuilt, read
> [`docs/auth/index.md`](../../auth/index.md) and the ADRs under
> [`docs/adr/`](../../adr/).

# Oxy Auth Platform — Auditoría Fase 0

> **ARCHIVO HISTÓRICO (snapshot 2026-07-05).** El proyecto auth-platform está **CERRADO** (2026-07-07). Para arquitectura vigente usa [`oxy-auth-platform.md`](./oxy-auth-platform.md), [`SESSION-ARCHITECTURE.md`](../SESSION-ARCHITECTURE.md) y [`AGENTS.md`](../../AGENTS.md). Las tablas §2–§7 abajo describen el punto de partida, no el estado actual.

> **Estado:** COMPLETADA 2026-07-05 · **FASE 7 DONE 2026-07-06** — checklist §11 verificada abajo
> **Ground truth:** `origin/main` @ `99405224` ("feat(sdk)!: re-land unified OxyAccountDialog #554")
> **Plan maestro:** [`oxy-auth-platform.md`](./oxy-auth-platform.md) · **Handoff:** [`oxy-auth-agent-handoff.md`](./archive/oxy-auth-agent-handoff.md)
> Verificable en Fase 7 contra este doc. Metodología: git grep/ls-tree contra `origin/main` + worktree limpio con tests + 7 subagentes de auditoría en paralelo.

---

## 1. HALLAZGO CRÍTICO — el handoff describe un repo que ya no existe

La sección "Estado del repo al generar este handoff" del handoff se escribió desde el worktree `design/cross-domain-session-sync`, cuya base (`d782106c`) está **124 commits por detrás** de `origin/main`. En ese intervalo se mergearon las waves 1+2 de device-first (PRs ~#460–#554). Consecuencias:

| Afirmación del handoff | Realidad en `origin/main` |
|---|---|
| "Rama `impl/session-sync-p1` no existe" | **Existe** localmente (80 commits, tip `304a000f`) — pero está **superseded** (§3) |
| "DeviceSession server-authority no implementado" | **Implementado y mergeado**: model + service + routes + socket + converge |
| "`SessionClient` en core no existe" | **Existe**: `packages/core/src/session/` completo (9 módulos + 14 test suites) |
| "Socket `session_state` / room `device:<deviceId>` no existe" | **Existe**: `broadcastDeviceState` + `deviceRoomFor` + `socketRoomsFor` en `utils/socket.ts` |
| "Legacy en main: oxy_rt cookies, FedCM, SSO, AuthManager, 3 account menus" | FedCM/SSO/AuthManager/crossApex/activeAuthuser/3-menus **ya borrados** de main; quedan residuos (§5) |

**La Fase 1 del plan ya está hecha y mergeada** (con extras). El trabajo restante real es Fases 2b/2c/3/4(resto)/5/6(resto)/7 — y una **decisión de transporte** (§7).

---

## 2. Estado real por fase (contra origin/main)

> ⚠️ **HISTÓRICO (snapshot 2026-07-05).** Esta tabla capturó el estado al arrancar el proyecto. **TODAS las fases 0–7 + 2c están COMPLETADAS, en `main` y en producción** (ver el cierre "🏁 PROYECTO AUTH-PLATFORM CERRADO" al final de este documento). Se conserva solo como registro del punto de partida.

| Fase | Plan | Estado real (al 2026-07-05, ver cierre para el estado final) |
|------|------|-------------|
| 0 audit | este doc | ✅ HECHA |
| 1 DeviceSession server | model/service/routes/socket | ✅ **YA EN MAIN** — spec cumplida y superada: `models/DeviceSession.ts` (= spec + `cookieKeyHash`), `deviceSession.service.ts` (idempotencia, heal, revocación families/device-tokens, `activate:'always'\|'if-empty'`), `routes/sessionDevice.ts` (GET /state, POST /add /switch /signout; deviceId del claim bearer; add deriva del bearer = fix IDOR; respuesta `{data:{state,activeToken}}` = `deviceSessionSyncSchema`), broadcast `session_state` token-free |
| 2 contracts | schemas + publish | ✅ mayormente: `contracts/src/deviceSession.ts` + `deviceBoot.ts` en main; npm publicado (contracts 0.10.0, core 7.1.1, services 17.0.0, auth-sdk 9.0.0 — versiones package.json = npm) |
| 2b console-registry | privacy/terms URLs | ❌ PENDIENTE — `Application` sin `privacyPolicyUrl`/`termsUrl` (§8.1) |
| 2c token mint | deviceSecret workshop | ❌ PENDIENTE — **main usa transporte distinto al plan** (§7) — BLOQUEANTE workshop Nate |
| 3 merge-auth-sdk | eliminar @oxyhq/auth | ❌ PENDIENTE — auth-sdk vivo (42 archivos src); consumidor único real: **console** (12 archivos) |
| 4 unify-ui | Dialog + botón + menú único | 🟡 PARCIAL — hecho en main: `OxyAccountDialog` + `OxySignInButton` en services, `SignInModal`/`AccountMenu`/`ProfileMenu`/`AccountSwitcher`/`crossApex`/`activeAuthuser`/`useWebSSO` **ya borrados**; pendiente: `OxySignInDialog` sobre Bloom `<Dialog placement>` (OxyAccountDialog usa Bloom avatar/button/typography pero hay que verificar contenedor Dialog), bifurcación third_party→OAuth redirect + PKCE helpers en core, rutas auth fuera de `bottomSheetManager` |
| 5 auth-idp-rnweb | IdP monta services | ❌ PENDIENTE — IdP = React DOM propio; FedCM/SSO server routes **ya borradas** del IdP; gaps RN Web en §8.2 |
| 6 migrate-apps | apps sin auth local | 🟡 PARCIAL — bootstrap SSO en `+html.tsx` **ya quitado** (accounts/inbox/commons); accounts FedCM sign-in **ya quitado**; pendiente: console→services (Fase 3), **inbox bearer manual** (6 archivos, viola D4), `test-app-expo` sin clientId |
| 7 clean-cut-docs | grep zero + docs | ❌ PENDIENTE — residuos §5 + docs §9 |

---

## 3. Disposición de ramas (decisión propuesta)

| Rama | Estado | Acción propuesta |
|------|--------|------------------|
| `impl/session-sync-p1` (80 commits, `304a000f`) | **Superseded**: `git cherry` marca 31/80 patch-equivalentes ya en main (todo el set Fase 1 + base SessionClient + token Fase 3); los 49 restantes re-landearon squashed vía PRs o son REJECT puro (p1 aún contiene FedCM/SSO/AuthManager/crossApex que main ya borró). Diff árbol: main ⊇ p1 (solo 6 líneas únicas en áreas KEEP, todas variantes viejas) | **NO cherry-pick. Borrar rama** (con OK de Nate) |
| `fase-a/session-convergence` (`cebb2545`, +1) | Contenido **ya mergeado** en main (diff vacío en sessionDevice/auth/deviceSession.service) | Borrar rama |
| `feat/session-sync-foundation` | 0 commits sobre origin/main | Borrar rama |
| `design/cross-domain-session-sync` (checkout actual) | Base 124 commits stale; contiene UNCOMMITTED: docs canónicos nuevos (platform + handoff + este audit), stubs docs, y trabajo ajeno en `packages/api` (federation/did — otra sesión) | Docs canónicos → commitear en rama nueva desde `origin/main`; no tocar el trabajo api ajeno |

---

## 4. Baselines de tests

**origin/main (worktree limpio, deps `protocol→contracts→core` compiladas antes):**

| Package | Baseline | Nota |
|---------|----------|------|
| contracts | **150 pass** | |
| core | **723 pass** | |
| api | **1358 pass** | |
| services | **165 pass** | requiere `@oxyhq/protocol` + core `dist/` compilados |
| auth (IdP, bun test) | **51 pass / 9 fail / 4 errors** | fallos = leak `mock.module` conocido (CommonsSignIn) + resolución `@oxyhq/core` en worktree; en árbol viejo daba 125/125 — tratar como flaky/env, verificar en rama impl antes de Fase 1+ |

(Los números del handoff — contracts 81, core 623, api 997, services 178, auth 10 — eran de la base stale y quedan obsoletos.)

Rama stale actual (referencia): contracts 107, core 724, api 1311, services 219 pass + 11 fail (7 suites legacy FedCM/SSO, todas DELETE-slated), auth 125 pass.

---

## 5. Grep must-be-zero — contra `origin/main` (packages + docs + examples)

| Patrón | hits/files | Naturaleza | Acción |
|--------|-----------|------------|--------|
| `WebOxyProvider` | 177/44 | auth-sdk vivo + console + docs | Fase 3 |
| `@oxyhq/auth` | 147/64 | ídem + docs | Fase 3 |
| `oxy_device` | 126/42 | **transporte vigente wave 2** (no está en lista must-be-zero; ver §7) | Fase 2c decide |
| `AuthManager` | 19/9 | solo docs + 1 comentario `core/HttpService.ts` | Fase 7 docs |
| `oxy_rt_` | 15/11 | comentarios "legacy removed" + docs + `packages/auth` (IdP fingerprint/types) + openapi.json | Fase 7 |
| `crossDomainAuth` | 14/2 | `examples/web-react-auth.tsx` + `examples/expo-54-universal-auth.tsx` (imports ROTOS hoy) | Fase 7 REWRITE |
| `DeveloperApp` | 11/6 | docs/openapi stale (modelo borrado 2026-06-14) | Fase 7 docs |
| `useWebSSO` | 9/5 | solo docs/READMEs | Fase 7 docs |
| `__oxy/sso-callback` | 9/6 | seeds (`seed-oxy-applications.ts`, `register-commons-clients.ts`) + tests + `core/utils/ssoBounce.ts` | Fase 7 |
| `ssoBounce` | 8/4 | `core/utils/ssoBounce.ts` (código muerto aún exportado en `core/src/index.ts` + `server/index.ts`) + test coldBoot | Fase 7 DELETE |
| `refresh-all` | 7/6 | comentarios "removed" en `deviceAuth.ts`/`refreshToken.service.ts` + `contracts/deviceBoot.ts` + specs viejas + openapi | Fase 7 |
| `fedcm_session` | 6/4 | 3 docs stub-target + 1 comentario auth-sdk | Fases 3/7 |
| `signInWithFedCM` | 4/3 | spec vieja + example + accounts README | Fase 7 |
| `sso/exchange` | 3/2 | spec vieja + openapi.json | Fase 7 |
| `signInWithRedirect` | 2/2 | spec vieja + example | Fase 7 |
| `getSsoCallbackBootstrapScript` | 1/1 | definición muerta en `ssoBounce.ts` | Fase 7 |
| `establishDeviceRefreshSlot`, `ssoReturn` | 1/1 c/u | solo spec vieja `docs/superpowers/specs/2026-07-01-cross-domain-session-sync-design.md` (en main; ya borrada en working tree) | Fase 7 |
| `silentSignInWithFedCM`, `oxy_active_authuser` | **0** | ✅ ya limpio | — |

**Código legacy REAL restante en main (snapshot 2026-07-05 — la mayoría ya eliminado en commits posteriores):** ver grep actual en `main` antes de confiar en esta lista. Residuos que **sí** se limpiaron después: `fedcmToken`, `approvedClientsCache`, `migrate-fedcm-grants`, prefijo `rl:fedcm:service:` → `rl:idp:service:`, namespace hash `fedcm` → `idp` en `deriveServiceDeviceId`, `showSignInModal` → `openAccountDialog`.

**Pendiente verificar en main:** `packages/api/openapi.json` regeneración, ejemplos rotos en `examples/`, seeds con `__oxy/sso-callback` si aún existen.

---

## 6. Consumidores `@oxyhq/auth`

| Consumidor | Realidad |
|------------|----------|
| `packages/console` | **ÚNICO consumidor real**: 12 archivos (`__root.tsx:43` monta `WebOxyProvider` con `VITE_OXY_CLIENT_ID`, hooks use-applications/use-billing/use-models/use-account, layout, playground) |
| `packages/test-app-vite` | **Directorio VACÍO** — puntero de submódulo git huérfano (mode 160000 → `2d042621`, commit accidental `b3b5344d`, sin `.gitmodules`, fuera de workspaces). Nada que migrar; borrar el puntero |
| Root | workspace entry + script `auth:build` |
| `packages/services` PLATFORM_GUIDE/GET_STARTED | solo docs (REWRITE Fase 7) |

---

## 7. DIVERGENCIA ARQUITECTÓNICA PRINCIPAL — transporte de sesión (decisión Nate, Fase 2c)

**main (wave 2, en producción):** cookie first-party `oxy_device` (`Domain=.oxy.so`, secreto opaco; `DeviceSession.cookieKeyHash` = sha256, sparse-unique) + familia rotativa de refresh tokens persistida + fragmento boot `#oxy_boot` (`GET /auth/device/bootstrap` → `POST /auth/device/exchange`, GETDEL origin-bound) + converge cookie↔JWT-claim en `/session/device/{state,add}` + `POST /auth/oauth/token` con atribución device.

**Plan nuevo:** **cero cookies** — `deviceId` en localStorage **por origen** (web) / SecureStore+app-group (native), `deviceSecret` para mint (`POST /session/device/token`), primera visita a origen nuevo = logged-out.

Implicación: adoptar el plan literal = **extirpar de main** `cookieKeyHash`, `readDeviceCookie`/`convergeCallerOntoCookieDevice`/`getStateByCookieKey`, rutas `deviceAuth.ts` (bootstrap/exchange/refresh family), y el cross-subdomain restore que hoy da la cookie. Esto es exactamente el scope del **workshop Fase 2c** (X8: no implementar sin Nate). Hasta el workshop: **no tocar el transporte vigente**.

---

## 8. Gaps por área

### 8.1 Console / Application registry (Fase 2b)

`privacyPolicyUrl`/`termsUrl`: 0 hits en todo el repo. Añadirlos toca **6 sitios coordinados**: `models/Application.ts`, `schemas/application.schemas.ts` (`updateApplicationSchema` es `.strict()` → hoy 400 con claves nuevas), PATCH handler + `serializeApplication` en `routes/applications.ts`, `serializePublicApplication`, `contracts` `publicApplicationSchema`, tipos core (`PublicApplication`, `UpdateApplicationInput`), Console `general-section.tsx`. Además `GET /auth/oauth/consent` devuelve solo `{consentRequired, reason}` sin metadata → la pantalla consent del IdP no puede pintar links legales. Nota: `Application` ya usa `ownerAccountId` (account graph), no `workspaceId` — AGENTS.md stale ahí.

### 8.2 RN Web para auth.oxy.so (Fase 5)

`packages/auth` = Vite 6.3.5 + React 19 + react-router 7 + Hono; **ya tiene** `react-native-web ^0.21.2` + alias `react-native→react-native-web` (para hojas Bloom). **Fatal hoy para montar services:** stubs a módulo vacío de gesture-handler, react-native-svg, safe-area-context, screens, expo-router, expo-modules-core (OxyProvider requiere GestureHandlerRootView + SafeAreaProvider; QR requiere svg; reanimated importado estático). `@oxyhq/services` no tiene splits `*.web.*` (34 guards `Platform.OS==='web'`); Vite consumiría `lib/module` de bob (services build previo obligatorio). Skews: root override pinna `@oxyhq/bloom` 0.20.0 vs `^0.24.1` declarado; `packages/auth/node_modules/react-native-web@0.19.13` anidado shadowea el 0.21.2 raíz. Páginas IdP: authorize/login/signup/recover/social-callback/settings/* (KEEP→reimplementar); sin superficie FedCM/SSO server ya.

### 8.3 Multicuenta (grafo vs DeviceSession)

Grafo completo en main (`account.service.ts`, `/accounts`, `POST /accounts/:id/switch` con `operatedByUserId` persistido en `Session` y re-verificado por `ensureManagedSessionAuthorized`). DeviceSession integrado: switch org minta en el device del operador; add idempotente; heal de cuentas administradas revocadas. Persistencia tras reload hoy = cookie `oxy_device` converge (funciona, pero es el transporte de §7). UI: `OxyAccountDialog` único (services + auth-sdk duplicado hasta Fase 3); queda el chooser propio del IdP (`packages/auth/components/account-chooser.tsx` + `lib/use-device-accounts.ts`) → Fase 5.

### 8.4 Apps oficiales (Fase 6 restante)

| App | Pendiente |
|-----|-----------|
| console | Migrar a `@oxyhq/services` (Fase 3) |
| inbox | **Bearer manual** `oxyServices.httpService.getAccessToken()` + `Authorization:` en 6 archivos (aliaApi/hooks/socket) — viola D4; migrar a `createLinkedClient` |
| accounts/commons | limpio (bootstrap fuera, FedCM fuera) |
| test-app-expo | `OxyProvider` sin `clientId` |
| oxy-main-domain | borrar `web-identity` |
| examples/*.tsx (3) | REWRITE — imports rotos (`createCrossDomainAuth` ya no existe) |

---

## 9. Docs — clasificación (verificada)

- **STUBs correctos (4):** `docs/SESSION-ARCHITECTURE.md`, `docs/AUTHENTICATION.md`, `docs/auth/README.md`, `packages/services/docs/ARCHITECTURE.md` — *en el working tree stale; en main aún son versiones legacy completas* → los stubs deben commitearse con los docs canónicos.
- **Borrados confirmados (working tree):** `docs/CROSS_DOMAIN_AUTH.md`, `docs/superpowers/specs/2026-07-01-cross-domain-session-sync-design.md`, `packages/services/docs/BOTTOM_SHEET_ROUTING.md` — *aún existen en main* → el commit de docs debe incluir las eliminaciones.
- **Sin handoffs raíz** SESSION-SYNC-*/ACCOUNT_SWITCH_* ✅.
- **DELETE Fase 3→7:** `packages/auth-sdk/docs/*` (3), `docs/EXPO_54_GUIDE.md` (FedCM/Popup/cookies entero).
- **REWRITE Fase 7 (~24):** peores: `docs/ARCHITECTURE.md` (33 hits FedCM/SSO), `packages/services/PLATFORM_GUIDE.md` (25), `GET_STARTED.md` (20); + READMEs core/api/auth/services, wiki (salvo 3), `docs/architecture/overview.md` (documenta auth-sdk/SSO como vigentes), README raíz, `docs/README.md`, 3 examples.
- **Links rotos HOY** a `CROSS_DOMAIN_AUTH.md`: `docs/README.md:74`, `docs/ARCHITECTURE.md:684`, `packages/services/README.md:833`, `packages/services/GET_STARTED.md:393`.
- **Stale extra:** `docs/SERVICE_TOKENS.md` + `wiki/Service-Tokens.md` referencian `DeveloperApp`.
- **Specs superpowers:** en main existen phase1/phase2/phase3 (`2026-07-01-session-sync-phase{1,2,3}-*.md`) — las tres YA IMPLEMENTADAS en main; marcar como históricas en Fase 7 (el handoff solo lista la phase1 como vigente).

---

## 10. Preguntas/decisiones para Nate (bloquean Fase 1+)

1. **Base de trabajo:** confirmar rama nueva desde `origin/main` (p.ej. `impl/oxy-auth-platform`) y commitear allí los docs canónicos (platform + handoff + audit + stubs + deletes). El checkout actual es stale y tiene trabajo api ajeno uncommitted.
2. **Fase 1 re-scope:** "implementar DeviceSession" ya no aplica — propongo redefinir Fase 1 como **verificación del Gate sobre main** (tests ≥ baseline §4, sync instantáneo multicuenta, no dos autoridades) + fix del colisionador de nombres DTO (`DeviceSession` interface en `core/models/interfaces.ts:660` vs modelo server; el handoff ya lo pedía).
3. **Ramas p1 / fase-a / foundation:** OK para borrarlas (§3).
4. **Transporte (§7):** ¿workshop 2c decide entre mantener `oxy_device` cookie (vigente, cross-subdomain) vs cero-cookies/deviceSecret del plan? Hasta entonces no toco transporte.
5. **Orden propuesto del trabajo restante:** 2b (privacy/terms, aditivo) → 3 (console→services, borrar auth-sdk) → 4 resto (OxySignInDialog Bloom + OxySignInButton bifurcado + PKCE helpers) → 2c workshop → 5 (IdP RN Web) → 6 resto (inbox linked client, examples) → 7 (clean cut + docs). ¿OK?

---

## 11. Checklist verificación Fase 7 (cerrar contra este doc)

- [ ] Grep §5 = 0 hits en `packages/` + `docs/` (excepto CHANGELOG)
- [ ] `packages/auth-sdk/` eliminado; console en services
- [ ] `ssoBounce.ts` + exports core, `oxy-main-domain/web-identity`, seeds sso-callback, examples rotos, openapi regenerado
- [ ] Docs §9: DELETE hechos, REWRITE hechos, stubs reemplazados
- [ ] AGENTS.md (repo + ~/Oxy + ~/) reescritos device-first sin FedCM
- [ ] `docs/auth/integration-guide.md` + `docs/auth/device-session.md` creados
- [ ] Tests ≥ baselines §4


---

## DONE (2026-07-06) — verificación Fase 7

- [x] Grep §5 = 0 hits en `packages/` + `docs/` + `examples/` + `wiki/` (excl. CHANGELOG, `docs/superpowers/` histórico y los 3 docs canónicos del plan que citan los strings como inventario). 2 supervivientes deliberados: assert negativo `oxy_rt_` en `accountsSwitch.test.ts:275` (guard anti-reintroducción) y `@oxyhq/auth-app` (nombre del paquete IdP).
- [x] `packages/auth-sdk/` eliminado (PR #557); console en services
- [x] `ssoBounce.ts` + exports core eliminados; seeds sin sso-callback; examples reescritos; openapi regenerado (208 paths, 0 restos fedcm/sso); `oxy-main-domain/web-identity` eliminado
- [x] Docs: DELETE (EXPO_54_GUIDE) + 4 stubs reescritos + docs/ARCHITECTURE/README/overview + guías services + READMEs/wiki
- [x] `docs/auth/integration-guide.md` + `docs/auth/device-session.md` creados
- [x] AGENTS.md repo reescrito (secciones auth device-first); `~/AGENTS.md` global alineado; `~/Oxy/AGENTS.md` ya limpio
- [x] Tests ≥ baselines: contracts 150 · core 740 · api 1363 · services 194 · auth IdP 63/0
- [x] **Cierre operativo (2026-07-06):** specs superpowers session-sync phase1-3 BORRADAS (implementadas; citas en los docs canónicos = registro histórico); PR #519 cerrado (superseded); ramas locales+remotas del proyecto purgadas
- [x] **Workshop 2c CELEBRADO (2026-07-06)** — decisiones: deviceId web POR ORIGEN; rotación en uso + grace 60s; refresh family MUERE; migración aditiva con telemetría mint_source, cookie fuera al llegar ≈0; sin cookie-optimización para el IdP
- [x] **2c PR1 (server, aditivo) — MERGEADO + DESPLEGADO (#563, `8042275f`)** — `DeviceSession.secretHash` (sparse-unique) + `prevSecretHash`/`prevSecretExpiresAt` (grace 60s), `issueDeviceSecret` (CAS + retry), `getStateBySecret` (constant-time), `POST /session/device/token` (público, rate limit `rl:session:device-token:` + lockout scope `device-token`), emisión aditiva de `deviceSecret` en login/signup/2FA/verify/QR-claim/token-bundles, telemetría `device.token.mint {mint_source: cookie|secret}`. Verificado live en prod (endpoint responde; ECS rollout COMPLETED)
- [x] **2c PR2 (cliente, aditivo) — MERGEADO (#564, `207f04b3`)** — core `mintFromDeviceSecret` + cold boot v3 con paso `device-secret-mint` PRIMERO (4 outcomes: éxito/invalid_secret→drop+fallback/no_active_session→signed-out conservando secret/transitorio→fallback), `PersistedAuthState.deviceId/deviceSecret`, rotación anti-pérdida (persiste `nextDeviceSecret` antes de usar el token), carry-forward del secret en lanes cookie y refresh; services captura el secret en todas las lanes de sign-in. Publicado: contracts 0.12.0, core 8.1.0, services 18.1.0
- [x] **2c PR3 (cutover cero-cookies + migración IdP) — MERGEADO A MAIN + PUBLICADO + DESPLEGADO (#568, `ccfd1b68`, 2026-07-07)** — borró deviceAuth/oxy_device/cookieKeyHash/converge/refresh family + cold boot v3 final + IdP device-first + securityAlert restaurado + docs 7bis. Nate levantó el gate de telemetría y ordenó cerrar ya. Publicado npm: contracts 0.13.0, core 9.0.0, services 19.0.0 (BREAKING; install externo verificado). Desplegado: oxy-api ECS ✅, auth.oxy.so CF Pages ✅ (fix: el IdP es pure-static post-2c → se quitó el paso "Verify Pages Functions compile" del deploy, commit `486da605`). Bumps externos MAJOR: Mention/Allo/Homiio.

## 🏁 PROYECTO AUTH-PLATFORM CERRADO (2026-07-07)

Fases 0–7 + 2c completas, en main y en producción. Sesión device-first cero-cookie (deviceId+deviceSecret + `POST /session/device/token`) como transporte único; sin cookie `oxy_device`, sin refresh family, sin FedCM/SSO/bootstrap. IdP `auth.oxy.so` device-first como cualquier app (sin excepción de transporte/chooser), sigue siendo shell OAuth/authorize/consent.

**Limpieza auth posterior (2026-07):** eliminados `fedcmToken`, `approvedClientsCache`, script `migrate-fedcm-grants`, API imperativa `showSignInModal` → `openAccountDialog`, prefijo rate-limit `rl:fedcm:service:` → `rl:idp:service:`, namespace hash `fedcm` → `idp` en `deriveServiceDeviceId`, split de `OxyContext` en módulos tipados.

Tests verdes (referencia): contracts 127 · services 192 · auth IdP 63+. Issues aparte (fuera de este cierre): migraciones Alia/TNP.
- [x] **Decisión IdP chooser (2026-07-06, Nate) — IMPLEMENTADA en PR3 #568:** el chooser de cuentas de `auth.oxy.so` (`packages/auth`) usa EXACTAMENTE el mismo mecanismo que `accounts.oxy.so`, `@oxyhq/services` y el resto de apps — SIN excepción cookie/resolve. ELIMINADO: lane `oxy_device` + `POST /auth/device/resolve` + `lib/device-accounts.ts` + `lib/use-device-accounts.ts` + `functions/api/device-accounts.ts` + `lib/types.ts` (`DeviceAccount`) + contrato `deviceResolve*` en `@oxyhq/contracts`. El IdP enumera cuentas por la vía device-first SDK por-origen: `main.tsx` quita `coldBoot={false}` (cold boot normal), el login usa `useOxy().signInWithPassword`/`completeTwoFactorSignIn` (persisten `{deviceId, deviceSecret}` + plantan token), y el chooser (`login-form.tsx` + `authorize.tsx`) usa `useSwitchableAccounts` + `switchToAccount` con el bearer de la cuenta activa (`oxyServices.getAccessToken()`) para `POST /auth/oauth/authorize`. Reconciliación login↔OAuth-authorize LIMPIA (sin rediseño OAuth). Signup + social-callback migrados al mismo funnel (`handleWebSession`); `socialAuth.ts` gana `finalizeDeviceLogin` (paridad deviceSecret). Mecanismo `authuser` eliminado (cuenta activa = objetivo). **El IdP sigue siendo shell OAuth/authorize/consent — NO es RP.** La pantalla "New sign-in detected" (`securityAlert`) se RESTAURÓ extremo a extremo por el contrato device-first (tipo `SecurityAlert` en `LoginSessionResult` → `signInWithPassword`/`completeTwoFactorSignIn` → paso `security-alert`; nota: el endpoint 2FA no corre anomaly-check, igual que main). AGENTS.md del repo reescrito (muere la "IdP exception"); `~/AGENTS.md` global se actualiza al merge.
