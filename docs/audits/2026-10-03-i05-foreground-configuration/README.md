CAS administrativo I05: fuente `68ba56deef769a9df9b96fb7f3ea290b5bea743d`; ejecución live pendiente.

El helper crea sólo el registrador canónico machine-only y amplía Mention con `capability-tickets:issue` / `agency:coordinate`; sólo el workload de backend recibe el scope de tickets. No crea grants humanos/offline ni vincula el rol compartido. La app máquina conserva owner, credencial hash, audit y catálogo al retirar la credencial o revertir.

Pruebas finales: 4 suites / 73 tests; PostgreSQL 17 propio recién creado, 142 migraciones normales y repeat no-op, API + scripts TS 0, Biome 7 archivos 0. El CLI seed tiene los mismos 9 diagnósticos de estilo que su baseline, registrados por separado; no se afirma lint global 0. El test Mercaria ya esperaba 4 scopes pese a la fuente previa con payments:read/write: se corrige sólo su aserción a los 6 scopes existentes.

El CAS compara revisiones, autoridad, owner/fences y ambos bindings/credenciales inertes. Rechaza drift y revierte toda la transacción cuando falla el segundo UPDATE. La reversión compara el catálogo canónico, digest y creador propio retirado, desactiva el registro preservando FK/historia, restaura sólo los valores añadidos y suspende sólo el registrador. Una repetición de mantenimiento conserva ese resultado.

El transporte recibe respuestas controladas de Fetch: origen único HTTPS `https://api.oxy.so`, redirects rechazados, 64 KiB máximo, deadline 10 s y issuer TTL ≤ 300 s. Comprueba cancelación antes de cada nuevo efecto y caducidad después de los awaits de registro de intent. El test de ACK desconocido crea/retira una credencial SQL real; no hace HTTP externo. La cancelación previa no crea credencial ni hace dispatch. Esto no acredita señales OS ni un delivery remoto. La prueba anterior de mint/register/revoke por rutas canónicas reales está en [registrador efímero](../2026-10-03-i05-ephemeral-registrar/README.md).

Se preservan los fallos iniciales: metadata de fixture workload development frente a production, aserción Mercaria obsoleta, Response consumida reutilizada por un mock y mapping clientId que aún no aceptaba null para máquina. No son una reproducción RED→GREEN de un exploit de producto. La última ejecución atraviesa los guards posteriores a `record`, añadidos tras la revisión root.

Reproducción: `python3 -B scripts/rehearsal/test-i05-foreground-configuration.py`. El script valida PID/exe/data/socket de su propio PG antes de CREATE DATABASE, scrubs libpq y usa no-env-file; para API/scripts TS y lint consultar los registros. No se ejecutó el seed global, AWS, autoridad live o Stripe.

Pendiente operativo: launcher con intent local durable previo al dispatch, source/image/plan pins, reconciliation por nonce ante ACK desconocido y readback/cleanup. Stdout no es ACK durable CloudWatch. Root operará sólo tras revisar el plan exacto y la imagen final; este checkpoint no autoriza ejecutar una imagen antigua.
