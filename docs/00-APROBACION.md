# Aprobación — WhatsApp Connect v2 (Multi-tenant)

## Resumen
Sistema para conectar **múltiples números/dispositivos** mediante **WhatsApp Web (QR)** y reenviar eventos entrantes a **webhooks por tenant**, con un **panel web** para operar conexiones y enviar **mensaje de prueba**.

## Alcance (MVP)
- Multi-tenant: tenants, usuarios, roles (superadmin/tenantAdmin/agent).
- Conexión por device con QR, estado (OFFLINE/QR/ONLINE/ERROR), reconexión.
- Eventos entrantes → webhook por tenant (payload **normalized + raw**, firmado, con retries).
- Envío saliente **texto** (incluye “test de conectividad”) desde panel/API.
- Logs básicos y listado de entregas/outbound.

## Fuera de alcance (por ahora)
- API oficial de Meta (Cloud/On-Prem).
- Envío masivo/campañas/plantillas.
- UI avanzada de chat / bandeja de agentes.
- Alta disponibilidad multi-región.

## Supuestos importantes
- Integración **no-oficial** (WhatsApp Web) puede ser frágil y con riesgo de bloqueo/bans.
- Webhooks son **at-least-once** (idempotencia requerida en receptor).
- “Conectividad OK” = sesión online + ack de envío (y opcional respuesta entrante).

## Seguridad
- Aislamiento por `tenantId` en todas las entidades.
- Webhooks firmados con HMAC (secret por endpoint, rotación).
- Estado de sesión WA cifrado en DB (AES con master key en env/secret manager).

## Criterios de aceptación (checklist)
- [ ] Puedo crear tenant y usuario y hacer login.
- [ ] Puedo crear un device y conectarlo por QR.
- [ ] Veo el estado del device (QR/online/offline/error).
- [ ] Un mensaje entrante genera evento y se envía al webhook del tenant.
- [ ] El webhook llega con firma válida y `normalized + raw`.
- [ ] Si el webhook falla, hay retries y se registra el delivery.
- [ ] Puedo enviar un “mensaje de prueba” desde el panel y ver `queued/sent/failed`.
- [ ] Queda registro de outbound y deliveries.

## Aprobación
- Aprobado por: ______________________
- Fecha: _____________________________
- Observaciones: ______________________

