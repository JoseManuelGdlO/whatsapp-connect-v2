import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE ?? 'env.local' });

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

setInterval(() => {
  // eslint-disable-next-line no-console
  console.log(`[worker] alive ${new Date().toISOString()}`);
}, 30_000);

