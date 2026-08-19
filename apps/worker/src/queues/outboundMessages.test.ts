import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  let processor: ((job: any) => Promise<void>) | null = null;
  const sendMessageMock = vi.fn(async (..._args: any[]) => ({ key: { id: 'provider-1' } }));
  const sendPresenceUpdateMock = vi.fn(async (..._args: any[]) => {});
  const readMessagesMock = vi.fn(async (..._args: any[]) => {});
  const drainPendingReadMock = vi.fn(async (..._args: any[]) => [] as any[]);
  const callOrder: string[] = [];

  return {
    setProcessor(fn: (job: any) => Promise<void>) {
      processor = fn;
    },
    getProcessor() {
      return processor;
    },
    sendMessageMock,
    sendPresenceUpdateMock,
    readMessagesMock,
    drainPendingReadMock,
    callOrder,
    rowById: new Map<string, any>(),
    socketUser: { id: 'me@s.whatsapp.net', lid: undefined as string | undefined }
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
        user: hoisted.socketUser,
        sendPresenceUpdate: (state: string, jid: string) => {
          hoisted.callOrder.push(`presence:${state}`);
          return hoisted.sendPresenceUpdateMock(state, jid);
        },
        readMessages: (keys: any) => {
          hoisted.callOrder.push('readMessages');
          return hoisted.readMessagesMock(keys);
        },
        sendMessage: (...args: any[]) => {
          hoisted.callOrder.push('sendMessage');
          return hoisted.sendMessageMock(...args);
        }
      }))
    }
  };
});

vi.mock('../wa/pendingReadBuffer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wa/pendingReadBuffer.js')>();
  return {
    ...actual,
    drainPendingRead: (...args: any[]) => hoisted.drainPendingReadMock(...args)
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
    hoisted.callOrder.length = 0;
    hoisted.drainPendingReadMock.mockResolvedValue([]);
    hoisted.sendMessageMock.mockResolvedValue({ key: { id: 'provider-1' } });
    hoisted.socketUser = { id: 'me@s.whatsapp.net', lid: undefined };
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

  it('envia documento PDF con documentUrl, fileName y caption', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    hoisted.rowById.set('out-4', {
      id: 'out-4',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'document',
      payloadJson: {
        documentUrl: 'https://example.com/cotizacion.pdf',
        fileName: 'cotizacion.pdf',
        caption: 'Tu cotizacion'
      },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-4', data: { outboundMessageId: 'out-4' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
      '5216183610698@s.whatsapp.net',
      {
        document: { url: 'https://example.com/cotizacion.pdf' },
        mimetype: 'application/pdf',
        fileName: 'cotizacion.pdf',
        caption: 'Tu cotizacion'
      },
      expect.objectContaining({ mediaUploadTimeoutMs: expect.any(Number) })
    );
  });

  it('normaliza error de media cuando falla document fetch', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    hoisted.sendMessageMock.mockRejectedValueOnce(new Error('fetch failed'));
    hoisted.rowById.set('out-5', {
      id: 'out-5',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'document',
      payloadJson: { documentUrl: 'https://example.com/cotizacion.pdf' },
      createdAt: new Date()
    });

    await expect(
      processor?.({ id: 'job-5', data: { outboundMessageId: 'out-5' }, attemptsMade: 0 })
    ).rejects.toThrow('media_fetch_failed');
  });

  it('marca read antes de composing y sendMessage cuando hay pending keys', async () => {
    hoisted.drainPendingReadMock.mockResolvedValue([
      { id: 'in-1', remoteJid: '5216183610698@s.whatsapp.net', fromMe: false }
    ]);

    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();

    hoisted.rowById.set('out-read', {
      id: 'out-read',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'text',
      payloadJson: { text: 'respuesta' },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-read', data: { outboundMessageId: 'out-read' }, attemptsMade: 0 });

    expect(hoisted.drainPendingReadMock).toHaveBeenCalledWith('device-1', '5216183610698@s.whatsapp.net');
    expect(hoisted.readMessagesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.callOrder).toEqual([
      'readMessages',
      'presence:composing',
      'sendMessage',
      'presence:paused'
    ]);
  });

  it('continúa el envío si readMessages falla', async () => {
    hoisted.drainPendingReadMock.mockResolvedValue([
      { id: 'in-2', remoteJid: '5216183610698@s.whatsapp.net', fromMe: false }
    ]);
    hoisted.readMessagesMock.mockRejectedValueOnce(new Error('read_failed'));

    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();

    hoisted.rowById.set('out-read-fail', {
      id: 'out-read-fail',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: '5216183610698@s.whatsapp.net',
      type: 'text',
      payloadJson: { text: 'sigue' },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-read-fail', data: { outboundMessageId: 'out-read-fail' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sendPresenceUpdateMock).toHaveBeenCalled();
  });

  it('envia status_image a status@broadcast con broadcast y statusJidList', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();
    expect(processor).toBeTypeOf('function');

    const statusJidList = ['5216181234567@s.whatsapp.net', '123456789012345@lid'];
    hoisted.rowById.set('out-status', {
      id: 'out-status',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: 'status@broadcast',
      type: 'status_image',
      payloadJson: {
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        caption: 'Texto del estado',
        statusJidList
      },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-status', data: { outboundMessageId: 'out-status' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
      'status@broadcast',
      { image: { url: 'https://cdn.cliente.com/estado.jpg' }, caption: 'Texto del estado' },
      expect.objectContaining({
        broadcast: true,
        statusJidList: [...statusJidList, 'me@s.whatsapp.net'],
        mediaUploadTimeoutMs: expect.any(Number)
      })
    );
    expect(hoisted.sendPresenceUpdateMock).not.toHaveBeenCalled();
    expect(hoisted.drainPendingReadMock).not.toHaveBeenCalled();
    expect(hoisted.readMessagesMock).not.toHaveBeenCalled();
    expect(hoisted.callOrder).toEqual(['sendMessage']);
  });

  it('falla status_image con statusJidList vacio sin llamar sendMessage', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();

    hoisted.rowById.set('out-status-empty', {
      id: 'out-status-empty',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: 'status@broadcast',
      type: 'status_image',
      payloadJson: {
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        statusJidList: []
      },
      createdAt: new Date()
    });

    await expect(
      processor?.({ id: 'job-status-empty', data: { outboundMessageId: 'out-status-empty' }, attemptsMade: 0 })
    ).rejects.toThrow('status_jid_list_empty');
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it('anexa el JID propio PN a una audiencia solo PN', async () => {
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();

    hoisted.rowById.set('out-status-own', {
      id: 'out-status-own',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: 'status@broadcast',
      type: 'status_image',
      payloadJson: {
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        statusJidList: ['5216181234567@s.whatsapp.net']
      },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-status-own', data: { outboundMessageId: 'out-status-own' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
      'status@broadcast',
      expect.anything(),
      expect.objectContaining({
        statusJidList: ['5216181234567@s.whatsapp.net', 'me@s.whatsapp.net']
      })
    );
  });

  it('anexa el LID propio a una audiencia solo LID', async () => {
    hoisted.socketUser = { id: '5216184487125:4@s.whatsapp.net', lid: '15325181567089:4@lid' };
    const { startOutboundMessagesWorker } = await import('./outboundMessages.js');
    startOutboundMessagesWorker();
    const processor = hoisted.getProcessor();

    hoisted.rowById.set('out-status-lid', {
      id: 'out-status-lid',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      to: 'status@broadcast',
      type: 'status_image',
      payloadJson: {
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        statusJidList: ['60911863783463@lid']
      },
      createdAt: new Date()
    });

    await processor?.({ id: 'job-status-lid', data: { outboundMessageId: 'out-status-lid' }, attemptsMade: 0 });

    expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
      'status@broadcast',
      expect.anything(),
      expect.objectContaining({
        statusJidList: ['60911863783463@lid', '15325181567089@lid']
      })
    );
  });
});
