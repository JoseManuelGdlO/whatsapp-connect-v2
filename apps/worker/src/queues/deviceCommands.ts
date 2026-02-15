import { Worker } from 'bullmq';

import { redis } from '../lib/redis.js';
import { SessionManager } from '../wa/sessionManager.js';
import { clearSessionsForJids } from '../wa/authStateDb.js';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '@wc/logger';

export const sessionManager = new SessionManager();
const logger = createLogger(prisma, 'worker');

type JobData = { deviceId: string; jids?: string[] };

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

        if (job.name === 'reset-sender-sessions') {
          const jids = (job.data as JobData).jids ?? [];
          await logger.info(`Resetting sender sessions for device ${deviceId}`, {
            deviceId,
            metadata: { jidCount: jids.length }
          }).catch(() => {});
          await clearSessionsForJids(deviceId, jids);
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

  // After deploy: reconnect all devices that have an initialized session so the user
  // doesn't have to click "Conectar" on each one.
  const reconnectDelayMs = Number(process.env.WORKER_RECONNECT_ALL_DELAY_MS ?? 5000);
  const staggerMs = Number(process.env.WORKER_RECONNECT_STAGGER_MS ?? 800);
  setTimeout(() => void reconnectAllInitializedDevices(staggerMs), reconnectDelayMs);

  return worker;
}

/**
 * Reconnect all devices that have a stored session (were linked at least once).
 * Called on worker startup so after a deploy all WhatsApp sessions come back without
 * manually clicking "Conectar" on each device.
 */
export async function reconnectAllInitializedDevices(staggerMs: number = 800): Promise<void> {
  try {
    const devices = await prisma.device.findMany({
      where: { session: { isNot: null } },
      select: { id: true, label: true }
    });
    if (devices.length === 0) {
      await logger.info('[worker] No devices with session to reconnect', {}).catch(() => {});
      return;
    }
    await logger.info(`[worker] Reconnecting ${devices.length} device(s) with session`, {
      metadata: { count: devices.length, staggerMs }
    }).catch(() => {});

    for (let i = 0; i < devices.length; i++) {
      const { id } = devices[i];
      if (sessionManager.get(id)) continue; // already connected
      try {
        await sessionManager.connect(id);
      } catch (err) {
        await logger
          .error(`[worker] Failed to reconnect device ${id}`, err instanceof Error ? err : new Error(String(err)), {
            deviceId: id,
            metadata: { label: devices[i].label }
          })
          .catch(() => {});
      }
      if (i < devices.length - 1 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }
    }
  } catch (err) {
    await logger
      .error('[worker] reconnectAllInitializedDevices failed', err instanceof Error ? err : new Error(String(err)), {})
      .catch(() => {});
  }
}

