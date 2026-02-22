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
- Body (text):
  - `to`: usar `normalized.from` tal cual (es JID)
  - `text`: tu respuesta

Ejemplo:

```bash
curl -X POST "$API_URL/devices/$DEVICE_ID/messages/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $BOT_API_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -d '{"to":"'"$FROM_JID"'","text":"Hola, soy el bot"}'
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