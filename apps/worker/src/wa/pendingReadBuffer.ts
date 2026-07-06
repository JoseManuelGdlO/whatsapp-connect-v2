import type { proto } from '@whiskeysockets/baileys';

import { redis } from '../lib/redis.js';

const DEFAULT_INBOUND_MAX_AGE_MS = 86_400_000; // 1 día

function getPendingReadTtlMs(): number {
  const raw = process.env.WORKER_INBOUND_MAX_AGE_MS;
  if (raw === undefined || raw === '') return DEFAULT_INBOUND_MAX_AGE_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INBOUND_MAX_AGE_MS;
}

function bufferKey(deviceId: string, remoteJid: string): string {
  return `wc:pending-read:${deviceId}:${remoteJid}`;
}

/** Marca read al enviar outbound. Opt-out con `WORKER_OUTBOUND_MARK_READ_ON_SEND=false`. */
export function isOutboundMarkReadOnSendEnabled(): boolean {
  return process.env.WORKER_OUTBOUND_MARK_READ_ON_SEND !== 'false';
}

export async function trackPendingRead(deviceId: string, key: proto.IMessageKey): Promise<void> {
  if (!key.id || !key.remoteJid) return;

  const redisKey = bufferKey(deviceId, key.remoteJid);
  const entry = JSON.stringify({ id: key.id, remoteJid: key.remoteJid, fromMe: false });

  const existing = await redis.lrange(redisKey, 0, -1);
  const isDuplicate = existing.some((raw) => {
    try {
      return (JSON.parse(raw) as { id?: string }).id === key.id;
    } catch {
      return false;
    }
  });
  if (isDuplicate) return;

  await redis.rpush(redisKey, entry);
  const ttlSec = Math.max(1, Math.ceil(getPendingReadTtlMs() / 1000));
  await redis.expire(redisKey, ttlSec);
}

export async function drainPendingRead(deviceId: string, remoteJid: string): Promise<proto.IMessageKey[]> {
  const redisKey = bufferKey(deviceId, remoteJid);
  const pipeline = redis.multi();
  pipeline.lrange(redisKey, 0, -1);
  pipeline.del(redisKey);
  const results = await pipeline.exec();
  const rawList = results?.[0]?.[1] as string[] | undefined;
  if (!rawList?.length) return [];

  return rawList.map((raw) => JSON.parse(raw) as proto.IMessageKey);
}
