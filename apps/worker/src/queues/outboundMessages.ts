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
      const row = await prisma.outboundMessage.findUnique({ where: { id: job.data.outboundMessageId } });
      if (!row) {
        await logger.warn(`Outbound message ${job.data.outboundMessageId} not found`).catch(() => {});
        return;
      }

      const sock = sessionManager.get(row.deviceId);
      if (!sock) {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'device_not_connected' }
        });
        await logger.warn('Device not connected for outbound message', undefined, {
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

      try {
        const sent = await sock.sendMessage(to, { text });
        const providerMessageId = sent?.key?.id ?? null;

        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'SENT', providerMessageId, error: null }
        });
      } catch (err: any) {
        await logger.error('Failed to send outbound message', err, {
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          metadata: { outboundMessageId: row.id, to }
        }).catch(() => {});
        throw err;
      }
    },
    { connection: redis, concurrency: 5 }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      await prisma.outboundMessage.update({
        where: { id: (job.data as any).outboundMessageId },
        data: { status: 'FAILED', error: err?.message ?? 'failed' }
      });
      await logger.error(
        `Outbound message job failed (outboundMessageId: ${(job.data as any).outboundMessageId})`,
        err
      ).catch(() => {});
    } catch (updateErr) {
      const error = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
      await logger.error('Failed to update outbound message status', error).catch(() => {});
    }
  });

  logger.info('[worker] outbound_messages worker started').catch(() => {});
  return worker;
}
