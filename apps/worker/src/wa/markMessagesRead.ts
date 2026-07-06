import type { proto, WASocket } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { createLogger } from '@wc/logger';

const logger = createLogger(prisma, 'worker');

export async function markMessagesRead(
  sock: WASocket,
  keys: proto.IMessageKey[],
  ctx: { deviceId: string; tenantId?: string; source: 'inbound' | 'outbound' }
): Promise<void> {
  if (keys.length === 0) return;

  try {
    await sock.readMessages(keys).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const message =
        ctx.source === 'inbound'
          ? 'Failed to acknowledge incoming message'
          : 'Failed to mark messages read on outbound';
      logger.warn(message, errorMsg, {
        deviceId: ctx.deviceId,
        tenantId: ctx.tenantId,
        metadata: { keyCount: keys.length, source: ctx.source, error: errorMsg }
      }).catch(() => {});
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Exception while marking messages read', errorMsg, {
      deviceId: ctx.deviceId,
      tenantId: ctx.tenantId,
      metadata: { source: ctx.source, error: errorMsg }
    }).catch(() => {});
  }
}
