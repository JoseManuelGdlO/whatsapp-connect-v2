# Guía de diagnóstico — Dónde buscar cuando algo falla

Esta tabla relaciona síntomas típicos con archivos, tablas de BD, colas y logs para localizar la causa.

| Síntoma | Revisar primero |
|---------|------------------|
| **Mensajes entrantes no llegan al bot** | Worker: logs `[paso-1]` … `[paso-4]` en consola; tabla `Device` (status, lastError); Redis conectado; tabla `WebhookDelivery` (status PENDING/FAILED/DLQ, lastError, attempts). |
| **Webhook no se llama o falla** | Tabla `WebhookDelivery`: status, lastError, attempts, nextRetryAt; log del worker "Webhook delivery failed"; URL y secret del endpoint; timeout 15s en `webhookDispatch.ts`. |
| **Mensajes salientes no se envían** | Tabla `OutboundMessage`: status, error; tabla `Device`: status; que SessionManager tenga socket para ese deviceId; logs "[paso-8] FALLO" / "[paso-9]" en worker. |
| **"Esperando el mensaje" en WhatsApp** | Tiempo hasta respuesta: processingTimeMs en logs de inbound; cola `outbound_messages` cargada o Redis lento; considerar `WORKER_INBOUND_ACK_MESSAGE` para acuse automático. |
| **Decryption failed / Bad MAC / No matching sessions** | Stub + clearSenderAndReconnect en `inbound.ts`; API `POST /devices/:id/reset-sender-sessions`; `authStateDb.ts`; que `WA_AUTH_ENC_KEY_B64` sea idéntica en todos los procesos que usan WaSession. |
| **Dispositivo no conecta o se cae** | `sessionManager.ts` y `authStateDb.ts`; tabla `Device`: lastError; worker: uncaughtException / unhandledRejection (errores "benign" de red vs salida del proceso); Redis y PostgreSQL accesibles. |
| **API 401 / 403 / 500** | Auth: JWT (Bearer) o x-api-key + x-tenant-id; lógica `getTenantScope` en API; tabla `Log` (service=api) para detalles del error. |

## Tablas de BD útiles

- **Device**: status (OFFLINE/QR/ONLINE/ERROR), lastError, lastSeenAt.
- **Event**: eventos message.inbound (y tipo) por deviceId/tenantId.
- **WebhookDelivery**: status (PENDING/SUCCESS/FAILED/DLQ), lastError, attempts, nextRetryAt.
- **OutboundMessage**: status (QUEUED/PROCESSING/SENT/FAILED), error.
- **Log**: level, service (api | worker), message, error, metadata, tenantId, deviceId.

## Colas Redis (BullMQ)

- **device_commands**: connect/disconnect/reset-sender-sessions. Si el worker no consume, los dispositivos no conectan/desconectan.
- **outbound_messages**: envíos. Si no se consumen, los mensajes quedan en QUEUED/PROCESSING.
- **webhook_dispatch**: entregas a URLs. Si no se consumen, WebhookDelivery queda PENDING.

Comprobar que API y Worker usen el mismo `REDIS_URL`.

## Enlaces

- [ARQUITECTURA.md](ARQUITECTURA.md) — Componentes y variables.
- [FLUJOS.md](FLUJOS.md) — Flujos paso a paso con archivos.
