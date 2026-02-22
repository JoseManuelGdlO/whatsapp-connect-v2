import { BufferJSON } from '@whiskeysockets/baileys';
import type { proto, WASocket } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { normalizeInboundMessage } from './normalize.js';
import { createLogger } from '@wc/logger';

const webhookQueue = new Queue('webhook_dispatch', { connection: redis });
const outboundQueue = new Queue('outbound_messages', { connection: redis });
const logger = createLogger(prisma, 'worker');

function toJid(to: string): string {
  if (!to) return to;
  if (to.includes('@')) return to;
  return `${to.replace(/\D/g, '')}@s.whatsapp.net`;
}

export type MessagesUpsertResult = {
  clearSenderAndReconnect?: { remoteJid: string; senderPn?: string };
};

/**
 * Procesa mensajes entrantes (messages.upsert de Baileys).
 * Filtra fromMe y status; envía composing y readMessages; normaliza; crea Event (message.inbound);
 * por cada WebhookEndpoint del tenant crea WebhookDelivery y encola job webhook_dispatch.
 * Si el mensaje es stub por fallo de descifrado, puede crear evento de decryptionFailed y devolver
 * clearSenderAndReconnect para que el sessionManager limpie sesiones del remitente.
 * @see docs/FLUJOS.md (mensaje entrante)
 * @see docs/DIAGNOSTICO.md
 */
export async function handleMessagesUpsert(params: {
  deviceId: string;
  sock: WASocket;
  messages: proto.IWebMessageInfo[];
}): Promise<MessagesUpsertResult | void> {
  const device = await prisma.device.findUnique({ where: { id: params.deviceId } });
  if (!device) return;

  let result: MessagesUpsertResult | void = undefined;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { tenantId: device.tenantId, enabled: true }
  });

  for (const msg of params.messages) {
    const key = msg.key;
    if (!key?.remoteJid) continue;
    if (key.fromMe) continue; // inbound only for now
    // No procesar Status (historias); el bot no debe responder ahí
    if (key.remoteJid === 'status@broadcast') continue;

    console.log('[paso-1] Mensaje recibido', { messageId: key.id, remoteJid: key.remoteJid, deviceId: params.deviceId });
    const messageReceivedAt = Date.now();
    const messageTimestamp = typeof msg.messageTimestamp === 'number' 
      ? msg.messageTimestamp * 1000 
      : (msg.messageTimestamp as any)?.toNumber?.() ? (msg.messageTimestamp as any).toNumber() * 1000 
      : messageReceivedAt;

    // Send "typing" presence FIRST so user sees "escribiendo..." immediately (reduces "Esperando el mensaje")
    const remoteJid = key.remoteJid;
    params.sock.sendPresenceUpdate('composing', remoteJid).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to send composing presence on inbound', errorMsg, {
        deviceId: params.deviceId,
        tenantId: device.tenantId,
        metadata: { messageId: key.id, remoteJid, error: errorMsg }
      }).catch(() => {});
    });
    // Clear "typing" after a while if the bot never replies (avoid leaving "escribiendo..." forever)
    const INBOUND_COMPOSING_PAUSE_AFTER_MS = 25_000;
    setTimeout(() => {
      params.sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }, INBOUND_COMPOSING_PAUSE_AFTER_MS);

    // Then acknowledge message (mark as read) so WhatsApp knows we received it
    try {
      await params.sock.readMessages([key]).catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to acknowledge incoming message', errorMsg, {
          deviceId: params.deviceId,
          tenantId: device.tenantId,
          metadata: { messageId: key.id, remoteJid: key.remoteJid, error: errorMsg }
        }).catch(() => {});
      });
    } catch (err) {
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
    if (normalized.content.type !== 'stub') {
      console.log('[paso-2] Mensaje válido (no stub)', { messageId: key.id, remoteJid: key.remoteJid, contentType: normalized.content.type });
    }
    if (normalized.content.type === 'stub') {
      const stubText = normalized.content.text ?? '';
      const isDecryptionFailure =
        /no matching sessions found for message/i.test(stubText) ||
        /bad mac/i.test(stubText) ||
        /failed to decrypt message/i.test(stubText);

      if (isDecryptionFailure && key.remoteJid) {
        const keyAny = key as { senderPn?: string };
        result = {
          clearSenderAndReconnect: {
            remoteJid: key.remoteJid,
            senderPn: keyAny.senderPn
          }
        };
        await logger.warn('Stub: Decryption failed (no matching sessions / Bad MAC) - clearing sender session', '', {
          deviceId: params.deviceId,
          tenantId: device.tenantId,
          metadata: { remoteJid: key.remoteJid, senderPn: keyAny.senderPn }
        }).catch(() => {});

        // Notificar al bot para que pueda responder "no pude leer, reenvía" (evita chat en silencio)
        const decryptionFailedPayload = {
          ...normalized,
          decryptionFailed: true,
          from: normalized.from || key.remoteJid
        };
        const rawJsonStub = JSON.parse(JSON.stringify(msg, BufferJSON.replacer));
        const eventStub = await prisma.event.create({
          data: {
            tenantId: device.tenantId,
            deviceId: device.id,
            type: 'message.inbound',
            normalizedJson: decryptionFailedPayload as any,
            rawJson: rawJsonStub as any
          }
        });
        for (const endpoint of endpoints) {
          const delivery = await prisma.webhookDelivery.create({
            data: { endpointId: endpoint.id, eventId: eventStub.id }
          });
          await webhookQueue.add(
            'deliver',
            { deliveryId: delivery.id },
            { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true }
          );
        }
        console.log('[paso-2] STUB decryption failed - webhook enviado para respuesta de fallback', {
          messageId: key.id,
          remoteJid: key.remoteJid,
          eventId: eventStub.id
        });
      } else {
        console.log('[paso-2] STUB_SKIP (mensaje no descifrado/stub)', {
          messageId: key.id,
          remoteJid: key.remoteJid,
          contentType: normalized.content.type
        });
      }

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
    console.log('[paso-3] Evento creado', { eventId: event.id, messageId: key.id, remoteJid: key.remoteJid });

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
      console.log('[paso-4] Webhook encolado', { deliveryId: delivery.id, endpointId: endpoint.id, eventId: event.id, url: endpoint.url });
    }
    if (endpoints.length === 0) {
      console.log('[paso-4] Sin endpoints de webhook', { eventId: event.id, tenantId: device.tenantId });
    }

    // Optional: send an immediate ack message to "reset" the conversation so WhatsApp stops showing "Esperando el mensaje"
    const ackText = process.env.WORKER_INBOUND_ACK_MESSAGE?.trim();
    if (ackText && normalized.from) {
      try {
        const to = toJid(normalized.from);
        const ackRow = await prisma.outboundMessage.create({
          data: {
            tenantId: device.tenantId,
            deviceId: device.id,
            to,
            type: 'text',
            payloadJson: { text: ackText },
            isTest: false
          }
        });
        await outboundQueue.add(
          'send',
          { outboundMessageId: ackRow.id },
          { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true }
        );
        console.log('[paso-4-ack] Acuse encolado para resetear conversación', { outboundMessageId: ackRow.id, to });
      } catch (ackErr) {
        const errMsg = ackErr instanceof Error ? ackErr.message : String(ackErr);
        logger.warn('Failed to enqueue inbound ack message', errMsg, {
          deviceId: params.deviceId,
          tenantId: device.tenantId,
          metadata: { messageId: key.id, remoteJid: key.remoteJid, error: errMsg }
        }).catch(() => {});
      }
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

  return result;
}

