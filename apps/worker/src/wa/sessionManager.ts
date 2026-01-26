import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { loadAuthState } from './authStateDb.js';
import { handleMessagesUpsert } from './inbound.js';
import { createLogger } from '@wc/logger';

const logger = createLogger(prisma, 'worker');

type SessionEntry = {
  socket: WASocket;
  deviceId: string;
  closing: boolean;
};

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private cachedVersion: [number, number, number] | null = null;

  private async getVersion(): Promise<[number, number, number] | undefined> {
    if (this.cachedVersion) return this.cachedVersion;
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.cachedVersion = version;
      return version;
    } catch {
      return undefined;
    }
  }

  async connect(deviceId: string) {
    if (this.sessions.has(deviceId)) return;

    let sock: WASocket;
    let save: () => Promise<void>;

    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'OFFLINE', lastError: null }
      });

      const authState = await loadAuthState(deviceId);
      save = authState.save;

      const version = await this.getVersion();
      sock = makeWASocket({
        auth: authState.state,
        printQRInTerminal: false,
        ...(version ? { version } : {})
      });

      const entry: SessionEntry = { socket: sock, deviceId, closing: false };
      this.sessions.set(deviceId, entry);
    } catch (err: any) {
      await prisma.device.update({
        where: { id: deviceId },
        data: {
          status: 'ERROR',
          lastError: `connect_error: ${err?.message ?? 'unknown'}`
        }
      });
      const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
      await logger.error('Failed to connect device', err, {
        deviceId,
        tenantId: device?.tenantId
      }).catch(() => {});
      throw err;
    }

    sock.ev.on('creds.update', async () => {
      try {
        await save();
      } catch (e: any) {
        await prisma.device.update({
          where: { id: deviceId },
          data: { lastError: `saveState: ${e?.message ?? 'unknown'}` }
        });
        await logger.error('Failed to save auth state', e, { deviceId }).catch(() => {});
      }
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      try {
        if (qr) {
          await prisma.device.update({
            where: { id: deviceId },
            data: { status: 'QR', qr, lastError: null }
          });
        }

        // Handle connecting state - update to show we're trying to connect
        if (connection === 'connecting') {
          await prisma.device.update({
            where: { id: deviceId },
            data: { status: 'OFFLINE', lastError: null }
          });
        }

        if (connection === 'open') {
          await prisma.device.update({
            where: { id: deviceId },
            data: { status: 'ONLINE', qr: null, lastSeenAt: new Date(), lastError: null }
          });
          
          // Expire all active public QR links for this device
          await prisma.publicQrLink.updateMany({
            where: {
              deviceId,
              expiresAt: { gt: new Date() } // Only update non-expired links
            },
            data: {
              expiresAt: new Date() // Expire immediately
            }
          }).catch(() => {
            // Ignore errors if table doesn't exist yet or other issues
          });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const reason = statusCode ? DisconnectReason[statusCode] : undefined;
          const errMsg = (lastDisconnect?.error as any)?.message as string | undefined;
          const errorMessage = reason ?? errMsg ?? 'connection_closed';

          await prisma.device.update({
            where: { id: deviceId },
            data: {
              status: 'OFFLINE',
              qr: null,
              lastError: errorMessage
            }
          });

          const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
          await logger.warn(`Device connection closed: ${errorMessage}`, undefined, {
            deviceId,
            tenantId: device?.tenantId,
            metadata: { statusCode, reason, willReconnect: statusCode !== DisconnectReason.loggedOut }
          }).catch(() => {});

          const current = this.sessions.get(deviceId);
          if (!current || current.closing) return;

          // Basic reconnect (unless logged out)
          if (statusCode !== DisconnectReason.loggedOut) {
            this.sessions.delete(deviceId);
            setTimeout(() => void this.connect(deviceId), 2000);
          } else {
            this.sessions.delete(deviceId);
          }
        }
      } catch (err: any) {
        await prisma.device.update({
          where: { id: deviceId },
          data: {
            status: 'ERROR',
            lastError: `connection.update_error: ${err?.message ?? 'unknown'}`
          }
        });
        const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
        await logger.error('Error in connection.update handler', err, {
          deviceId,
          tenantId: device?.tenantId
        }).catch(() => {});
      }
    });

    sock.ev.on('messages.upsert', async (m: any) => {
      try {
        await handleMessagesUpsert({ deviceId, sock, messages: m.messages ?? [] });
      } catch (e: any) {
        await prisma.device.update({
          where: { id: deviceId },
          data: { lastError: `messages.upsert: ${e?.message ?? 'unknown'}` }
        });
        const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
        await logger.error('Failed to handle messages.upsert', e, {
          deviceId,
          tenantId: device?.tenantId,
          metadata: { messageCount: m.messages?.length ?? 0 }
        }).catch(() => {});
      }
    });
  }

  async disconnect(deviceId: string) {
    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    entry.closing = true;
    try {
      entry.socket.end(new Error('disconnect'));
    } finally {
      this.sessions.delete(deviceId);
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'OFFLINE', qr: null }
      });
    }
  }

  get(deviceId: string) {
    return this.sessions.get(deviceId)?.socket ?? null;
  }
}

