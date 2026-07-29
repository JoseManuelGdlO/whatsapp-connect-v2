import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket, proto } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { loadAuthState, disposeAuthStateSaves, deletePersistedAuthState } from './authStateDb.js';
import { handleMessagesUpsert } from './inbound.js';
import { phoneDigitsFromPnJid } from './normalize.js';
import { sanitizePairingPhone } from './pairingPhone.js';
import { createLogger } from '@wc/logger';
import { sendDeviceDisconnectAlert } from '@wc/alert';

const logger = createLogger(prisma, 'worker');

/** Returns phoneHint to persist, or null if sock has no PN or value is unchanged. */
async function phoneHintIfChanged(
  deviceId: string,
  userJid: string | null | undefined
): Promise<string | null> {
  const nextHint = phoneDigitsFromPnJid(userJid ?? null);
  if (!nextHint) return null;
  const current = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { phoneHint: true }
  });
  if (current?.phoneHint === nextHint) return null;
  return nextHint;
}

type SessionEntry = {
  socket: WASocket;
  deviceId: string;
  closing: boolean;
};

/** Debounce clear+reconnect per device so we don't disconnect constantly (breaks replies for everyone). */
const CLEAR_RECONNECT_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes

/** Exponential backoff for reconnects: avoid reconnect storms when WhatsApp closes connections. */
const RECONNECT_INITIAL_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** Alert if device stays offline (reconnect loop) longer than this. Default 10 minutes. */
const DEFAULT_OFFLINE_ALERT_AFTER_MS = 10 * 60 * 1000;

function offlineAlertAfterMs(): number {
  const raw = Number(process.env.DEVICE_OFFLINE_ALERT_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLINE_ALERT_AFTER_MS;
}

type DisconnectInfo = {
  statusCode?: number;
  reason?: string;
  errMsg?: string;
};

function extractDisconnectInfo(lastDisconnect: any): DisconnectInfo {
  const err = lastDisconnect?.error as any;
  const rawStatusCode = err?.output?.statusCode ?? err?.statusCode ?? err?.data ?? err?.output?.payload?.statusCode;
  const statusCode = typeof rawStatusCode === 'number' && Number.isFinite(rawStatusCode) ? rawStatusCode : undefined;
  const reason = statusCode ? DisconnectReason[statusCode] : undefined;
  const errMsg = typeof err?.message === 'string' ? err.message : undefined;
  return { statusCode, reason, errMsg };
}

/**
 * Gestiona sesiones WhatsApp (Baileys) por deviceId.
 * connect/disconnect se invocan desde el worker de device_commands; el estado de auth se persiste
 * vía authStateDb (loadAuthState, cifrado con WA_AUTH_ENC_KEY_B64). Escucha messages.upsert
 * y delega en handleMessagesUpsert. Actualiza Device (status, qr, lastError) en BD.
 * @see apps/worker/src/wa/authStateDb.ts
 * @see docs/FLUJOS.md (ciclo de vida dispositivo)
 */
export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private cachedVersion: [number, number, number] | null = null;
  private lastClearReconnectAt = new Map<string, number>();
  /** Tracks reconnect attempts per device for exponential backoff. Reset when connection opens. */
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  /** One timer per device: fires if still OFFLINE after continuous reconnect streak. */
  private offlineAlertTimers = new Map<string, NodeJS.Timeout>();

  private clearReconnectTimer(deviceId: string): void {
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(deviceId);
    }
  }

  private clearOfflineUnrecoveredAlert(deviceId: string): void {
    const timer = this.offlineAlertTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.offlineAlertTimers.delete(deviceId);
    }
  }

  private armOfflineUnrecoveredAlert(deviceId: string): void {
    if (this.offlineAlertTimers.has(deviceId)) return;
    const afterMs = offlineAlertAfterMs();
    const timer = setTimeout(() => {
      this.offlineAlertTimers.delete(deviceId);
      void this.fireOfflineUnrecoveredAlert(deviceId, afterMs);
    }, afterMs);
    this.offlineAlertTimers.set(deviceId, timer);
  }

  private async fireOfflineUnrecoveredAlert(deviceId: string, afterMs: number): Promise<void> {
    try {
      const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
      if (!device || device.status === 'ONLINE') return;

      const minutes = Math.max(1, Math.round(afterMs / 60_000));
      const reason = `offline_unrecovered_after_${minutes}m`;
      await sendDeviceDisconnectAlert(deviceId, reason, {
        label: device.label ?? undefined,
        tenantId: device.tenantId ?? undefined,
        severity: 'error',
        logContext: { willReconnect: true }
      });
    } catch {
      // Alert failures must not affect reconnect loop
    }
  }

  private scheduleReconnect(deviceId: string, delayMs: number): void {
    this.clearReconnectTimer(deviceId);
    this.armOfflineUnrecoveredAlert(deviceId);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(deviceId);
      void this.connect(deviceId);
    }, delayMs);
    this.reconnectTimers.set(deviceId, timer);
  }

  private async persistDeviceOffline(deviceId: string): Promise<void> {
    await prisma.device.update({
      where: { id: deviceId },
      data: { status: 'OFFLINE', qr: null, pairingCode: null, lastError: null }
    });
  }

  private async purgePersistedAuthState(deviceId: string): Promise<void> {
    disposeAuthStateSaves(deviceId);
    await deletePersistedAuthState(deviceId);
  }

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

  /**
   * If a live socket is waiting for link (QR) and a phone arrives late, request pairing on it.
   * Returns true if handled without opening a new socket.
   */
  private async requestPairingOnExistingSession(
    deviceId: string,
    phoneNumber: string
  ): Promise<boolean> {
    const entry = this.sessions.get(deviceId);
    if (!entry || entry.closing) return false;

    const sock = entry.socket;
    if (sock.authState?.creds?.registered) return false;

    try {
      const code = await sock.requestPairingCode(phoneNumber);
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'QR', pairingCode: code, lastError: null }
      });
      await logger
        .info('Pairing code requested on existing session', {
          deviceId,
          metadata: { hasCode: Boolean(code) }
        })
        .catch(() => {});
      return true;
    } catch (pairingErr: any) {
      await prisma.device.update({
        where: { id: deviceId },
        data: { lastError: `pairing_code_error: ${pairingErr?.message ?? 'unknown'}` }
      });
      await logger
        .warn(
          'Failed to request pairing code on existing session',
          pairingErr instanceof Error ? pairingErr : new Error(String(pairingErr)),
          { deviceId }
        )
        .catch(() => {});
      return true; // handled (do not open a second socket)
    }
  }

  /** Inicia sesión Baileys para el dispositivo; persiste auth en BD; registra listeners (messages.upsert, connection.update, etc.). */
  async connect(deviceId: string, opts?: { phoneNumber?: string }) {
    const sanitizedPhone = opts?.phoneNumber ? sanitizePairingPhone(opts.phoneNumber) : null;

    // Second Connect with phone while QR is already showing: request code on live socket.
    if (this.sessions.has(deviceId)) {
      if (sanitizedPhone) {
        await this.requestPairingOnExistingSession(deviceId, sanitizedPhone);
      }
      return;
    }

    let pairingRequested = false;

    let sock: WASocket;
    let save: () => Promise<void>;
    let clearCorruptedSessions: () => Promise<void>;
    let clearSenderSessionsInMemory: (jid: string | null, from: string | null) => void;

    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'OFFLINE', lastError: null, qr: null, pairingCode: null }
      });

      // Pairing needs a fresh unregistered auth state. Stale registered creds cause
      // "logging in..." + stream conflict (replaced) and skip requestPairingCode.
      if (sanitizedPhone) {
        const existing = await prisma.waSession.findUnique({ where: { deviceId } });
        if (existing?.authStateEnc) {
          disposeAuthStateSaves(deviceId);
          await deletePersistedAuthState(deviceId);
          await logger
            .info('Cleared WaSession before pairing-code connect', { deviceId })
            .catch(() => {});
        }
      }

      const authState = await loadAuthState(deviceId);
      save = authState.save;
      clearCorruptedSessions = authState.clearCorruptedSessions;
      clearSenderSessionsInMemory = authState.clearSenderSessionsInMemory;

      // Implement getMessage to help Baileys recover from sync errors
      // This function allows Baileys to retrieve previous messages when validating message sequence
      const getMessage = async (key: proto.IMessageKey): Promise<proto.IMessage | undefined> => {
        try {
          const keyRemote = (key as { remoteJid?: string; remoteJidAlt?: string }).remoteJid ?? (key as { remoteJidAlt?: string }).remoteJidAlt;
          if (!key.id || !keyRemote) return undefined;

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

          const keyParticipant = (key as { participant?: string; participantAlt?: string }).participant ?? (key as { participantAlt?: string }).participantAlt;

          // Find the exact message by key (v7: match remoteJid/remoteJidAlt and participant/participantAlt)
          for (const event of events) {
            if (event.rawJson) {
              const raw = event.rawJson as any;
              const msgKey = raw.key as { id?: string; remoteJid?: string; remoteJidAlt?: string; participant?: string; participantAlt?: string; fromMe?: boolean } | undefined;
              if (!msgKey?.id || msgKey.id !== key.id) continue;
              if (key.fromMe !== undefined && msgKey.fromMe !== key.fromMe) continue;

              const keyRemotes = [key.remoteJid, (key as { remoteJidAlt?: string }).remoteJidAlt].filter((x): x is string => typeof x === 'string');
              const msgRemotes = [msgKey.remoteJid, msgKey.remoteJidAlt].filter((x): x is string => typeof x === 'string');
              const remoteMatch = keyRemotes.some((k) => msgRemotes.includes(k));
              if (!remoteMatch) continue;

              const keyParticipants = [key.participant, keyParticipant].filter((x): x is string => typeof x === 'string');
              const msgParticipants = [msgKey.participant, msgKey.participantAlt].filter((x): x is string => typeof x === 'string');
              const participantMatch = keyParticipants.length === 0
                ? msgParticipants.length === 0
                : keyParticipants.some((k) => msgParticipants.includes(k));
              if (!participantMatch) continue;

              return raw.message as proto.IMessage;
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
        markOnlineOnConnect: true,
        syncFullHistory: false,
        // Timeouts for slow/unstable connections (e.g. Docker, cloud)
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
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

        // Request pairing only after QR event (socket ready). Do not use `connecting`:
        // requesting too early fails and pairingRequested would block retries.
        const shouldRequestPairing =
          sanitizedPhone &&
          !sock.authState.creds.registered &&
          !pairingRequested &&
          Boolean(qr);

        if (shouldRequestPairing) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(sanitizedPhone);
            await prisma.device.update({
              where: { id: deviceId },
              data: { status: 'QR', pairingCode: code, lastError: null }
            });
          } catch (pairingErr: any) {
            pairingRequested = false; // allow retry on next QR refresh
            await prisma.device.update({
              where: { id: deviceId },
              data: {
                pairingCode: null,
                lastError: `pairing_code_error: ${pairingErr?.message ?? 'unknown'}`
              }
            });
            await logger.warn('Failed to request pairing code', pairingErr instanceof Error ? pairingErr : new Error(String(pairingErr)), {
              deviceId
            }).catch(() => {});
          }
        }

        // Handle connecting state - update to show we're trying to connect
        // Do not clobber QR status or pairing errors while waiting for link.
        if (connection === 'connecting') {
          const currentDevice = await prisma.device.findUnique({
            where: { id: deviceId },
            select: { status: true }
          });
          if (currentDevice?.status !== 'QR') {
            await prisma.device.update({
              where: { id: deviceId },
              data: { status: 'OFFLINE', lastError: null }
            });
          }
        }

        if (connection === 'open') {
          this.reconnectAttempts.set(deviceId, 0); // Reset backoff on successful connect
          this.clearOfflineUnrecoveredAlert(deviceId);
          const openData: {
            status: 'ONLINE';
            qr: null;
            pairingCode: null;
            lastSeenAt: Date;
            lastError: null;
            phoneHint?: string;
          } = {
            status: 'ONLINE',
            qr: null,
            pairingCode: null,
            lastSeenAt: new Date(),
            lastError: null
          };
          const phoneHint = await phoneHintIfChanged(deviceId, sock.user?.id);
          if (phoneHint) openData.phoneHint = phoneHint;
          await prisma.device.update({
            where: { id: deviceId },
            data: openData
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
          const { statusCode, reason, errMsg } = extractDisconnectInfo(lastDisconnect);
          const errorMessage = reason ?? errMsg ?? 'connection_closed';

          await prisma.device.update({
            where: { id: deviceId },
            data: {
              status: 'OFFLINE',
              qr: null,
              pairingCode: null,
              lastError: errorMessage
            }
          });

          const device = await prisma.device.findUnique({ where: { id: deviceId } }).catch(() => null);
          await logger.warn(`Device connection closed: ${errorMessage}`, '', {
            deviceId,
            tenantId: device?.tenantId,
            metadata: { statusCode, reason, willReconnect: statusCode !== DisconnectReason.loggedOut }
          }).catch(() => {});
          sendDeviceDisconnectAlert(deviceId, errorMessage, {
            label: device?.label ?? undefined,
            tenantId: device?.tenantId ?? undefined,
            severity: statusCode !== DisconnectReason.loggedOut ? 'info' : 'error',
            logContext: { statusCode, reason, willReconnect: statusCode !== DisconnectReason.loggedOut }
          }).catch(() => {});

          const current = this.sessions.get(deviceId);
          if (!current || current.closing) return;

          if (statusCode !== DisconnectReason.loggedOut) {
            const attempts = this.reconnectAttempts.get(deviceId) ?? 0;
            this.reconnectAttempts.set(deviceId, attempts + 1);
            this.sessions.delete(deviceId);
            const delay = Math.min(
              RECONNECT_INITIAL_DELAY_MS * Math.pow(2, attempts),
              RECONNECT_MAX_DELAY_MS
            );
            this.scheduleReconnect(deviceId, delay);
          } else {
            this.clearReconnectTimer(deviceId);
            this.clearOfflineUnrecoveredAlert(deviceId);
            this.reconnectAttempts.delete(deviceId);
            this.lastClearReconnectAt.delete(deviceId);
            current.closing = true;
            this.sessions.delete(deviceId);
            await this.purgePersistedAuthState(deviceId);
            await logger
              .info('WhatsApp session cleared after loggedOut from phone', { deviceId })
              .catch(() => {});
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
        const updateErrMsg = `connection.update_error: ${err?.message ?? 'unknown'}`;
        sendDeviceDisconnectAlert(deviceId, updateErrMsg, {
          label: device?.label ?? undefined,
          tenantId: device?.tenantId ?? undefined,
          severity: 'error'
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
                            errorMessage.includes('Failed to decrypt message') ||
                            errorMessage.includes('Invalid patch mac') ||
                            errorMessage.includes('Bad MAC');
      
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
        const lastErrorSessionSync = `session_sync_error: ${errorMessage.substring(0, 100)}`;
        await prisma.device.update({
          where: { id: deviceId },
          data: { 
            status: 'OFFLINE',
            lastError: lastErrorSessionSync
          }
        }).catch(() => {});
        sendDeviceDisconnectAlert(deviceId, lastErrorSessionSync, {
          label: device?.label ?? undefined,
          tenantId: device?.tenantId ?? undefined,
          severity: 'info',
          logContext: { willReconnect: true }
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
          this.scheduleReconnect(deviceId, 5000);
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
        // If we received a stub "No matching sessions", clear that sender's keys in memory and persist to DB
        if (upsertResult?.clearSenderAndReconnect) {
          const now = Date.now();
          const last = this.lastClearReconnectAt.get(deviceId) ?? 0;
          if (now - last < CLEAR_RECONNECT_DEBOUNCE_MS) {
            await logger.warn('Skipping clear sender sessions (debounced)', '', {
              deviceId,
              metadata: { remoteJid: upsertResult.clearSenderAndReconnect.remoteJid, nextAllowedInSec: Math.ceil((CLEAR_RECONNECT_DEBOUNCE_MS - (now - last)) / 1000) }
            }).catch(() => {});
          } else {
            this.lastClearReconnectAt.set(deviceId, now);
            const { remoteJid, senderPn } = upsertResult.clearSenderAndReconnect;
            try {
              clearSenderSessionsInMemory(remoteJid, senderPn ?? null);
              if ((save as any).immediate) {
                await (save as any).immediate();
              }
              await logger.info('Cleared session keys for sender (memory + DB)', {
                deviceId,
                metadata: { remoteJid, senderPn }
              }).catch(() => {});
            } catch (clearErr) {
              await logger.error('Failed to clear sender sessions', clearErr instanceof Error ? clearErr : new Error(String(clearErr)), {
                deviceId,
                metadata: { remoteJid, senderPn }
              }).catch(() => {});
            }
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

  /** Cierra socket, cancela saves/reconnects y borra WaSession persistida. */
  async resetSession(deviceId: string): Promise<void> {
    this.clearReconnectTimer(deviceId);
    this.clearOfflineUnrecoveredAlert(deviceId);
    this.reconnectAttempts.delete(deviceId);
    this.lastClearReconnectAt.delete(deviceId);

    const entry = this.sessions.get(deviceId);
    if (entry) {
      entry.closing = true;
      try {
        entry.socket.end(new Error('reset-session'));
      } catch {
        // ignore
      } finally {
        this.sessions.delete(deviceId);
      }
    }

    await this.purgePersistedAuthState(deviceId);
    await this.persistDeviceOffline(deviceId);

    await logger.info('WhatsApp session reset (unlinked)', { deviceId }).catch(() => {});
  }

  /** Cierra socket y elimina sesión en memoria; actualiza Device a OFFLINE en BD. */
  async disconnect(deviceId: string): Promise<void> {
    this.clearReconnectTimer(deviceId);
    this.clearOfflineUnrecoveredAlert(deviceId);
    this.reconnectAttempts.delete(deviceId);
    disposeAuthStateSaves(deviceId);

    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    entry.closing = true;
    try {
      entry.socket.end(new Error('disconnect'));
    } finally {
      this.sessions.delete(deviceId);
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: 'OFFLINE', qr: null, pairingCode: null }
      });
    }
  }

  get(deviceId: string) {
    return this.sessions.get(deviceId)?.socket ?? null;
  }

  /** Backfill phoneHint from active sockets (e.g. devices already ONLINE before deploy). */
  async syncPhoneHintsForActiveSessions(): Promise<void> {
    let updated = 0;
    // Snapshot entries so concurrent connect/disconnect cannot skip devices mid-iteration.
    for (const [deviceId, entry] of [...this.sessions.entries()]) {
      if (entry.closing) continue;
      const phoneHint = await phoneHintIfChanged(deviceId, entry.socket.user?.id);
      if (!phoneHint) continue;
      await prisma.device.update({
        where: { id: deviceId },
        data: { phoneHint }
      });
      updated++;
    }
    if (updated > 0) {
      await logger
        .info(`[worker] Backfilled phoneHint for ${updated} device(s)`, { metadata: { updated } })
        .catch(() => {});
    }
  }
}

