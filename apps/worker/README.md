# apps/worker — WA Engine + Jobs

## Configuración crítica (despliegue)

- **`WA_AUTH_ENC_KEY_B64`**: clave AES-256 (32 bytes en base64) para cifrar el estado de sesión WhatsApp en BD. **Debe ser idéntica en todos los procesos que comparten la misma base de datos** (workers, API si accede a `waSession`). Si una instancia usa una clave distinta, no podrá descifrar el estado guardado por otra y las sesiones fallarán con errores de descifrado ("No matching sessions") en todos los dispositivos.

### Reconexión automática tras despliegue

Al arrancar, el worker reconecta **todos los dispositivos que tienen sesión guardada** (estado ya vinculado), para no tener que ir dispositivo por dispositivo pulsando "Conectar" tras un deploy.

- **`WORKER_RECONNECT_ALL_DELAY_MS`** (opcional): milisegundos de espera antes de empezar las reconexiones (por defecto 5000).
- **`WORKER_RECONNECT_STAGGER_MS`** (opcional): milisegundos entre cada reconexión para no saturar (por defecto 800). Con ~20 dispositivos son unos 16 s en total.
- **`WORKER_INBOUND_ACK_MESSAGE`** (opcional): si está definido, el worker envía este texto como mensaje automático al recibir cada mensaje entrante. Sirve para "resetear" la conversación y evitar que WhatsApp muestre "Esperando el mensaje" cuando el error persiste (ej. `Un momento, te respondo en seguida.`).
- **`WORKER_COMPOSING_BEFORE_SEND_MS`** (opcional): milisegundos que se muestra "escribiendo..." antes de enviar cada respuesta (por defecto 1500).

## Responsabilidad
- Mantener sesiones WhatsApp Web por `deviceId`
- Emitir eventos entrantes (raw) y normalizarlos
- Encolar entregas de webhook (retries, DLQ)
- Procesar envíos salientes (send/test) desde cola

## Colas (plan)
- `webhook_dispatch`: entrega HTTP firmada + reintentos/backoff + DLQ
- `outbound_messages`: envíos salientes (texto MVP) + estado/errores

## Webhook (eventos entrantes hacia tu bot)

Cuando llega un mensaje a WhatsApp, el worker crea un evento `message.inbound` y lo entrega por webhook a los endpoints configurados del tenant.

### Headers de entrega
En cada POST al webhook el worker envía:
- `x-event-id`: id del evento (DB)
- `x-tenant-id`: tenant del evento
- `x-device-id`: device que recibió el mensaje
- `x-event-type`: tipo (ej: `message.inbound`)
- `x-timestamp`: epoch ms (string)
- `x-signature`: HMAC-SHA256 del string `${x-timestamp}.${rawBody}` usando `webhookEndpoint.secret`### Payload (JSON)
El body del webhook tiene esta forma:

```json
{
  "eventId": "ck...",
  "tenantId": "ck...",
  "deviceId": "ck...",
  "type": "message.inbound",
  "normalized": {
    "kind": "inbound_message",
    "messageId": "3EB0...",
    "from": "549XXXXXXXXXX@s.whatsapp.net",
    "to": "549YYYYYYYYYY@s.whatsapp.net",
    "timestamp": 1736900000,
    "content": { "type": "text", "text": "hola", "media": null }
  },
  "raw": { "key": { "remoteJid": "..." }, "message": { } },
  "createdAt": "2026-01-15T00:00:00.000Z"
}
```

### Campos clave para responder
Para que tu bot responda “al mismo chat”:
- `deviceId`: desde qué WhatsApp responder (se usa en `/devices/:id/messages/send`)
- `normalized.from`: chat destino (JID; usar tal cual como `to`)
- `tenantId` o header `x-tenant-id`: úsalo como `x-tenant-id` al llamar el API (modo bot con `x-api-key`)

### "Esperando el mensaje. Esto puede tomar tiempo"
WhatsApp muestra ese texto al usuario cuando el negocio **no responde** (o no hay señal de actividad) en un tiempo. Causas típicas:
- **Respuesta lenta**: el webhook recibe el evento pero tu sistema tarda en llamar a `POST /devices/:id/messages/send`.
- **Cola cargada**: muchos mensajes en `outbound_messages` o Redis lento retrasan el envío.
- **Sin respuesta**: el webhook no llama al API para enviar mensaje (bot apagado, error, etc.).

El worker mitiga esto: envía presencia "escribiendo..." **en cuanto llega el mensaje** (antes de marcar como leído), luego marca como leído, y de nuevo "escribiendo..." justo antes de enviar la respuesta. Si el bot no responde, la presencia se limpia a los ~25 s. Opcionalmente: `WORKER_COMPOSING_BEFORE_SEND_MS` (por defecto 1500 ms) para la duración antes del envío.

**Si el error persiste** (por ejemplo el usuario ya vio "Esperando el mensaje" y al reenviar sigue igual), la única forma de "resetear" esa conversación es que el negocio **envíe un mensaje real**. Puedes activar un **mensaje de acuse automático**: define `WORKER_INBOUND_ACK_MESSAGE` (ej. `Un momento, te respondo en seguida.`) y el worker enviará ese texto al chat en cuanto reciba cualquier mensaje entrante. Así la conversación recibe siempre al menos un mensaje y WhatsApp deja de mostrar "Esperando el mensaje". El bot puede seguir respondiendo después por webhook; el acuse es adicional y opcional.