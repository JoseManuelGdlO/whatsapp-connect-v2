import crypto from 'crypto';
import { Worker } from 'bullmq';

import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

type WebhookJob = {
  deliveryId: string;
};

function hmacSha256(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function startWebhookDispatchWorker() {
  const worker = new Worker<WebhookJob>(
    'webhook_dispatch',
    async (job) => {
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: job.data.deliveryId },
        include: { endpoint: true, event: true }
      });
      if (!delivery) return;
      if (!delivery.endpoint.enabled) return;

      const payload = {
        eventId: delivery.eventId,
        tenantId: delivery.event.tenantId,
        deviceId: delivery.event.deviceId,
        type: delivery.event.type,
        normalized: delivery.event.normalizedJson,
        raw: delivery.event.rawJson,
        createdAt: delivery.event.createdAt
      };

      const body = JSON.stringify(payload);
      const timestamp = Date.now().toString();
      const signature = hmacSha256(delivery.endpoint.secret, `${timestamp}.${body}`);

      const resp = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-id': delivery.eventId,
          'x-tenant-id': delivery.event.tenantId,
          'x-device-id': delivery.event.deviceId,
          'x-event-type': delivery.event.type,
          'x-timestamp': timestamp,
          'x-signature': signature
        },
        body
      });

      if (!resp.ok) {
        throw new Error(`Webhook responded ${resp.status}`);
      }

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SUCCESS', attempts: { increment: 1 }, lastError: null, nextRetryAt: null }
      });
    },
    {
      connection: redis,
      concurrency: 10
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      const attempts = job.attemptsMade + 1;
      const max = (job.opts.attempts ?? 0) || 0;
      const nextRetryAt = attempts < max ? new Date(Date.now() + 2 ** attempts * 1000) : null;
      await prisma.webhookDelivery.update({
        where: { id: (job.data as any).deliveryId },
        data: {
          status: attempts < max ? 'FAILED' : 'DLQ',
          attempts,
          lastError: err?.message ?? 'failed',
          nextRetryAt
        }
      });
    } catch {
      // ignore
    }
  });

  // eslint-disable-next-line no-console
  console.log('[worker] webhook_dispatch worker started');
  return worker;
}

