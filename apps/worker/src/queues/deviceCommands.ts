import { Worker } from 'bullmq';

import { redis } from '../lib/redis.js';
import { SessionManager } from '../wa/sessionManager.js';

export const sessionManager = new SessionManager();

type JobData = { deviceId: string };

export function startDeviceCommandsWorker() {
  const worker = new Worker<JobData>(
    'device_commands',
    async (job) => {
      const { deviceId } = job.data;
      if (!deviceId) throw new Error('deviceId required');

      if (job.name === 'connect') {
        await sessionManager.connect(deviceId);
        return;
      }

      if (job.name === 'disconnect') {
        await sessionManager.disconnect(deviceId);
        return;
      }

      throw new Error(`Unknown job name: ${job.name}`);
    },
    { connection: redis }
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error('[worker] device_commands failed', job?.id, job?.name, err);
  });

  // eslint-disable-next-line no-console
  console.log('[worker] device_commands worker started');
  return worker;
}

