# Paso a paso del flujo de mensajes

En los logs verás líneas `[paso-N]` para seguir en qué etapa está cada mensaje. Si el flujo se estanca, el **último paso que aparezca** indica dónde paró.

| Paso | Dónde | Qué significa |
|------|--------|----------------|
| **1** | worker (inbound) | Mensaje recibido de WhatsApp. |
| **2** | worker (inbound) | Si ves `STUB_SKIP`: mensaje no se pudo descifrar (ej. "No matching sessions") y se ignora. Si ves `Mensaje válido`: sigue al paso 3. |
| **3** | worker (inbound) | Evento guardado en BD (`eventId`). |
| **4** | worker (inbound) | Webhook encolado para cada endpoint. Si ves `Sin endpoints`: no hay URL de webhook configurada. |
| **5** | worker (webhook) | Worker va a enviar el POST al webhook (URL del bot). Si ves `omitido (endpoint deshabilitado)`: el endpoint está desactivado. |
| **6** | worker (webhook) | `Webhook entregado OK`: tu bot recibió el evento. `Webhook falló`: error de red o tu servidor respondió con error. |
| **7** | api | Tu bot llamó a la API para enviar respuesta. Si nunca ves paso 7, el bot no está enviando (revisa lógica del bot tras recibir el webhook). |
| **8** | worker (outbound) | Worker procesa el mensaje a enviar. Si ves `FALLO outbound: ...`: device no encontrado, no ONLINE, socket no conectado, etc. |
| **9** | worker (outbound) | `Mensaje enviado OK`: WhatsApp recibió el mensaje. `FALLO envío por socket`: error al enviar por Baileys. |

## Cómo usarlo

1. Envía un mensaje de prueba al número conectado.
2. En los logs (worker y api) busca líneas que empiecen por `[paso-`.
3. Si solo ves hasta paso 2 con `STUB_SKIP` → el mensaje no se descifra (problema de sesión/LID).
4. Si ves 1, 2, 3, 4 pero no 5/6 → la cola de webhook no se procesa o no hay worker.
5. Si ves hasta 6 pero no 7 → el bot no está llamando a la API para enviar la respuesta.
6. Si ves 7 pero no 8 → la cola outbound no se procesa o el job falla antes de enviar.
7. Si ves 8 pero no 9 → fallo al enviar por socket (dispositivo desconectado, etc.).

Para filtrar solo los pasos en Docker:

```bash
docker compose logs -f 2>&1 | grep '\[paso-'
```
