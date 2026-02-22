# WhatsApp Connect v2

Hub multi-tenant para conectar sesiones WhatsApp Web (QR) de múltiples números/dispositivos, reenviar eventos por webhook y operar todo desde un panel web.

## Arquitectura (resumen)

- **API** (Express, puerto 3001): autenticación, CRUD de tenants/usuarios/dispositivos/webhooks, creación de mensajes salientes y encolado en Redis.
- **Worker**: mantiene sesiones WhatsApp (Baileys), recibe mensajes entrantes, crea eventos y entrega webhooks; procesa colas Redis: `device_commands`, `outbound_messages`, `webhook_dispatch`.
- **Web**: SPA (React/Vite) para login, dispositivos, QR, estado en tiempo real, webhooks y envío de prueba.
- **PostgreSQL** (Prisma): tenants, users, devices, WaSession, events, webhooks, deliveries, outbound messages, logs.
- **Redis**: colas BullMQ compartidas entre API y Worker (mismo `REDIS_URL`).

Ver diagrama y detalles en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Flujos paso a paso en [docs/FLUJOS.md](docs/FLUJOS.md). Guía para localizar fallos en [docs/DIAGNOSTICO.md](docs/DIAGNOSTICO.md).

## Componentes
- `apps/api`: Backend HTTP (auth, tenants, devices, webhooks, outbound).
- `apps/worker`: Motor de sesiones WhatsApp Web + colas (webhooks/outbound).
- `apps/web`: Panel web (QR, estado, webhooks, test de envío).
- `packages/db`: Prisma schema y acceso a DB.

## Requisitos
- Node.js 20+
- Docker Desktop (Postgres + Redis)

## Setup (dev)
1) Copia `env.example` a `env.local` y ajusta valores. (En este workspace no se pueden crear dotfiles tipo `.env`.)
2) Levanta infraestructura:

```bash
npm run docker:up
```

3) Instala dependencias:

```bash
npm install
```

4) Genera Prisma client y aplica schema:

```bash
npm run prisma:generate
npm run prisma:push
```

5) Ejecuta todo:

```bash
npm run dev
```

## Documentación
- **Técnica:** [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) (componentes y variables), [docs/FLUJOS.md](docs/FLUJOS.md) (flujos paso a paso), [docs/DIAGNOSTICO.md](docs/DIAGNOSTICO.md) (dónde buscar cuando algo falla)
- Aprobación: `docs/00-APROBACION.md`
- API: `apps/api/README.md`
- Worker: `apps/worker/README.md` (incluye requisito de `WA_AUTH_ENC_KEY_B64` en despliegue)
- Web: `apps/web/README.md`

## Integración con bot externo (responder por WhatsApp)
- **Webhook entrante**: ver formato/headers/payload en `apps/worker/README.md` (incluye `deviceId`, `tenantId` y `normalized.from`).
- **Responder**: el bot debe llamar `POST /devices/:deviceId/messages/send` con `x-api-key` + `x-tenant-id` (ver `apps/api/README.md`).


