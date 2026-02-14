import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket, proto } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { loadAuthState, clearSessionsForJids } from './authStateDb.js';
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
    let clearCorruptedSessions: () => Promise<void>;

    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'OFFLINE', lastError: null }
      });

      const authState = await loadAuthState(deviceId);
      save = authState.save;
      clearCorruptedSessions = authState.clearCorruptedSessions;

      // Implement getMessage to help Baileys recover from sync errors
      // This function allows Baileys to retrieve previous messages when validating message sequence
      const getMessage = async (key: proto.IMessageKey): Promise<proto.IMessage | undefined> => {
        try {
          if (!key.remoteJid || !key.id) return undefined;
          
          // Search for the message in our events table
          // We search both inbound and potentially outbound messages
          const events = await prisma.event.findMany({
            where: {
              deviceId,
              OR: [
                { type: 'message.inbound' },
                { type: 'message.outbound' } // In case we store outbound messages in the future
              ]
            },
            orderBy: { createdAt: 'desc' },
            take: 500 // Search in recent messages
          });

          // Find the exact message by key
          for (const event of events) {
            if (event.rawJson) {
              const raw = event.rawJson as any;
              const msgKey = raw.key;
              if (msgKey?.id === key.id && 
                  msgKey?.remoteJid === key.remoteJid &&
                  (key.fromMe === undefined || msgKey?.fromMe === key.fromMe)) {
                // Return the message part, not the full WebMessageInfo
                return raw.message as proto.IMessage;
              }
            }
          }
          
          return undefined;
        } catch (err) {
          // If getMessage fails, return undefined - Baileys will handle it
          // Log but don't throw - this is a best-effort function
          logger.warn('getMessage error', err instanceof Error ? err : new Error(String(err)), {
            deviceId,
            metadata: { messageId: key.id, remoteJid: key.remoteJid }
          }).catch(() => {});
          return undefined;
        }
      };

      const version = await this.getVersion();
      sock = makeWASocket({
        auth: authState.state,
        printQRInTerminal: false,
        getMessage,
        // Mark messages as read automatically to prevent sync issues
        markOnlineOnConnect: true,
        // Increase sync timeout to handle slow connections
        syncFullHistory: false,
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
        // Save immediately on creds update (critical)
        if ((save as any).immediate) {
          await (save as any).immediate();
        } else {
          await save();
        }
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
          await logger.warn(`Device connection closed: ${errorMessage}`, '', {
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

    // Helper function to handle session sync errors
    const handleSessionSyncError = async (err: any) => {
      const errorMessage = err?.message ?? String(err);
      const isSessionError = errorMessage.includes('Over 2000 messages into the future') || 
                            errorMessage.includes('SessionError') ||
                            errorMessage.includes('No matching sessions') ||
                            errorMessage.includes('message counter') ||
                            errorMessage.includes('Failed to decrypt message');
      
      if (isSessionError) {
        const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
        await logger.error('Session synchronization error detected - clearing corrupted sessions and reconnecting', err, {
          deviceId,
          tenantId: device?.tenantId,
          metadata: { errorMessage, willReconnect: true, clearingSessions: true }
        }).catch(() => {});
        
        // Clear corrupted session keys before reconnecting
        try {
          await clearCorruptedSessions();
          await logger.info('Cleared corrupted session keys', {
            deviceId,
            tenantId: device?.tenantId
          }).catch(() => {});
        } catch (clearErr) {
          const error = clearErr instanceof Error ? clearErr : new Error(String(clearErr));
          await logger.error('Failed to clear corrupted sessions', error, {
            deviceId,
            tenantId: device?.tenantId
          }).catch(() => {});
        }
        
        // Update device status
        await prisma.device.update({
          where: { id: deviceId },
          data: { 
            status: 'OFFLINE',
            lastError: `session_sync_error: ${errorMessage.substring(0, 100)}`
          }
        }).catch(() => {});
        
        // Disconnect and reconnect to reset session state
        const current = this.sessions.get(deviceId);
        if (current && !current.closing) {
          current.closing = true;
          this.sessions.delete(deviceId);
          try {
            sock.end(new Error('session_sync_error'));
          } catch {
            // Ignore errors during disconnect
          }
          // Reconnect after a short delay to allow state to be cleared
          setTimeout(() => void this.connect(deviceId), 5000);
        }
        return true; // Error was handled
      }
      return false; // Error was not a session sync error
    };

    sock.ev.on('messages.upsert', async (m: any) => {
      try {
        const upsertResult = await handleMessagesUpsert({ deviceId, sock, messages: m.messages ?? [] });
        // Save state after processing messages to persist session key updates
        await save().catch(() => {
          // Ignore save errors - non-critical
        });
        // If we received a stub "No matching sessions" for a sender, clear that sender's keys and reconnect
        if (upsertResult?.clearSenderAndReconnect) {
          const { remoteJid, senderPn } = upsertResult.clearSenderAndReconnect;
          const jids = [remoteJid, senderPn].filter(Boolean) as string[];
          try {
            await clearSessionsForJids(deviceId, jids);
            await logger.info('Cleared session keys for sender, reconnecting', {
              deviceId,
              metadata: { remoteJid, senderPn, jids }
            }).catch(() => {});
          } catch (clearErr) {
            await logger.error('Failed to clear sender sessions', clearErr instanceof Error ? clearErr : new Error(String(clearErr)), {
              deviceId,
              metadata: { remoteJid, senderPn }
            }).catch(() => {});
          }
          const current = this.sessions.get(deviceId);
          if (current && !current.closing) {
            current.closing = true;
            this.sessions.delete(deviceId);
            try {
              sock.end(new Error('no_matching_sessions_reconnect'));
            } catch {
              // Ignore errors during disconnect
            }
            setTimeout(() => void this.connect(deviceId), 5000);
          }
        }
      } catch (e: any) {
        // Try to handle session sync errors
        const handled = await handleSessionSyncError(e);
        if (!handled) {
          // Other errors - log but continue
          const errorMessage = e?.message ?? String(e);
          await prisma.device.update({
            where: { id: deviceId },
            data: { lastError: `messages.upsert: ${errorMessage.substring(0, 100)}` }
          }).catch(() => {});
          const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
          await logger.error('Failed to handle messages.upsert', e, {
            deviceId,
            tenantId: device?.tenantId,
            metadata: { messageCount: m.messages?.length ?? 0 }
          }).catch(() => {});
        }
      }
    });

    // Set up periodic state saving to ensure session keys are persisted
    const saveInterval = setInterval(async () => {
      try {
        await save();
      } catch (err) {
        // Ignore periodic save errors
      }
    }, 30000); // Save every 30 seconds

    // Clean up interval when session closes
    sock.ev.on('connection.update', async (update: any) => {
      if (update.connection === 'close') {
        clearInterval(saveInterval);
      }
    });

    // Note: Baileys errors like "Over 2000 messages into the future" typically
    // occur during message processing and will be caught in the messages.upsert handler
    // or cause a connection.close event. We handle both cases above.
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

