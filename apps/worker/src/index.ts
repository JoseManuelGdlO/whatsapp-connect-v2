import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? 'env.local' });

import http from 'node:http';
import { startDeviceCommandsWorker } from './queues/deviceCommands.js';
import { startWebhookDispatchWorker } from './queues/webhookDispatch.js';
import { startOutboundMessagesWorker } from './queues/outboundMessages.js';
import { assertCryptoKeyConfigured } from './lib/crypto.js';

const port = Number(process.env.WORKER_HEALTH_PORT ?? 3030);

// Simple stdout heartbeat for now; worker will run BullMQ processors.
// eslint-disable-next-line no-console
console.log(`[worker] starting (healthPort=${port})`);

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
  .listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[worker] health listening on http://0.0.0.0:${port}/health`);
  });

setInterval(() => {
  // eslint-disable-next-line no-console
  console.log(`[worker] alive ${new Date().toISOString()}`);
}, 30_000);

