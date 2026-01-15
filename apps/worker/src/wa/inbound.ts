import { BufferJSON } from '@whiskeysockets/baileys';
import type { proto, WASocket } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { normalizeInboundMessage } from './normalize.js';

const webhookQueue = new Queue('webhook_dispatch', { connection: redis });

export async function handleMessagesUpsert(params: {
  deviceId: string;
  sock: WASocket;
  messages: proto.IWebMessageInfo[];
}) {
  const device = await prisma.device.findUnique({ where: { id: params.deviceId } });
  if (!device) return;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { tenantId: device.tenantId, enabled: true }
  });

  for (const msg of params.messages) {
    const key = msg.key;
    if (!key?.remoteJid) continue;
    if (key.fromMe) continue; // inbound only for now

    const normalized = normalizeInboundMessage({
      message: msg,
      deviceJid: params.sock.user?.id ?? null
    });

    // Persist raw as JSON-friendly structure
    const rawJson = JSON.parse(JSON.stringify(msg, BufferJSON.replacer));

    const event = await prisma.event.create({
      data: {
        tenantId: device.tenantId,
        deviceId: device.id,
        type: 'message.inbound',
        normalizedJson: normalized as any,
        rawJson: rawJson as any
      }
    });

    // fan-out to all enabled endpoints for this tenant
    for (const endpoint of endpoints) {
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventId: event.id
        }
      });
      await webhookQueue.add(
        'deliver',
        { deliveryId: delivery.id },
        { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true }
      );
    }

    await prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() }
    });
  }
}

