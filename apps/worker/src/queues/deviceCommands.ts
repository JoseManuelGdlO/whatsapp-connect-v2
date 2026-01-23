import { Worker } from 'bullmq';

import { redis } from '../lib/redis.js';
import { SessionManager } from '../wa/sessionManager.js';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '@wc/logger';

export const sessionManager = new SessionManager();
const logger = createLogger(prisma, 'worker');

type JobData = { deviceId: string };

export function startDeviceCommandsWorker() {
  const worker = new Worker<JobData>(
    'device_commands',
    async (job) => {
      const { deviceId } = job.data;
      if (!deviceId) {
        const error = new Error('deviceId required');
        await logger.error('Device command missing deviceId', error).catch(() => {});
        throw error;
      }

      try {
        if (job.name === 'connect') {
          await logger.info(`Connecting device ${deviceId}`, { deviceId }).catch(() => {});
          await sessionManager.connect(deviceId);
          return;
        }

        if (job.name === 'disconnect') {
          await logger.info(`Disconnecting device ${deviceId}`, { deviceId }).catch(() => {});
          await sessionManager.disconnect(deviceId);
          return;
        }

        const error = new Error(`Unknown job name: ${job.name}`);
        await logger.error('Unknown device command', error, { deviceId, metadata: { jobName: job.name } }).catch(() => {});
        throw error;
      } catch (err: any) {
        await logger.error(`Device command failed: ${job.name}`, err, { deviceId }).catch(() => {});
        throw err;
      }
    },
    { connection: redis }
  );

  worker.on('failed', async (job, err) => {
    await logger.error(
      `Device command job failed (jobId: ${job?.id}, name: ${job?.name})`,
      err,
      {
        deviceId: (job?.data as any)?.deviceId,
        metadata: { jobId: job?.id, jobName: job?.name }
      }
    ).catch(() => {});
  });

  logger.info('[worker] device_commands worker started').catch(() => {});
  return worker;
}

