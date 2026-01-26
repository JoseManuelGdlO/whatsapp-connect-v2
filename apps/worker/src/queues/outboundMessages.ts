import { Worker } from 'bullmq';

import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sessionManager } from './deviceCommands.js';
import { createLogger } from '@wc/logger';

const logger = createLogger(prisma, 'worker');

type OutboundJob = { outboundMessageId: string };

export function startOutboundMessagesWorker() {
  const worker = new Worker<OutboundJob>(
    'outbound_messages',
    async (job) => {
      await logger.info('Processing outbound message job', undefined, {
        metadata: { 
          jobId: job.id,
          outboundMessageId: job.data.outboundMessageId,
          attempt: job.attemptsMade + 1
        }
      }).catch(() => {});

      const row = await prisma.outboundMessage.findUnique({ where: { id: job.data.outboundMessageId } });
      if (!row) {
        await logger.warn(`Outbound message ${job.data.outboundMessageId} not found`).catch(() => {});
        return;
      }

      // Update status to PROCESSING to indicate we're working on it
      await prisma.outboundMessage.update({
        where: { id: row.id },
        data: { status: 'PROCESSING' }
      }).catch(() => {});

      await logger.info('Outbound message status updated to PROCESSING', undefined, {
        tenantId: row.tenantId,
        deviceId: row.deviceId,
        metadata: { 
          outboundMessageId: row.id,
          to: row.to,
          queuedAt: row.createdAt.toISOString()
        }
      }).catch(() => {});

      // Check device status in DB
      const device = await prisma.device.findUnique({ where: { id: row.deviceId } }).catch(() => null);
      if (!device) {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'device_not_found' }
        }).catch(() => {});
        await logger.warn('Device not found for outbound message', undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id }
        }).catch(() => {});
        return;
      }

      if (device.status !== 'ONLINE') {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: `device_not_online:${device.status}` }
        }).catch(() => {});
        await logger.warn('Device not online for outbound message', undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id, deviceStatus: device.status }
        }).catch(() => {});
        return;
      }

      const sock = sessionManager.get(row.deviceId);
      if (!sock) {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'device_not_connected' }
        }).catch(() => {});
        await logger.warn('Device socket not available for outbound message', undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { 
            outboundMessageId: row.id,
            deviceStatus: device.status,
            note: 'Device marked as ONLINE but socket not found in sessionManager'
          }
        }).catch(() => {});
        return;
      }

      // Verify socket has user (means it's authenticated)
      if (!sock.user?.id) {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'socket_not_authenticated' }
        }).catch(() => {});
        await logger.warn('Socket not authenticated for outbound message', undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id }
        }).catch(() => {});
        return;
      }

      if (row.type !== 'text') {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: `unsupported_type:${row.type}` }
        });
        await logger.warn(`Unsupported message type: ${row.type}`, undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id, type: row.type }
        }).catch(() => {});
        return;
      }

      const payload = row.payloadJson as any;
      const text = payload?.text;
      if (!text || typeof text !== 'string') {
        const error = new Error('payload.text required');
        await logger.error('Invalid outbound message payload', error, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id }
        }).catch(() => {});
        throw error;
      }

      const to = row.to; // expects jid or phone@s.whatsapp.net depending on caller
      const queuedAt = row.createdAt.getTime();
      const processingDelay = Date.now() - queuedAt;

      // Log if message was queued for too long (potential cause of WhatsApp "waiting" message)
      if (processingDelay > 30000) {
        await logger.warn('Outbound message delayed in queue', undefined, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { 
            outboundMessageId: row.id, 
            to,
            queuedAt: new Date(queuedAt).toISOString(),
            processingDelayMs: processingDelay
          }
        }).catch(() => {});
      }

      try {
        const sendStartTime = Date.now();
        const sent = await sock.sendMessage(to, { text });
        const sendDuration = Date.now() - sendStartTime;
        const providerMessageId = sent?.key?.id ?? null;

        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'SENT', providerMessageId, error: null }
        });

        // Log slow sends
        if (sendDuration > 5000) {
          await logger.warn('Slow outbound message send', undefined, {
            tenantId: row.tenantId,
            deviceId: row.deviceId,
            metadata: { 
              outboundMessageId: row.id, 
              to,
              sendDurationMs: sendDuration,
              totalDelayMs: processingDelay + sendDuration
            }
          }).catch(() => {});
        }
      } catch (err: any) {
        await logger.error('Failed to send outbound message', err, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { 
            outboundMessageId: row.id, 
            to,
            processingDelayMs: processingDelay,
            error: err?.message
          }
        }).catch(() => {});
        throw err;
      }
    },
    { connection: redis, concurrency: 5 }
  );

  worker.on('completed', async (job) => {
    await logger.info('Outbound message job completed', undefined, {
      metadata: { 
        jobId: job.id,
        outboundMessageId: (job.data as any).outboundMessageId
      }
    }).catch(() => {});
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      await prisma.outboundMessage.update({
        where: { id: (job.data as any).outboundMessageId },
        data: { status: 'FAILED', error: err?.message ?? 'failed' }
      });
      await logger.error(
        `Outbound message job failed (outboundMessageId: ${(job.data as any).outboundMessageId})`,
        err,
        {
          metadata: {
            jobId: job.id,
            attempts: job.attemptsMade,
            willRetry: job.attemptsMade < (job.opts?.attempts ?? 0)
          }
        }
      ).catch(() => {});
    } catch (updateErr) {
      const error = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
      await logger.error('Failed to update outbound message status', error).catch(() => {});
    }
  });

  worker.on('error', async (err) => {
    await logger.error('Outbound messages worker error', err).catch(() => {});
  });

  worker.on('stalled', async (jobId) => {
    await logger.warn('Outbound message job stalled', undefined, {
      metadata: { jobId }
    }).catch(() => {});
  });

  logger.info('[worker] outbound_messages worker started', undefined, {
    metadata: { concurrency: 5 }
  }).catch(() => {});
  return worker;
}
