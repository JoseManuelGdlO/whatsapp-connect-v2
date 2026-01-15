# WhatsApp Connect v2

Hub multi-tenant para conectar sesiones WhatsApp Web (QR) de múltiples números/dispositivos, reenviar eventos por webhook y operar todo desde un panel web.

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
- Aprobación: `docs/00-APROBACION.md`
- API: `apps/api/README.md`
- Worker: `apps/worker/README.md`
- Web: `apps/web/README.md`


