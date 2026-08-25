import { redis } from '../lib/redis.js';

function lockKey(deviceId: string): string {
  return `wc:reachout-lock:${deviceId}`;
}

export function reachoutLockTtlSec(): number {
  const raw = parseInt(process.env.WORKER_REACHOUT_LOCK_SEC ?? '3600', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3600;
}

export async function setReachoutLock(deviceId: string): Promise<void> {
  try {
    await redis.set(lockKey(deviceId), '463', 'EX', reachoutLockTtlSec());
  } catch {
    // Redis down must not crash the ack handler
  }
}

export async function hasReachoutLock(deviceId: string): Promise<boolean> {
  try {
    const value = await redis.get(lockKey(deviceId));
    return Boolean(value);
  } catch {
    return false;
  }
}
