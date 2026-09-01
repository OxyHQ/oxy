> **ARCHIVED — historical, not current.** Last substantive change 2026-07-07 (`ccfd1b68`), archived 2026-08-11.
>
> This document predates the multi-principal device model and describes a
> state of the world that no longer exists. It is kept for provenance.
> For what is actually built, and what is decided but unbuilt, read
> [`docs/auth/index.md`](../../auth/index.md) and the ADRs under
> [`docs/adr/`](../../adr/).

# Fase 2c — Transporte cero-cookies

> **Estado:** IMPLEMENTADO (ver § "Estado: implementado" al final). El workshop cerró §4 con las recomendaciones del §2 (deviceSecret rotante-en-uso, la familia refresh MUERE, grace 60s multi-pestaña).
> **Transporte vigente:** `deviceId` + `deviceSecret` en storage first-party; mint server-side vía `POST /session/device/token`. Cero cookies, cero familia refresh, cero bootstrap `#oxy_boot`. Ver [SESSION-ARCHITECTURE](../SESSION-ARCHITECTURE.md).

---

## 1. Qué resuelve 2c y qué se sacrifica

| | Hoy (oxy_device + refresh family) | Objetivo (deviceSecret) |
|--|--|--|
| Restore en `*.oxy.so` | Automático cross-subdominio (cookie Domain) | Automático **por origen** (localStorage) — cada subdominio hace su primer sign-in |
| Restore cross-apex (mention.earth…) | Bootstrap hop `#oxy_boot` (nav top-level) | Igual que hoy la primera vez; después localStorage propio |
| Dependencia de cookies | Sí (1 cookie de dispositivo; no de sesión) | **Cero** |
| Superficie CSRF | Cookie ambient → converge endpoints necesitan same-site guard | Ninguna (nada ambient; todo bearer/body) |
| Robo por XSS | Refresh family en storage + cookie httpOnly? (`oxy_device` no lleva sesión; el refresh persiste en storage) | `deviceSecret` en storage — mismo perfil de riesgo que el refresh actual |
| Sync multi-app mismo dispositivo | deviceId compartido vía cookie → mismo doc DeviceSession | deviceId **por origen** → docs DeviceSession distintos por origen, salvo QR/hand-off que los una |

**La decisión de fondo del workshop:** ¿aceptamos perder el deviceId compartido implícito entre subdominios `*.oxy.so` (lo que hoy da el chooser instantáneo en auth.oxy.so y el converge) a cambio de eliminar la última cookie? Alternativas en §4.

## 2. Diseño propuesto (mínimo viable)

### Modelo
- `DeviceSession.secretHash` (sha256 del `deviceSecret`, sparse-unique) — sustituye `cookieKeyHash`.
- `deviceSecret`: 256-bit random, generado por el SERVIDOR en el primer sign-in del origen; viaja UNA vez en la respuesta de login/exchange; el cliente lo persiste (web: localStorage `oxy_device_secret`; native: SecureStore/app-group).

### Endpoint nuevo
`POST /session/device/token` `{ deviceId, deviceSecret }` (sin bearer):
1. Busca DeviceSession por `deviceId`; `verifySecret(sha256(deviceSecret), secretHash)` (constante).
2. Cuenta activa → valida `Session` viva (`ensureManagedSessionAuthorized` si operada) → emite **access token corto** (mismo TTL que hoy) para la cuenta activa. NO emite refresh.
3. Rate limit `rl:session:device-token:` + lockout por deviceId tras N fallos.

### Rotación / revocación
- **Rotación en uso** (recomendada): cada mint devuelve `nextDeviceSecret`; el anterior queda válido en gracia corta (60s) para carreras multi-pestaña (mismo patrón single-use-with-grace de la refresh family actual). Robo → el ladrón y el dueño divergen al primer mint del otro → detección (secret inválido) → señal de revocación + re-auth.
- **Revocación**: sign-out all del device borra `secretHash`; remota vía accounts.oxy.so → sessions (ya lista devices).
- **Step-up**: sin cambios — firma Commons (challenge) para Verify, como define el plan.

### Cold boot resultante (3 pasos, sin red extra)
`deviceId+deviceSecret en storage` → `POST /session/device/token` → autenticado | logged-out. Muere: `deviceAuth.ts` completo (bootstrap/exchange/fragment), `cookieKeyHash`, converge cookie↔claim, refresh family persistida (el access corto + mint bajo demanda la reemplaza — **decisión §4.3**).

### Offline nativo
Igual que hoy: access cacheado en keychain + React Query persist + cola de mutaciones; mint al reconectar. `deviceSecret` nunca sale del SecureStore.

## 3. Plan de migración (sin big-bang)

1. **Aditivo**: modelo+endpoint+SDK detrás de capability (server emite `deviceSecret` en login siempre; clientes nuevos lo usan si lo tienen). Cookie sigue viva.
2. **Cutover de clientes**: publicar SDK que prefiere deviceSecret y solo cae a bootstrap si no lo tiene (primer arranque migra: bootstrap una vez → recibe secret → cookie ya no se usa en ese origen).
3. **Borrado**: cuando telemetría muestre mints por cookie ≈ 0 → eliminar deviceAuth/cookieKeyHash/Set-Cookie + clean cut docs (mini-fase 7bis). Sin migración de datos: los docs DeviceSession viejos siguen; `secretHash` se puebla en el siguiente sign-in/mint.

## 4. Decisiones abiertas para el workshop

1. **Ámbito del deviceId web**: (A) por origen puro (plan literal; pierde chooser instantáneo en auth.oxy.so hasta primer sign-in ahí) · (B) por origen + hand-off explícito al IdP vía el flujo OAuth/QR existente (sin cookie, un paso de usuario) · (C) conservar `oxy_device` SOLO como optimización del IdP (contradice "cero cookies" — descartada salvo veto).
2. **Rotación**: rotante-en-uso (§2, recomendada) vs estática+TTL largo (más simple, peor ante robo).
3. **¿Muere la refresh family?**: sí (deviceSecret la subsume; menos estado) vs no (secret solo bootstrap, refresh sigue para mint). Recomendación: **sí** — un solo mecanismo.
4. **Grace multi-pestaña**: 60s single-use-grace vs BroadcastChannel lock (web). Recomendación: grace (ya probado en la familia actual).
5. **Telemetría de cutover**: contador `mint_source: cookie|secret` en deviceAuth para decidir el borrado.

## 5. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| XSS roba deviceSecret (web) | Mismo perfil que el refresh persistido actual; rotación-en-uso detecta divergencia; CSP de apps; scope del secret = mint de access corto solamente |
| Primer origen nuevo = logged-out | Aceptado por el plan (documentado); QR/hand-off cubre UX |
| Carrera multi-pestaña en rotación | Grace 60s + retry idempotente |
| Migración a medias (clientes viejos) | Fase aditiva + telemetría; cookie no se toca hasta ≈0 |

---

## Estado: implementado

El transporte cero-cookies se ejecutó en **tres PRs** (aditivo → aditivo → cutover), para migrar sin big-bang:

| PR | Qué | Estado |
|----|-----|--------|
| **PR1 — server mint (#563)** | Modelo `DeviceSession.secretHash` + `POST /session/device/token` + `issueDeviceSecret`/`getStateBySecret` + telemetría `device.token.mint { mint_source: 'cookie' \| 'secret' }`. El servidor emite `deviceSecret` en TODO login/claim (aditivo); la cookie/refresh siguen vivas. | Mergeado + publicado (contracts 0.12.0 / core 8.1.0 / services 18.1.0). |
| **PR2 — client mint + cold boot v3 (#564)** | Cliente prefiere el `deviceSecret` (`mintFromDeviceSecret`, paso `device-secret-mint` primero en el cold boot); cae a las lanes cookie/refresh sólo si no tiene secret. Primer arranque de un cliente nuevo migra: recibe el secret en el login y ya no usa la cookie en ese origen. | Mergeado + publicado. |
| **PR3 — cutover cero-cookies (este PR)** | BORRADO de las lanes legacy: `deviceAuth.ts` entero (bootstrap/exchange/web-session/`#oxy_boot`/native device-token), la cookie `oxy_device` (`cookieKeyHash`, `deviceCookie` utils, converge cookie↔claim), la familia refresh (`refreshToken.service`, `/auth/refresh-token`, `/auth/logout`), y el lane de atribución `deviceToken` (huérfano tras borrar el mint). Cold boot v3 final = `device-secret-mint` + `shared-key-signin`. Sockets sólo-bearer. | contracts 0.13.0 / core 9.0.0 (BREAKING) / services 19.0.0 (BREAKING). |

**Criterio de merge del cutover (PR3):** el PR3 queda en DRAFT gateado por telemetría. Merge cuando los mints por cookie caigan a ≈0 sostenido durante **48–72h** en producción. Query CloudWatch Insights (log group `/oxy/ecs`):

```
filter @message like /device.token.mint/
| stats count() by mint_source
```

Cuando `mint_source = cookie` sea ≈0 (todos los clientes migrados al `secret`), mergear el cutover. Tras el merge no queda ningún `mint_source: cookie` (esa lane se borra); la telemetría restante es sólo `mint_source: secret`.

**Decisiones §4 resueltas en el workshop:** (1) ámbito deviceId web = **A, por origen** (se acepta perder el chooser instantáneo cross-subdominio; sin cookie compartida); (2) rotación = **rotante-en-uso** con grace 60s; (3) la familia refresh **MUERE** (un solo mecanismo); (4) grace 60s multi-pestaña (no BroadcastChannel lock); (5) la telemetría `mint_source` fue el gate del borrado.

*Preparado 2026-07-06; ejecutado 2026-07-06 (PRs #563, #564, PR3).*
