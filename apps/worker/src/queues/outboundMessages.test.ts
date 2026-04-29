import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  let processor: ((job: any) => Promise<void>) | null = null;
  const sendMessageMock = vi.fn();
  const sendPresenceUpdateMock = vi.fn(async () => {});

  return {
    setProcessor(fn: (job: any) => Promise<void>) {
      processor = fn;
    },
    getProcessor() {
      return processor;
    },
    sendMessageMock,
    sendPresenceUpdateMock,
    rowById: new Map<string, any>()
  };
});

vi.mock('bullmq', () => {
  class MockWorker {
    constructor(_name: string, processor: (job: any) => Promise<void>) {
      hoisted.setProcessor(processor);
    }
    on() {
      return this;
    }
  }
  return { Worker: MockWorker };
});

vi.mock('../lib/prisma.js', () => {
  const updateMock = vi.fn(async ({ data }: any) => data);
  return {
    prisma: {
      outboundMessage: {
        findUnique: vi.fn(async ({ where }: any) => hoisted.rowById.get(where.id) ?? null),
        update: updateMock
      },
      device: {
        findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'ONLINE' }))
      }
    }
  };
});

vi.mock('./deviceCommands.js', () => {
  return {
    sessionManager: {
      get: vi.fn(() => ({
        user: { id: 'me@s.whatsapp.net' },
        sendPresenceUpdate: hoisted.sendPresenceUpdateMock,
        sendMessage: hoisted.sendMessageMock
      }))
    }
  };
});

vi.mock('../lib/redis.js', () => {
  return { redis: {} };
});

vi.mock('@wc/logger', () => {
  return {
    createLogger: vi.fn(() => ({
      info: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {})
    }))
  };
});

describe('outboundMessages worker media dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.rowById.clear();
    hoisted.sendMessageMock.mockResolvedValue({ key: { id: 'provider-1' } });
  });

  it('envia texto con payload text existente', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    hoisted.rowById.set('out-1', {
      id: 'out-1',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'text',
      payloadJson: { text: 'hola' },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-1', data: { outboundMessageId: 'out-1' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith('5216183610698@s.whatsapp.net', { text: 'hola' });
  });

  it('envia imagen con imageUrl y caption', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    hoisted.rowById.set('out-2', {
      id: 'out-2',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'image',
      payloadJson: { imageUrl: 'https://example.com/car.png', caption: 'Vehiculo' },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-2', data: { outboundMessageId: 'out-2' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
      '5216183610698@s.whatsapp.net',
      { image: { url: 'https://example.com/car.png' }, caption: 'Vehiculo' },
      expect.objectContaining({ mediaUploadTimeoutMs: expect.any(Number) })
    );
  });

  it('normaliza error de media cuando falla image fetch', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    hoisted.sendMessageMock.mockRejectedValueOnce(new Error('fetch failed'));
    hoisted.rowById.set('out-3', {
      id: 'out-3',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'image',
      payloadJson: { imageUrl: 'https://example.com/car.png' },
      createdAt: new Date()
    });

    await expect(
      processor?.({ id: 'job-3', data: { outboundMessageId: 'out-3' }, attemptsMade: 0 })
    ).rejects.toThrow('media_fetch_failed');
  });
});
