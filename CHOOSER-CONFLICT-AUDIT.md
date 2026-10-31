# Chooser: lectura de directorio tras una activación superada

Base investigada: Oxy `origin/main` 29ff6016d. Este árbol contiene solo pruebas
de auditoría; no cambia la lógica de producción ni reintenta activaciones.

Una prueba con `AccountDialogController` y `SessionClient` muestra que un 409
simulado de activación devuelve `failed` y conserva el directorio anterior sin
socket; una llamada explícita a `refresh()` obtiene la revisión ganadora. El
error simulado no prueba por sí solo la forma final del error normalizado por
el servidor y el transporte. La ruta de API que introduce el 409 se desarrolla
por separado.

Las pruebas de `HttpService` real documentan por qué una relectura automática
no debe protegerse solo comparando `getSessionEpoch()` y `getAccessToken()`:

1. Un proveedor externo cambia de A a B sin sincronizar. Las dos lecturas siguen
   viendo A; el siguiente GET sincroniza el proveedor y se envía con B.
2. Una respuesta 401 de ese GET limpia el bearer B, porque para el transporte es
   una petición propia y válida de B. La prueba aísla ese comportamiento; no
   afirma que el chooser actual envíe ese GET automáticamente.
3. Un proveedor que pasa A→B→A sin notificaciones no deja un cambio observable
   en esos snapshots. La igualdad de valores no demuestra continuidad de sesión.
4. Dos JWT con el mismo usuario y sin `sessionId` pueden compartir epoch aunque
   difieran. El epoch no es por sí solo una generación universal de sesión.

## Contrato necesario antes de automatizar

Una opción para investigar es una precondición de propietario opaca entregada
por el transporte y comprobada después de sincronizar el proveedor y antes de
consultar cache/dedupe, ejecutar preflight o enviar la petición. También debe
proteger la cola, la espera de refresh, la gestión de 401, los reintentos de
lectura y la aplicación del resultado. No es una validación de autorización.
Para distinguir A→B→A, un proveedor externo necesitaría una generación
monótona observable; sin ella, la operación debe fallar cerrada. Igualmente se
requiere definir la continuidad cuando los claims no identifican sesión.

La activación debe conservar el resultado `failed` y no reenviarse. Una lectura
rechazada o fallida no debe borrar ni alterar la sesión o la UI de otro dueño.
Estas garantías requieren diseñar y revisar el contrato compartido; no se ha
introducido una nueva API ni una lectura automática en este árbol.

Reproducción:

```sh
cd /home/nate/Oxy/worktrees/chooser-conflict-refresh/packages/core
bun run test --runInBand src/session/__tests__/chooserConflictOwnership.audit.test.ts src/session/__tests__/accountDialogController.test.ts
```

Resultado: 2 suites y 99 pruebas pasan, incluidas las pruebas de los escenarios
anteriores. Son pruebas de comportamiento actual y de límites, no pruebas de un
arreglo que ya esté implementado.
