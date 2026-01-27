import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? 'env.local' });

import http from 'node:http';
import { startDeviceCommandsWorker } from './queues/deviceCommands.js';
import { startWebhookDispatchWorker } from './queues/webhookDispatch.js';
import { startOutboundMessagesWorker } from './queues/outboundMessages.js';
import { assertCryptoKeyConfigured } from './lib/crypto.js';
import { prisma } from './lib/prisma.js';
import { createLogger } from '@wc/logger';

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

