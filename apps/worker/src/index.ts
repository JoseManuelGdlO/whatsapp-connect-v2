import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? 'env.local' });

import http from 'node:http';
import { startDeviceCommandsWorker } from './queues/deviceCommands.js';
import { startWebhookDispatchWorker } from './queues/webhookDispatch.js';
import { startOutboundMessagesWorker } from './queues/outboundMessages.js';
import { assertCryptoKeyConfigured } from './lib/crypto.js';
import { prisma } from './lib/prisma.js';
import { createLogger } from '@wc/logger';
import { sessionManager } from './queues/deviceCommands.js';

const port = Number(process.env.WORKER_HEALTH_PORT ?? 3030);
const logger = createLogger(prisma, 'worker');

// Simple stdout heartbeat for now; worker will run BullMQ processors.
logger.info(`Worker starting (healthPort=${port})`).catch(() => {});

assertCryptoKeyConfigured();

startDeviceCommandsWorker();
startWebhookDispatchWorker();
startOutboundMessagesWorker();

// Minimal health endpoint for container checks (EasyPanel, Docker, etc.)
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'worker' }));
      return;
    }
    res.statusCode = 404;
    res.end('not_found');
  })
  .listen(port, '0.0.0.0', async () => {
    await logger.info(`Worker health listening on http://0.0.0.0:${port}/health`).catch(() => {});
  });

setInterval(() => {
  logger.info(`Worker alive ${new Date().toISOString()}`).catch(() => {});
}, 30_000);

// Handle uncaught exceptions (e.g. stream errors from undici/fetch when connection is closed)
// These can occur when WhatsApp closes the connection mid-request (ECONNRESET, "terminated")
const BENIGN_NETWORK_PATTERNS = [
  'terminated',
  'other side closed',
  'ECONNRESET',
  'socket hang up',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ETIMEDOUT'
];
process.on('uncaughtException', (err: Error) => {
  const msg = err?.message ?? String(err);
  const cause = (err as any)?.cause;
  const causeMsg = cause?.message ?? (typeof cause === 'string' ? cause : '');
  const combined = `${msg} ${causeMsg}`.toLowerCase();
  const isBenignNetwork = BENIGN_NETWORK_PATTERNS.some((p) => combined.includes(p.toLowerCase()));

  console.error('[worker] UncaughtException:', msg, causeMsg ? `(cause: ${causeMsg})` : '', err?.stack ?? '');

  if (isBenignNetwork) {
    logger
      .error('UncaughtException (benign network - worker will continue)', err instanceof Error ? err : new Error(String(err)), {
        metadata: { errorMessage: msg, causeMessage: causeMsg, note: 'WhatsApp closed connection mid-request. Sessions will reconnect.' }
      })
      .catch(() => {});
  } else {
    logger
      .error('UncaughtException - worker will exit', err instanceof Error ? err : new Error(String(err)), {
        metadata: { errorMessage: msg, causeMessage: causeMsg, note: 'Process exiting to allow container/PM2 restart.' }
      })
      .catch(() => {});
    process.exit(1);
  }
});

// Handle unhandled promise rejections that may come from libsignal/Baileys
// These errors often occur during message decryption and may not be caught by our handlers
process.on('unhandledRejection', async (reason: any, promise: Promise<any>) => {
  const errorMessage = reason?.message ?? String(reason);
  const errorStack = reason?.stack ?? '';
  
  // Check if this is a session sync error from libsignal/Baileys
  const isSessionError = errorMessage.includes('Over 2000 messages into the future') ||
                        errorMessage.includes('SessionError') ||
                        errorMessage.includes('Failed to decrypt message') ||
                        errorMessage.includes('Invalid patch mac') ||
                        errorMessage.includes('Bad MAC') ||
                        errorStack.includes('session_cipher.js') ||
                        errorStack.includes('chat-utils.js');
  
  if (isSessionError) {
    await logger.error('Unhandled session sync error detected (from libsignal)', reason, {
      metadata: { 
        errorMessage,
        note: 'This error occurred during message decryption. All active sessions will attempt to clear corrupted state and reconnect.'
      }
    }).catch(() => {});
    
    // Note: We can't easily determine which device caused this error from an unhandled rejection
    // The session manager will handle reconnection when it detects the error in its handlers
    // This log helps us identify when these errors occur
  } else {
    // Log other unhandled rejections for debugging
    await logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)), {
      metadata: { errorMessage, errorStack: errorStack.substring(0, 500) }
    }).catch(() => {});
  }
});

