# apps/worker — WA Engine + Jobs

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
- `x-signature`: HMAC-SHA256 del string `${x-timestamp}.${rawBody}` usando `webhookEndpoint.secret`

### Payload (JSON)
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

