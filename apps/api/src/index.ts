import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? 'env.local' });

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, UserRole } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import crypto from 'crypto';
import { createLogger } from '@wc/logger';

const app = express();
const prisma = new PrismaClient();
const logger = createLogger(prisma, 'api');

// Disable conditional GET/ETag caching; the web UI polls and expects 200 JSON (not 304).
app.set('etag', false);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});
const deviceCommandsQueue = new Queue('device_commands', { connection: redis });
const outboundQueue = new Queue('outbound_messages', { connection: redis });

function hmacSha256(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

type BotAuth = { tenantId: string };
function botApiKeyRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = req.header('x-api-key') ?? '';
  const expected = process.env.BOT_API_KEY ?? '';
  if (!expected) return res.status(500).json({ error: 'bot_api_key_not_configured' });
  if (!apiKey || !safeEqual(apiKey, expected)) {
    return res.status(401).json({ error: 'unauthorized', message: 'invalid_api_key' });
  }
  const tenantId = req.header('x-tenant-id');
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });
  (req as any).bot = { tenantId } satisfies BotAuth;
  next();
}

function authOrBotApiKeyRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  const apiKey = req.header('x-api-key');
  if (apiKey) return botApiKeyRequired(req, res, next);
  return authRequired(req, res, next);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const asyncHandler = (fn: express.RequestHandler): express.RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

const JwtPayloadSchema = z.object({
  sub: z.string(),
  role: z.nativeEnum(UserRole),
  tenantId: z.string().nullable()
});
type JwtPayload = z.infer<typeof JwtPayloadSchema>;

function signToken(payload: JwtPayload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  return jwt.sign(payload, secret, { expiresIn: '12h' });
}

function getAuth(req: express.Request): JwtPayload {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new Error('Missing Bearer token');
  }
  const token = header.slice('Bearer '.length);
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const decoded = jwt.verify(token, secret);
  return JwtPayloadSchema.parse(decoded);
}

function authRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    (req as any).auth = getAuth(req);
    next();
  } catch (err: any) {
    logger.warn('Authentication failed', err, {
      metadata: { path: req.path, method: req.method }
    }).catch(() => {}); // Don't block response if logging fails
    res.status(401).json({ error: 'unauthorized', message: err?.message ?? 'unauthorized' });
  }
}

function requireRole(...roles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = (req as any).auth as JwtPayload | undefined;
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    if (!roles.includes(auth.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

function getTenantScope(auth: JwtPayload) {
  if (auth.role === UserRole.SUPERADMIN) return { tenantId: null as string | null, isSuperadmin: true };
  if (!auth.tenantId) throw new Error('tenant_required');
  return { tenantId: auth.tenantId, isSuperadmin: false };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api' });
});

// Public endpoint (no authentication required)
app.get(
  '/public/qr/:token',
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    
    const link = await prisma.publicQrLink.findUnique({
      where: { token },
      include: { device: true }
    });

    if (!link) {
      return res.status(404).json({ status: 'NOT_FOUND' });
    }

    // Check if expired
    if (new Date() > link.expiresAt) {
      return res.json({ status: 'EXPIRED', deviceLabel: link.device.label });
    }

    // Check device status
    const device = await prisma.device.findUnique({ where: { id: link.deviceId } });
    if (!device) {
      return res.status(404).json({ status: 'NOT_FOUND' });
    }

    if (device.status === 'ONLINE') {
      // Mark link as expired since device is connected
      await prisma.publicQrLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date() }
      });
      return res.json({ 
        status: 'ONLINE', 
        deviceLabel: device.label 
      });
    }

    if (device.status === 'QR' && device.qr) {
      return res.json({ 
        status: 'QR', 
        qr: device.qr,
        deviceLabel: device.label,
        expiresAt: link.expiresAt
      });
    }

    // Device is in other state (OFFLINE, ERROR)
    return res.json({ 
      status: 'EXPIRED', 
      deviceLabel: device.label 
    });
  })
);

// Seed superadmin if missing
async function ensureSuperadmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: UserRole.SUPERADMIN,
      tenantId: null
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[api] seeded SUPERADMIN ${email}`);
}

app.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
  const Body = z.object({ email: z.string().email(), password: z.string().min(1) });
  const { email, password } = Body.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signToken({ sub: user.id, role: user.role, tenantId: user.tenantId ?? null });
  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId }
  });
  })
);

app.get(
  '/me',
  authRequired,
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const user = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
  })
);

app.post(
  '/tenants',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const Body = z.object({ name: z.string().min(1) });
  const { name } = Body.parse(req.body);
  const tenant = await prisma.tenant.create({ data: { name } });
  res.status(201).json(tenant);
  })
);

app.get(
  '/tenants',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (_req, res) => {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(tenants);
  })
);

app.delete(
  '/tenants/:id',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const tenantId = req.params.id;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return res.status(404).json({ error: 'not_found' });

    // Delete the tenant (cascade will handle related records)
    await prisma.tenant.delete({ where: { id: tenantId } });
    res.json({ ok: true });
  })
);

app.get(
  '/users',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const tenantId = req.query.tenantId as string | undefined;
    const where: any = tenantId ? { tenantId } : {};
    const users = await prisma.user.findMany({
      where,
      select: { id: true, email: true, role: true, tenantId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json(users);
  })
);

app.post(
  '/users',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const Body = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.nativeEnum(UserRole),
    tenantId: z.string().nullable()
  });
  const body = Body.parse(req.body);

  const passwordHash = await bcrypt.hash(body.password, 10);
  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash,
      role: body.role,
      tenantId: body.tenantId
    },
    select: { id: true, email: true, role: true, tenantId: true, createdAt: true }
  });
  res.status(201).json(user);
  })
);

app.delete(
  '/users/:id',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const auth = (req as any).auth as JwtPayload;
    const userId = req.params.id;
    if (auth.sub === userId) return res.status(400).json({ error: 'cannot_delete_self' });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'not_found' });
    await prisma.user.delete({ where: { id: userId } });
    res.json({ ok: true });
  })
);

app.post(
  '/devices',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const Body = z.object({
    tenantId: z.string().optional(),
    label: z.string().min(1),
    phoneHint: z.string().optional()
  });
  const body = Body.parse(req.body);

  const tenantId = scope.isSuperadmin ? (body.tenantId ?? null) : scope.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(400).json({ error: 'invalid_tenantId' });

  const device = await prisma.device.create({
    data: { tenantId, label: body.label, phoneHint: body.phoneHint }
  });
  res.status(201).json(device);
  })
);

app.get(
  '/devices',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const tenantId = scope.isSuperadmin ? (req.query.tenantId as string | undefined) : scope.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });
  const devices = await prisma.device.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' }
  });
  res.json(devices);
  })
);

app.get(
  '/devices/:id/status',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });
  res.json(device);
  })
);

app.post(
  '/devices/:id/reset-session',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const auth = (req as any).auth as JwtPayload;
    const scope = getTenantScope(auth);
    const device = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!device) return res.status(404).json({ error: 'not_found' });
    if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

    // Best-effort: caller should disconnect first; this removes persisted WA auth state.
    await prisma.waSession.deleteMany({ where: { deviceId: device.id } });
    await prisma.device.update({
      where: { id: device.id },
      data: { status: 'OFFLINE', qr: null, lastError: null }
    });
    res.json({ ok: true });
  })
);

app.get(
  '/devices/:id/stream',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const deviceId = req.params.id;

  const initial = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!initial) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && initial.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let last = JSON.stringify({ status: initial.status, qr: initial.qr, lastError: initial.lastError, updatedAt: initial.updatedAt });
  res.write(`event: device\n`);
  res.write(`data: ${last}\n\n`);

  const timer = setInterval(async () => {
    try {
      const d = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!d) return;
      const cur = JSON.stringify({ status: d.status, qr: d.qr, lastError: d.lastError, updatedAt: d.updatedAt });
      if (cur !== last) {
        last = cur;
        res.write(`event: device\n`);
        res.write(`data: ${cur}\n\n`);
      }
    } catch {
      // ignore polling errors
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(timer);
  });
  })
);

app.post(
  '/devices/:id/connect',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  await deviceCommandsQueue.add('connect', { deviceId: device.id }, { removeOnComplete: true, removeOnFail: false });
  res.json({ ok: true });
  })
);

app.post(
  '/devices/:id/disconnect',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  await deviceCommandsQueue.add('disconnect', { deviceId: device.id }, { removeOnComplete: true, removeOnFail: false });
  res.json({ ok: true });
  })
);

app.post(
  '/devices/:id/public-link',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const auth = (req as any).auth as JwtPayload;
    const scope = getTenantScope(auth);
    const device = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!device) return res.status(404).json({ error: 'not_found' });
    if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Expire after 24 hours or when device connects (whichever comes first)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const link = await prisma.publicQrLink.create({
      data: {
        deviceId: device.id,
        token,
        expiresAt
      }
    });

    // Return the public URL (frontend URL)
    let frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    // Remove trailing slash if present
    frontendUrl = frontendUrl.replace(/\/$/, '');
    const publicUrl = `${frontendUrl}/public/qr/${token}`;

    res.json({ url: publicUrl, token: link.token, expiresAt: link.expiresAt });
  })
);

app.delete(
  '/devices/:id',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
    const auth = (req as any).auth as JwtPayload;
    const scope = getTenantScope(auth);
    const device = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!device) return res.status(404).json({ error: 'not_found' });
    if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

    // If device is connected (ONLINE or QR), disconnect it first
    if (device.status === 'ONLINE' || device.status === 'QR') {
      await deviceCommandsQueue.add('disconnect', { deviceId: device.id }, { removeOnComplete: true, removeOnFail: false });
      // Wait a bit for the disconnect to process
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Delete the device (cascade will handle related records)
    await prisma.device.delete({ where: { id: device.id } });
    res.json({ ok: true });
  })
);

app.get(
  '/events',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const tenantId = scope.isSuperadmin ? (req.query.tenantId as string | undefined) : scope.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });

  const deviceId = (req.query.deviceId as string | undefined) ?? undefined;
  const type = (req.query.type as string | undefined) ?? undefined;

  const events = await prisma.event.findMany({
    where: {
      tenantId,
      ...(deviceId ? { deviceId } : {}),
      ...(type ? { type } : {})
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(events);
  })
);

function toJid(to: string): string {
  const cleaned = to.replace(/[^\d]/g, '');
  // If caller already provides jid, keep it
  if (to.includes('@')) return to;
  return `${cleaned}@s.whatsapp.net`;
}

app.post(
  '/devices/:id/messages/send',
  authOrBotApiKeyRequired,
  asyncHandler(async (req, res) => {
  const bot = (req as any).bot as BotAuth | undefined;
  const auth = (req as any).auth as JwtPayload | undefined;
  if (!bot && auth && auth.role !== UserRole.SUPERADMIN) return res.status(403).json({ error: 'forbidden' });
  const scope = bot ? { tenantId: bot.tenantId, isSuperadmin: false } : getTenantScope(auth as JwtPayload);

  const Body = z.object({
    to: z.string().min(3),
    type: z.literal('text').default('text'),
    text: z.string().min(1),
    isTest: z.boolean().optional()
  });
  const body = Body.parse(req.body);

  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });
  if (device.status !== 'ONLINE') return res.status(409).json({ error: 'device_not_online' });

  const row = await prisma.outboundMessage.create({
    data: {
      tenantId: device.tenantId,
      deviceId: device.id,
      to: toJid(body.to),
      type: 'text',
      payloadJson: { text: body.text },
      isTest: body.isTest ?? false
    }
  });

  await outboundQueue.add(
    'send',
    { outboundMessageId: row.id },
    { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true }
  );

  res.status(202).json({ outboundMessageId: row.id, status: row.status });
  })
);

app.post(
  '/devices/:id/messages/test',
  authOrBotApiKeyRequired,
  asyncHandler(async (req, res) => {
  const bot = (req as any).bot as BotAuth | undefined;
  const auth = (req as any).auth as JwtPayload | undefined;
  if (!bot && auth && auth.role !== UserRole.SUPERADMIN) return res.status(403).json({ error: 'forbidden' });
  const scope = bot ? { tenantId: bot.tenantId, isSuperadmin: false } : getTenantScope(auth as JwtPayload);

  const Body = z.object({
    to: z.string().min(3),
    text: z.string().min(1)
  });
  const body = Body.parse(req.body);

  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });
  if (device.status !== 'ONLINE') return res.status(409).json({ error: 'device_not_online' });

  const row = await prisma.outboundMessage.create({
    data: {
      tenantId: device.tenantId,
      deviceId: device.id,
      to: toJid(body.to),
      type: 'text',
      payloadJson: { text: body.text },
      isTest: true
    }
  });

  await outboundQueue.add(
    'send',
    { outboundMessageId: row.id },
    { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true }
  );

  res.status(202).json({ outboundMessageId: row.id, status: row.status });
  })
);

app.get(
  '/devices/:id/messages/outbound',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && device.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  const rows = await prisma.outboundMessage.findMany({
    where: { deviceId: device.id },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(rows);
  })
);

app.get(
  '/webhooks',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const tenantId = scope.isSuperadmin ? (req.query.tenantId as string | undefined) : scope.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });

  const rows = await prisma.webhookEndpoint.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' }
  });
  res.json(rows);
  })
);

app.post(
  '/webhooks',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);

  const Body = z.object({
    tenantId: z.string().optional(),
    url: z.string().url(),
    secret: z.string().min(8).optional(),
    enabled: z.boolean().optional()
  });
  const body = Body.parse(req.body);

  const tenantId = scope.isSuperadmin ? (body.tenantId ?? null) : scope.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId_required' });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(400).json({ error: 'invalid_tenantId' });

  const secret = body.secret ?? crypto.randomBytes(24).toString('hex');
  const row = await prisma.webhookEndpoint.create({
    data: {
      tenantId,
      url: body.url,
      secret,
      enabled: body.enabled ?? true
    }
  });
  res.status(201).json(row);
  })
);

app.patch(
  '/webhooks/:id',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);

  const Body = z.object({
    url: z.string().url().optional(),
    secret: z.string().min(8).optional(),
    enabled: z.boolean().optional()
  });
  const body = Body.parse(req.body);

  const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && existing.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  const row = await prisma.webhookEndpoint.update({
    where: { id: existing.id },
    data: { ...body }
  });
  res.json(row);
  })
);

app.delete(
  '/webhooks/:id',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && existing.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });
  await prisma.webhookEndpoint.delete({ where: { id: existing.id } });
  res.json({ ok: true });
  })
);

app.post(
  '/webhooks/:id/test',
  authRequired,
  requireRole(UserRole.SUPERADMIN),
  asyncHandler(async (req, res) => {
  const auth = (req as any).auth as JwtPayload;
  const scope = getTenantScope(auth);
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'not_found' });
  if (!scope.isSuperadmin && endpoint.tenantId !== scope.tenantId) return res.status(403).json({ error: 'forbidden' });

  const Body = z.object({
    type: z.string().optional(),
    payload: z.any().optional()
  });
  const bodyIn = Body.parse(req.body ?? {});

  const eventId = crypto.randomUUID();
  const payload = {
    eventId,
    tenantId: endpoint.tenantId,
    deviceId: null,
    type: bodyIn.type ?? 'webhook.test',
    normalized: bodyIn.payload ?? { ok: true, message: 'test' },
    raw: bodyIn.payload ?? { ok: true, message: 'test' },
    createdAt: new Date().toISOString()
  };
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = hmacSha256(endpoint.secret, `${timestamp}.${body}`);

  const resp = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-event-id': eventId,
      'x-tenant-id': endpoint.tenantId,
      'x-device-id': '',
      'x-event-type': payload.type,
      'x-timestamp': timestamp,
      'x-signature': signature
    },
    body
  });

  const text = await resp.text().catch(() => '');
  res.json({ ok: resp.ok, status: resp.status, response: text.slice(0, 2000) });
  })
);

app.use(async (err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const tenantId = (req as any).auth?.tenantId || (req as any).bot?.tenantId;
  await logger.error('Unhandled error in API', err, {
    tenantId: tenantId || undefined,
    metadata: {
      path: req.path,
      method: req.method,
      statusCode: res.statusCode
    }
  });
  res.status(500).json({ error: 'internal_error', message: err?.message ?? 'internal_error' });
});

const port = Number(process.env.API_PORT ?? 3001);
(async () => {
  await ensureSuperadmin();
  // Bind to all interfaces so reverse proxies (EasyPanel) can reach the container.
  app.listen(port, '0.0.0.0', async () => {
    await logger.info(`API listening on http://0.0.0.0:${port}`);
  });
})().catch(async (err) => {
  await logger.error('API failed to start', err);
  process.exit(1);
});

