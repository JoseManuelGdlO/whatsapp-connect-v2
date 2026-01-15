# apps/worker — WA Engine + Jobs

## Responsabilidad
- Mantener sesiones WhatsApp Web por `deviceId`
- Emitir eventos entrantes (raw) y normalizarlos
- Encolar entregas de webhook (retries, DLQ)
- Procesar envíos salientes (send/test) desde cola

## Colas (plan)
- `webhook_dispatch`: entrega HTTP firmada + reintentos/backoff + DLQ
- `outbound_messages`: envíos salientes (texto MVP) + estado/errores

