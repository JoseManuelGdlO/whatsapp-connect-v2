# apps/api — Backend API

## Responsabilidad
- Auth (JWT), tenants, users/roles
- CRUD de devices y webhooks
- Endpoints de envío saliente (send/test)
- Exponer estado/QR por SSE o WebSocket
- Auditoría/logs básicos

## Endpoint base (MVP)
- `GET /health`

## Integración bot (responder al mismo chat)

Cuando llega un inbound por webhook, tu bot puede responder enviando un mensaje saliente con el mismo `deviceId` y el mismo chat (`normalized.from`).

### Requisitos
- Configura `BOT_API_KEY` en el API (env/secret).
- Tu bot debe enviar headers:
  - `x-api-key: <BOT_API_KEY>`
  - `x-tenant-id: <tenantId>` (viene en el webhook)

> Nota: estos endpoints también siguen aceptando JWT (Authorization Bearer) para uso desde el panel/usuarios. Si mandas `x-api-key`, se usa modo bot.

### Enviar respuesta
- Endpoint: `POST /devices/:deviceId/messages/send`
- Body (`type: "text"`):
  - `to`: usar `normalized.from` tal cual (es JID)
  - `text`: tu respuesta
- Body (`type: "image"`):
  - `to`: usar `normalized.from` tal cual (es JID)
  - `imageUrl`: URL pública `http/https` accesible desde el worker
  - `caption` (opcional)
- Body (`type: "document"` — PDF):
  - `to`: usar `normalized.from` tal cual (es JID)
  - `documentUrl`: URL pública `http/https` accesible desde el worker
  - `fileName` (opcional, default `document.pdf`; debe terminar en `.pdf`)
  - `caption` (opcional)
- Body (`type: "status_image"` — estado/historia):
  - **sin `to`**: el worker siempre publica en `status@broadcast`
  - `imageUrl`: URL pública `http/https` accesible desde el worker (no ruta local)
  - `caption` (opcional)
  - `statusJidList`: **obligatorio**, array con al menos 1 JID (máx. 500). Lo arma el bot (CRM, inbound `normalized.from`, segmento, etc.). Si va vacío, el estado se publica pero nadie lo ve. El worker añade solo el JID propio del device (PN o LID, alineado con la audiencia) para que “Mi estado” pueda verse en el teléfono emisor; no hace falta incluirlo en el body.
  - Nota LID vs número: usa el mismo JID con el que ya conversan (`...@lid` o `...@s.whatsapp.net`); si el chat real es `@lid` y solo mandas el número, esa persona puede no ver el estado. No mezcles `@lid` y `@s.whatsapp.net` en la misma lista.

Ejemplo:

```bash
curl -X POST "$API_URL/devices/$DEVICE_ID/messages/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $BOT_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{"to":"'"$FROM_JID"'","text":"Hola, soy el bot"}'

curl -X POST "$API_URL/devices/$DEVICE_ID/messages/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $BOT_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{"to":"'"$FROM_JID"'","type":"image","imageUrl":"https://example.com/car.png","caption":"Imagen del vehiculo"}'

curl -X POST "$API_URL/devices/$DEVICE_ID/messages/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $BOT_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{"to":"'"$FROM_JID"'","type":"document","documentUrl":"https://example.com/cotizacion.pdf","fileName":"cotizacion.pdf","caption":"Tu cotizacion esta lista"}'

curl -X POST "$API_URL/devices/$DEVICE_ID/messages/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $BOT_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{"type":"status_image","imageUrl":"https://cdn.cliente.com/estado.jpg","caption":"Texto del estado","statusJidList":["'"$FROM_JID"'"]}'
```

## Troubleshooting- **401 `invalid_api_key`**: el header `x-api-key` no coincide con `BOT_API_KEY` del API.
- **400 `tenantId_required`**: falta header `x-tenant-id` (usa el `tenantId` del webhook o el header `x-tenant-id` del webhook).
- **403 `forbidden`**: el `deviceId` no pertenece al tenant indicado en `x-tenant-id` (o al tenant del JWT).
- **409 `device_not_online`**: el device no está ONLINE (necesita conectar sesión/QR).
- **Outbound quedó en FAILED con `device_not_connected`**: el worker no tenía sesión activa en ese momento. Revisa que el worker esté corriendo y el device conectado.

Para inspeccionar envíos:
- `GET /devices/:id/messages/outbound` (últimos 50, incluye `status` y `error`).

## Depuración

Para localizar fallos de forma sistemática (auth, dispositivos, colas, worker), ver la guía central: [docs/DIAGNOSTICO.md](../../docs/DIAGNOSTICO.md). Flujos paso a paso en [docs/FLUJOS.md](../../docs/FLUJOS.md).