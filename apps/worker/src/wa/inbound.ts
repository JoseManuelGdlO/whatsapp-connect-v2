import { BufferJSON } from '@whiskeysockets/baileys';
import type { proto, WASocket } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { normalizeInboundMessage } from './normalize.js';
import { createLogger } from '@wc/logger';

const webhookQueue = new Queue('webhook_dispatch', { connection: redis });
const logger = createLogger(prisma, 'worker');

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

    const messageReceivedAt = Date.now();
    const messageTimestamp = typeof msg.messageTimestamp === 'number' 
      ? msg.messageTimestamp * 1000 
      : (msg.messageTimestamp as any)?.toNumber?.() ? (msg.messageTimestamp as any).toNumber() * 1000 
      : messageReceivedAt;

    // Acknowledge message immediately to prevent WhatsApp "waiting" message
    // This tells WhatsApp we received the message and are processing it
    // This is critical - without this, WhatsApp will send the automatic "waiting" message after a few minutes
    try {
      await params.sock.readMessages([key]).catch((err) => {
        // Log but don't fail - acknowledgment is best effort
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to acknowledge incoming message', errorMsg, {
          deviceId: params.deviceId,
          tenantId: device.tenantId,
          metadata: { messageId: key.id, remoteJid: key.remoteJid, error: errorMsg }
        }).catch(() => {});
      });
    } catch (err) {
      // Ignore acknowledgment errors - continue processing
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Exception while acknowledging message', errorMsg, {
        deviceId: params.deviceId,
        tenantId: device.tenantId,
        metadata: { messageId: key.id, error: errorMsg }
      }).catch(() => {});
    }

    const normalized = normalizeInboundMessage({
      message: msg,
      deviceJid: params.sock.user?.id ?? null
    });

    // Log para inspección: mensaje entrante y lo que se extrajo (depurar texto null)
    const rawForLog = JSON.parse(JSON.stringify(msg, BufferJSON.replacer));
    const messageKeys = rawForLog.message ? Object.keys(rawForLog.message) : [];
    const inspectPayload = {
      messageId: key?.id,
      remoteJid: key?.remoteJid,
      normalized: {
        contentType: normalized.content.type,
        text: normalized.content.text,
        hasMedia: !!normalized.content.media
      },
      rawTopLevelKeys: Object.keys(rawForLog),
      rawMessageKeys: messageKeys,
      rawMessageSample: (() => {
        const m = rawForLog.message;
        if (!m) return null;
        const out: Record<string, unknown> = {};
        for (const k of messageKeys) {
          const v = m[k];
          if (k === 'conversation' || k === 'extendedTextMessage') {
            out[k] = v;
            continue;
          }
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (k === 'extendedTextMessage' && v && typeof v === 'object') out[k] = v;
            else out[k] = '<object>';
          } else {
            out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
          }
        }
        return out;
      })()
    };
    console.log('[inbound-inspect]', JSON.stringify(inspectPayload, null, 2));

    // No notificar a los bots mensajes stub (ej. "No session record") — no son mensajes de usuario
    if (normalized.content.type === 'stub') {
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() }
      });
      continue;
    }

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

    // Log processing time to help identify delays
    const processingTime = Date.now() - messageReceivedAt;
    if (processingTime > 1000) {
      logger.warn('Slow message processing detected', '', {
        deviceId: params.deviceId,
        tenantId: device.tenantId,
        metadata: { 
          messageId: key.id, 
          remoteJid: key.remoteJid,
          processingTimeMs: processingTime,
          messageAgeMs: messageReceivedAt - messageTimestamp
        }
      }).catch(() => {});
    }
  }
}

