import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 200, 2000);
  },
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    return targetErrors.some((e) => err.message?.includes(e) ?? false);
  },
});

// Log connection state for debugging (worker and API both use Redis for queues)
const maskUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '6379'}`;
  } catch {
    return '(invalid url)';
  }
};

redis.on('connect', () => {
  console.log(`[redis] connected to ${maskUrl(redisUrl)}`);
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

