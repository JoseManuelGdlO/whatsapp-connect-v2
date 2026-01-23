import crypto from 'crypto';
import { Worker } from 'bullmq';

import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { createLogger } from '@wc/logger';

const logger = createLogger(prisma, 'worker');

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
      if (!delivery) {
        await logger.warn(`Webhook delivery ${job.data.deliveryId} not found`).catch(() => {});
        return;
      }
      if (!delivery.endpoint.enabled) {
        await logger.debug(`Webhook endpoint ${delivery.endpoint.id} is disabled, skipping`).catch(() => {});
        return;
      }

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

      try {
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
          const errorText = await resp.text().catch(() => '');
          const error = new Error(`Webhook responded ${resp.status}: ${errorText.substring(0, 200)}`);
          await logger.error(
            `Webhook delivery failed for ${delivery.endpoint.url}`,
            error,
            {
              tenantId: delivery.event.tenantId,
              deviceId: delivery.event.deviceId,
              metadata: {
                endpointId: delivery.endpoint.id,
                eventId: delivery.eventId,
                statusCode: resp.status
              }
            }
          ).catch(() => {});
          throw error;
        }

        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SUCCESS', attempts: { increment: 1 }, lastError: null, nextRetryAt: null }
        });
      } catch (err: any) {
        await logger.error(
          `Webhook delivery error for ${delivery.endpoint.url}`,
          err,
          {
            tenantId: delivery.event.tenantId,
            deviceId: delivery.event.deviceId,
            metadata: {
              endpointId: delivery.endpoint.id,
              eventId: delivery.eventId
            }
          }
        ).catch(() => {});
        throw err;
      }
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
      await logger.error(
        `Webhook job failed (deliveryId: ${(job.data as any).deliveryId}, attempts: ${attempts})`,
        err,
        {
          metadata: {
            deliveryId: (job.data as any).deliveryId,
            attempts,
            maxAttempts: max
          }
        }
      ).catch(() => {});
    } catch (updateErr) {
      const error = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
      await logger.error('Failed to update webhook delivery status', error).catch(() => {});
    }
  });

  logger.info('[worker] webhook_dispatch worker started').catch(() => {});
  return worker;
}
