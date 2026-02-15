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

// Handle unhandled promise rejections that may come from libsignal/Baileys
// These errors often occur during message decryption and may not be caught by our handlers
process.on('unhandledRejection', async (reason: any, promise: Promise<any>) => {
  const errorMessage = reason?.message ?? String(reason);
  const errorStack = reason?.stack ?? '';
  
  // Check if this is a session sync error from libsignal
  const isSessionError = errorMessage.includes('Over 2000 messages into the future') ||
                        errorMessage.includes('SessionError') ||
                        errorMessage.includes('Failed to decrypt message') ||
                        errorStack.includes('session_cipher.js');
  
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

