import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMemoryRedis() {
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();

  return {
    lists,
    ttls,
    async lrange(key: string, start: number, end: number) {
      const list = lists.get(key) ?? [];
      if (end === -1) return list.slice(start);
      return list.slice(start, end + 1);
    },
    async rpush(key: string, value: string) {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    },
    async expire(key: string, ttlSec: number) {
      ttls.set(key, ttlSec);
      return 1;
    },
    multi() {
      const ops: Array<() => Promise<unknown>> = [];
      return {
        lrange(key: string, start: number, end: number) {
          ops.push(() => lists.get(key)?.slice(start, end === -1 ? undefined : end + 1) ?? []);
          return this;
        },
        del(key: string) {
          ops.push(async () => {
            lists.delete(key);
            return 1;
          });
          return this;
        },
        async exec() {
          const results: Array<[null, unknown]> = [];
          for (const op of ops) {
            results.push([null, await op()]);
          }
          return results;
        }
      };
    }
  };
}

let memoryRedis = createMemoryRedis();

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return memoryRedis;
  }
}));

describe('pendingReadBuffer', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    memoryRedis = createMemoryRedis();
    vi.resetModules();
  });

  it('trackPendingRead acumula claves por device y chat', async () => {
    const { trackPendingRead, drainPendingRead } = await import('./pendingReadBuffer.js');
    const key = { id: 'm-1', remoteJid: '521@test.s.whatsapp.net', fromMe: false };

    await trackPendingRead('device-1', key);
    const drained = await drainPendingRead('device-1', '521@test.s.whatsapp.net');

    expect(drained).toEqual([key]);
  });

  it('deduplica por message id', async () => {
    const { trackPendingRead, drainPendingRead } = await import('./pendingReadBuffer.js');
    const key = { id: 'm-dup', remoteJid: '521@test.s.whatsapp.net', fromMe: false };

    await trackPendingRead('device-1', key);
    await trackPendingRead('device-1', key);

    const drained = await drainPendingRead('device-1', '521@test.s.whatsapp.net');
    expect(drained).toHaveLength(1);
  });

  it('drain vacío devuelve lista vacía', async () => {
    const { drainPendingRead } = await import('./pendingReadBuffer.js');
    const drained = await drainPendingRead('device-1', '521@missing.s.whatsapp.net');
    expect(drained).toEqual([]);
  });

  it('drain consume la lista (segunda llamada vacía)', async () => {
    const { trackPendingRead, drainPendingRead } = await import('./pendingReadBuffer.js');
    await trackPendingRead('device-1', { id: 'm-2', remoteJid: '521@test.s.whatsapp.net', fromMe: false });

    await drainPendingRead('device-1', '521@test.s.whatsapp.net');
    const second = await drainPendingRead('device-1', '521@test.s.whatsapp.net');
    expect(second).toEqual([]);
  });

  it('aplica EXPIRE al trackear', async () => {
    const { trackPendingRead } = await import('./pendingReadBuffer.js');
    await trackPendingRead('device-1', { id: 'm-3', remoteJid: '521@test.s.whatsapp.net', fromMe: false });
    expect(memoryRedis.ttls.size).toBe(1);
  });

  it('isOutboundMarkReadOnSendEnabled es false solo con env explícito', async () => {
    const mod = await import('./pendingReadBuffer.js');
    expect(mod.isOutboundMarkReadOnSendEnabled()).toBe(true);

    vi.stubEnv('WORKER_OUTBOUND_MARK_READ_ON_SEND', 'false');
    vi.resetModules();
    const modOff = await import('./pendingReadBuffer.js');
    expect(modOff.isOutboundMarkReadOnSendEnabled()).toBe(false);
  });
});
