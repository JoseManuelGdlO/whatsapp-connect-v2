import { Worker } from 'bullmq';

import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sessionManager } from './deviceCommands.js';

type OutboundJob = { outboundMessageId: string };

export function startOutboundMessagesWorker() {
  const worker = new Worker<OutboundJob>(
    'outbound_messages',
    async (job) => {
      const row = await prisma.outboundMessage.findUnique({ where: { id: job.data.outboundMessageId } });
      if (!row) return;

      const sock = sessionManager.get(row.deviceId);
      if (!sock) {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'device_not_connected' }
        });
        return;
      }

      if (row.type !== 'text') {
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: `unsupported_type:${row.type}` }
        });
        return;
      }

      const payload = row.payloadJson as any;
      const text = payload?.text;
      if (!text || typeof text !== 'string') throw new Error('payload.text required');

      const to = row.to; // expects jid or phone@s.whatsapp.net depending on caller

      const sent = await sock.sendMessage(to, { text });
      const providerMessageId = sent?.key?.id ?? null;

      await prisma.outboundMessage.update({
        where: { id: row.id },
        data: { status: 'SENT', providerMessageId, error: null }
      });
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
    } catch {
      // ignore
    }
  });

  // eslint-disable-next-line no-console
  console.log('[worker] outbound_messages worker started');
  return worker;
}

