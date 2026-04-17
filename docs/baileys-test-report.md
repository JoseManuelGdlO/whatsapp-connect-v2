# Reporte de pruebas de carga y resiliencia (Baileys)

## Contexto
Se implementaron y ejecutaron pruebas para tres capas:
- Capa wrapper/API (carga y latencia).
- Worker/Baileys (burst, soak corto, media e inbound resiliente).
- Caos/reconexión (fallos de sesión, cortes y backoff).

Ejecución híbrida:
- Por defecto: mock/simulado.
- Suite real: opcional y protegida por `RUN_REAL_WA_TESTS=true`.

## Comandos ejecutados
- `npm run test -w apps/worker`
- `npm run test:load:mock -w apps/api`

## Resultado global
- Worker: `5` archivos de prueba, `17` tests en `pass`, `1` en `skip`.
- API load test (mock): resultados guardados en `apps/api/load-test-results.json`.
- Lint/diagnóstico en archivos editados: sin errores.

## Lectura de `apps/api/load-test-results.json` (explicación sencilla)

Esta sección explica el archivo de resultados **como si no hubiera conocimiento previo de software**. Los números exactos **cambian en cada ejecución**; lo que sigue describe el significado de cada parte y cómo interpretar una corrida típica tras `npm run test:load:mock -w apps/api`.

### Qué se hizo con ese comando (idea general)

Imagina que el sistema es un **mostrador** donde alguien pide “manda este mensaje”. El comando **no usa WhatsApp real**: usa un **mostrador de prueba** en la propia máquina (`"mode": "mock"`). Es como ensayar con un escenario controlado antes de usar el servicio real.

- **`targetUrl`**: a qué dirección se enviaron las peticiones de prueba (por ejemplo `http://127.0.0.1:3800`: la computadora local, en un puerto concreto).
- **`startedAt` / `finishedAt`**: cuándo empezó y terminó la prueba (suele durar alrededor de un minuto en la configuración por defecto del script).

### Las dos “fases” que aparecen en el JSON

#### 1) Escenarios `A_burst_...` (ráfagas)

Aquí el programa simula **muchas peticiones llegando de golpe** (o en grupos).

El nombre suele ser como `A_burst_50_c1`:

- El número del medio (**50, 100 o 200**) = **cuántas veces** se intentó pedir algo en esa ronda.
- La parte **`c` + número** = **cuántas peticiones van en paralelo** (cuántas “ventanillas” abiertas a la vez). Por ejemplo `c10` = hasta diez a la vez.

En cada bloque aparece:

- **`success`**: cuántas veces la respuesta fue “ok, recibido”.
- **`failed`**: cuántas veces **no** salió bien.
- **`errors` con `http_503`**: el servidor respondió algo equivalente a **“ahorita no puedo, vuelve después”** (servicio no disponible temporalmente). En modo **mock** eso **puede ser intencional y aleatorio** para imitar días malos de red o saturación, no necesariamente un fallo del código en producción.

Los campos que terminan en **`Ms`** son **milisegundos** (mil milisegundos = un segundo). Indican **cuánto tardó cada pedido en ir y volver**.

- **`avgMs`**: tiempo promedio.
- **`p50Ms`**: la mitad de los pedidos tardaron **menos** que este valor (lo “típico”).
- **`p95Ms`**: el 95% tardaron menos que este valor (incluye también los un poco más lentos).
- **`p99Ms`**: casi todos tardaron menos que este valor (captura los casos más lentos y raros).

En corridas normales del mock, muchos valores caen **alrededor de 0,06 a 0,10 segundos** (60–100 ms): para una persona es **casi instantáneo**.

**Lectura humana de ejemplos** (los números concretos están en tu archivo; aquí solo el tipo de mensaje):

- Si en una ronda de 50 intentos, uno a la vez, ves **varios `failed` y todos son `http_503`**, suele interpretarse como **fallos simulados**, no como “el sistema se rompió por completo”.
- Si con más concurrencia la mayoría son **éxitos** y solo **uno o pocos** fallos `503`, también encaja con **error ocasional inyectado** en el mock.

#### 2) `B_soak_test` (carga constante, como una gotera)

Aquí no es tanto una explosión, sino un **ritmo constante**:

- **`durationSeconds`**: cuántos segundos duró esa parte (por ejemplo 20).
- **`rps`**: objetivo de **pedidos por segundo** (por ejemplo 5).
- **`total`**: cuántos pedidos se hicieron en total en esa ventana.
- **`success` / `failed`**: cuántos salieron bien o mal en **esa** ventana.

En una corrida puede ocurrir que **todos** sean éxitos (`failed: 0`) si en esa ejecución el azar del mock no disparó `503`; en otra puede haber algunos fallos. Por eso conviene mirar **siempre el JSON de la última ejecución**.

### Idea clave para no malinterpretar

- Este JSON **no prueba WhatsApp real**; prueba el **camino de entrada** (muchas peticiones como si fueran envíos) contra un **servidor falso local**.
- Los **`503`** en ráfagas **suelen ser parte del diseño del mock** para ver comportamiento con **errores ocasionales**, no solo el escenario perfecto.

Si hace falta interpretar **una sola fila** del archivo (por ejemplo `A_burst_200_c5`), basta con leer: total de intentos, cuántos en paralelo, éxitos, fallos, y los tiempos en milisegundos como “qué tan rápido respondió en promedio y en el peor caso habitual (p95)”.

## Caso A - Burst controlado
**Para que sirve**  
Validar comportamiento bajo ráfagas (50/100/200) y distintas concurrencias (1/2/5/10), midiendo éxito/fallo y percentiles de latencia.

**Pruebas implementadas**  
- Worker: `apps/worker/src/wa/inbound.test.ts` (`procesa burst de mensajes sin acumular errores de encolado`).
- API wrapper: `apps/api/scripts/wrapper-load-test.mjs` (`A_burst_*`).

**Resultados**  
- En wrapper mock, p95 se mantuvo alrededor de `97-103 ms` según concurrencia.
- Éxito aproximado entre `97%` y `98%` (fallos simulados `503` por `MOCK_FAIL_RATE`).
- En worker mock, 100 mensajes inbound del burst fueron procesados y encolados sin pérdida en la ruta probada.

**Justificación**  
Los fallos observados en capa API provienen de inyección de error controlada (`503`) para validar tolerancia. El rango de p95 estable indica que el worker/API no mostró degradación severa al subir concurrencia en esta simulación.

## Caso B - Soak test
**Para que sirve**  
Detectar degradación gradual (latencia creciente, errores acumulados) en carga sostenida.

**Pruebas implementadas**  
- Worker: `apps/worker/src/wa/inbound.test.ts` (`mantiene comportamiento estable en soak corto de mensajes de texto`).
- API wrapper: `apps/api/scripts/wrapper-load-test.mjs` (`B_soak_test`).

**Resultados**  
- Soak API (20s, 5 rps): `100` requests, `95` success, `5` fail simulados, `p95=93.84 ms`, `p99=102.2 ms`.
- Soak corto en worker: 20 iteraciones secuenciales con encolado consistente (sin errores en test).

**Justificación**  
No hay evidencia de drift de latencia en la ventana ejecutada. Los fallos se corresponden al porcentaje de error inducido en mock, no a colapso de la aplicación.

## Caso C - Reconexión / caos
**Para que sirve**  
Validar resiliencia ante desconexiones, errores de sesión y comportamiento de reintentos/backoff.

**Pruebas implementadas**
- `apps/worker/src/wa/sessionManager.test.ts`
  - `limpia sesiones corruptas y reintenta conexión en session sync error`.
  - `aplica backoff exponencial cuando hay cierres consecutivos de conexión`.
  - `no reconecta cuando el cierre es loggedOut`.
- `apps/worker/src/wa/inbound.test.ts`
  - `continúa procesando cuando readMessages falla (caos de dependencia)`.

**Resultados**
- Se confirmó reconexión a 5s tras `session_sync_error`.
- Se confirmó escalamiento de backoff (5s -> 10s) en cierres consecutivos.
- Se confirmó no reconexión cuando el cierre corresponde a `loggedOut`.
- Ante fallo de dependencia en `readMessages`, el flujo continúa y encola webhook.

**Justificación**
Las aserciones validan que el control de reconexión evita tormentas, distingue cierres terminales (`loggedOut`) y mantiene procesamiento útil bajo fallos parciales.

## Caso D - Media
**Para que sirve**  
Separar el comportamiento entre tipos de contenido y evitar asumir que texto == media.

**Pruebas implementadas**
- `apps/worker/src/wa/inbound.test.ts`
  - `procesa tipos de media como mensajes válidos sin disparar clearSenderAndReconnect`.
  - Tipos cubiertos: `image`, `document`, `audio`.

**Resultados**
- Los tipos media probados se procesaron como mensajes válidos en inbound.
- No se disparó lógica de limpieza/reconexión reservada a stubs de descifrado.

**Justificación**
Se verifica explícitamente separación de rutas lógicas: media entra al flujo normal, mientras la reconexión se activa solo por indicadores de descifrado fallido.

## Suite real opcional (gated)
**Implementación**
- Archivo: `apps/worker/src/wa/realSuite.test.ts`.
- Script: `npm run test:wa-real -w apps/worker`.

**Comportamiento**
- Por defecto no corre pruebas reales.
- Solo corre bloque real cuando `RUN_REAL_WA_TESTS=true`.
- Requiere `WA_REAL_DEVICE_ID` y `WA_REAL_TARGET_JID`.

## Limitaciones y siguiente paso recomendado
- Esta ejecución fue en modo mock para seguridad/control.
- Para completar validación operativa final, ejecutar una ventana corta de suite real (entorno sandbox) con límites de volumen y observabilidad activa.

## Runbook de actualizacion segura de Baileys (v7.0.0-rc.9)

### 1) Cambios aplicados en codigo
- Dependencia actualizada en `apps/worker/package.json` a `@whiskeysockets/baileys@^7.0.0-rc.9`.
- Lockfile regenerado (`package-lock.json`) para resolver la nueva version.
- Endurecido parsing de desconexion en `apps/worker/src/wa/sessionManager.ts`:
  - ahora extrae `statusCode` desde rutas alternativas (`error.output.statusCode`, `error.statusCode`, `error.data`, `error.output.payload.statusCode`);
  - mantiene decision de reconexion/no reconexion por `DisconnectReason.loggedOut`.
- Cobertura agregada en `apps/worker/src/wa/sessionManager.test.ts` para validar caso `loggedOut` cuando el codigo viene en `error.data`.

### 2) Validacion tecnica ejecutada
- `npm run -w apps/worker build`
- `npm run -w apps/worker test`
- Resultado: build OK y test suite OK (`18 pass`, `1 skip`).

### 3) Validacion preproduccion (checklist operativo)
- Conectar 1 dispositivo de prueba y confirmar ciclo: `QR -> ONLINE`.
- Enviar y recibir mensajes (texto + media) y confirmar encolado/salida.
- Reiniciar worker y confirmar reconexion automatica.
- Simular corte de red breve y confirmar recuperacion a `ONLINE`.
- Revisar que `Device.lastError` no acumule `bad-request`/`428` repetitivo.

### 4) Canary en produccion
- Fase 1: mover 1-2 dispositivos no criticos durante 24h.
- Fase 2: ampliar por lotes (10% -> 30% -> 100%) solo si la fase anterior se mantiene estable.
- Monitorear durante canary:
  - frecuencia de `connection=close` por dispositivo;
  - volumen de correos `sendDeviceDisconnectAlert`;
  - tiempo medio de recuperacion a `ONLINE`;
  - tasa `FAILED` en outbound.

### 5) Criterio de rollback
Aplicar rollback inmediato si ocurre alguno:
- aumento sostenido >30% de desconexiones/hora vs baseline;
- loop de reconexion persistente con `bad-request`/`428`;
- degradacion visible en entrega outbound.

Rollback tecnico:
1. Revert de cambios de dependencia/lockfile.
2. Redeploy del worker.
3. Verificacion rapida: `ONLINE`, envio/recepcion y ausencia de loops.
