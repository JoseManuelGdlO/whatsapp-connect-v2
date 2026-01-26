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
  healthCheckInterval?: NodeJS.Timeout;
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
      
      // getMessage is required by Baileys to retrieve messages by key
      // This is used for decrypting messages and handling poll votes
      const getMessage = async (key: any) => {
        try {
          // Search for the message in stored events
          const events = await prisma.event.findMany({
            where: {
              deviceId,
              type: 'message.inbound',
              // Search in rawJson for the message key
            },
            orderBy: { createdAt: 'desc' },
            take: 100 // Limit search to recent messages
          });

          // Try to find the message by matching key.id and key.remoteJid
          for (const event of events) {
            const raw = event.rawJson as any;
            if (raw?.key?.id === key.id && raw?.key?.remoteJid === key.remoteJid) {
              return raw;
            }
          }
          return undefined;
        } catch (err) {
          await logger.warn('Error in getMessage', undefined, {
            deviceId,
            metadata: { error: err instanceof Error ? err.message : String(err) }
          }).catch(() => {});
          return undefined;
        }
      };

      sock = makeWASocket({
        auth: authState.state,
        printQRInTerminal: false,
        getMessage,
        markOnlineOnConnect: true, // Ensure we're marked as online to receive messages
        syncFullHistory: false, // Don't sync full history, just new messages
        ...(version ? { version } : {})
      });

      // Log immediately that socket was created
      await logger.info('Socket created for device', {
        deviceId,
        metadata: { 
          hasAuth: !!authState.state,
          hasVersion: !!version,
          socketCreated: true
        }
      }).catch(() => {});

      const entry: SessionEntry = { 
        socket: sock, 
        deviceId, 
        closing: false 
      };
      this.sessions.set(deviceId, entry);
      
      // Log that listeners will be registered
      await logger.info('Registering event listeners for device', {
        deviceId,
        metadata: { listeners: ['connection.update', 'creds.update', 'messages.upsert', 'messages.update'] }
      }).catch(() => {});
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
          
          // Log that connection is open and socket is ready to receive messages
          await logger.info('Socket connection opened - ready to receive messages', {
            deviceId,
            metadata: { 
              userJid: sock.user?.id,
              socketReady: true,
              hasListeners: true,
              hasUser: !!sock.user
            }
          }).catch(() => {});
          
          // Test: Try to send a presence update to verify socket is working
          try {
            // This is just to verify the socket can send commands
            // We don't need to await it
            sock.readMessages([]).catch(() => {});
          } catch (err) {
            await logger.warn('Error testing socket after connection', undefined, {
              deviceId,
              metadata: { error: err instanceof Error ? err.message : String(err) }
            }).catch(() => {});
          }
          
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

    // Log that we're registering the messages.upsert listener
    await logger.info('Registering messages.upsert listener', {
      deviceId,
      metadata: { 
        listenerRegistered: true,
        socketHasEv: !!sock.ev,
        socketHasOn: typeof sock.ev.on === 'function'
      }
    }).catch(() => {});

    // CRITICAL: Register the listener BEFORE connection is fully open
    // Listen for all message events for debugging
    const messagesUpsertHandler = async (m: any) => {
      const messageCount = m.messages?.length ?? 0;
      const eventType = m.type;
      
      await logger.info('messages.upsert event fired', {
        deviceId,
        metadata: { 
          messageCount,
          type: eventType,
          hasMessages: !!m.messages
        }
      }).catch(() => {});

      // Only process 'notify' type messages (new messages)
      // 'append' type messages are historical and should be ignored
      if (eventType !== 'notify') {
        await logger.debug('Skipping messages.upsert: not notify type', {
          deviceId,
          metadata: { type: eventType, messageCount }
        }).catch(() => {});
        return;
      }

      // Ensure we have messages to process
      if (!m.messages || m.messages.length === 0) {
        await logger.debug('messages.upsert has no messages array', {
          deviceId,
          metadata: { type: eventType }
        }).catch(() => {});
        return;
      }

      // Filter out messages that can't be decrypted or are from us
      const processableMessages: any[] = [];
      
      for (const msg of m.messages) {
        // Skip if message has no key
        if (!msg.key) {
          await logger.debug('Skipping message: no key', {
            deviceId,
            metadata: { message: JSON.stringify(msg).substring(0, 200) }
          }).catch(() => {});
          continue;
        }
        
        // Skip if fromMe (outbound messages)
        if (msg.key.fromMe) {
          await logger.debug('Skipping message: fromMe=true', {
            deviceId,
            metadata: { messageId: msg.key.id, remoteJid: msg.key.remoteJid }
          }).catch(() => {});
          continue;
        }
        
        // Skip if message has no content (couldn't be decrypted)
        if (!msg.message) {
          await logger.debug('Skipping message: no content (decryption failed or old message)', {
            deviceId,
            metadata: { 
              messageId: msg.key.id, 
              remoteJid: msg.key.remoteJid,
              pushName: msg.pushName,
              messageTimestamp: msg.messageTimestamp
            }
          }).catch(() => {});
          continue;
        }
        
        // This is a processable message
        processableMessages.push(msg);
      }

      if (processableMessages.length === 0) {
        await logger.debug('No processable messages after filtering', {
          deviceId,
          metadata: { 
            totalMessages: m.messages.length,
            filteredOut: m.messages.length
          }
        }).catch(() => {});
        return;
      }

      await logger.info('Processing processable messages', {
        deviceId,
        metadata: { 
          totalMessages: m.messages.length,
          processableMessages: processableMessages.length
        }
      }).catch(() => {});

      try {
        await handleMessagesUpsert({ deviceId, sock, messages: processableMessages });
      } catch (e: any) {
        await prisma.device.update({
          where: { id: deviceId },
          data: { lastError: `messages.upsert: ${e?.message ?? 'unknown'}` }
        });
        const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
        await logger.error('Failed to handle messages.upsert', e, {
          deviceId,
          tenantId: device?.tenantId,
          metadata: { messageCount, error: e?.message, stack: e?.stack }
        }).catch(() => {});
      }
    };
    
    // Register the handler
    sock.ev.on('messages.upsert', messagesUpsertHandler);
    
    // Log that handler was registered
    await logger.info('messages.upsert handler registered successfully', {
      deviceId,
      metadata: { handlerRegistered: true }
    }).catch(() => {});

    // Also listen for messages.update to catch status updates (optional, for debugging)
    sock.ev.on('messages.update', async (updates: any[]) => {
      await logger.info('messages.update event fired', {
        deviceId,
        metadata: { updateCount: updates?.length ?? 0 }
      }).catch(() => {});
    });

    // Listen to ALL possible events to see what's actually firing
    sock.ev.on('messaging-history.set', async (data: any) => {
      await logger.info('messaging-history.set event fired', {
        deviceId,
        metadata: { hasData: !!data }
      }).catch(() => {});
    });

    sock.ev.on('chats.update', async (chats: any[]) => {
      await logger.debug('chats.update event fired', {
        deviceId,
        metadata: { chatCount: chats?.length ?? 0 }
      }).catch(() => {});
    });

    sock.ev.on('chats.upsert', async (chats: any[]) => {
      await logger.debug('chats.upsert event fired', {
        deviceId,
        metadata: { chatCount: chats?.length ?? 0 }
      }).catch(() => {});
    });

    sock.ev.on('presence.update', async (data: any) => {
      await logger.debug('presence.update event fired', {
        deviceId,
        metadata: { hasData: !!data }
      }).catch(() => {});
    });

    sock.ev.on('contacts.update', async (contacts: any[]) => {
      await logger.debug('contacts.update event fired', {
        deviceId,
        metadata: { contactCount: contacts?.length ?? 0 }
      }).catch(() => {});
    });

    // Set up a periodic check to verify socket is still active and receiving events
    const currentEntry = this.sessions.get(deviceId);
    if (currentEntry) {
      currentEntry.healthCheckInterval = setInterval(async () => {
        const entry = this.sessions.get(deviceId);
        if (!entry || entry.closing) {
          if (currentEntry.healthCheckInterval) {
            clearInterval(currentEntry.healthCheckInterval);
          }
          return;
        }

        try {
          const isOnline = !!sock.user; // If we have a user, socket is connected
          await logger.debug('Socket health check', {
            deviceId,
            metadata: {
              isOnline,
              hasUser: !!sock.user,
              userJid: sock.user?.id
            }
          }).catch(() => {});
        } catch (err) {
          // Ignore health check errors
        }
      }, 60000); // Check every 60 seconds
    }
  }

  async disconnect(deviceId: string) {
    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    entry.closing = true;
    
    // Clear health check interval if it exists
    if (entry.healthCheckInterval) {
      clearInterval(entry.healthCheckInterval);
    }
    
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

