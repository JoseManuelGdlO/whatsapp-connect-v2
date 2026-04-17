import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueAddMock = vi.fn();
const normalizeInboundMessageMock = vi.fn();

vi.mock('bullmq', () => {
  class MockQueue {
    add = queueAddMock;
  }
  return {
    Queue: MockQueue
  };
});

vi.mock('../lib/prisma.js', () => {
  return {
    prisma: {
      device: {
        findUnique: vi.fn(async () => ({ id: 'device-1', tenantId: 'tenant-1' })),
        update: vi.fn(async () => ({}))
      },
      webhookEndpoint: {
        findMany: vi.fn(async () => [{ id: 'endpoint-1', tenantId: 'tenant-1', url: 'https://webhook.test', enabled: true }])
      },
      event: {
        create: vi.fn(async ({ data }: { data: any }) => ({ id: 'event-1', ...data }))
      },
      webhookDelivery: {
        create: vi.fn(async () => ({ id: 'delivery-1' }))
      },
      outboundMessage: {
        create: vi.fn(async () => ({ id: 'outbound-1' }))
      }
    }
  };
});

vi.mock('./normalize.js', () => {
  return {
    normalizeInboundMessage: normalizeInboundMessageMock
  };
});

vi.mock('@wc/logger', () => {
  return {
    createLogger: vi.fn(() => ({
      warn: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      debug: vi.fn(async () => {})
    }))
  };
});

describe('handleMessagesUpsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueAddMock.mockResolvedValue({ id: 'job-1' });
  });

  it('marca clearSenderAndReconnect cuando detecta stub de descifrado', async () => {
    normalizeInboundMessageMock.mockReturnValue({
      from: '5216183610698@s.whatsapp.net',
      content: {
        type: 'stub',
        text: 'No matching sessions found for message'
      }
    });

    const { handleMessagesUpsert } = await import('./inbound.js');
    const result = await handleMessagesUpsert({
      deviceId: 'device-1',
      sock: {
        user: { id: 'me@s.whatsapp.net' },
        sendPresenceUpdate: vi.fn(async () => {}),
        readMessages: vi.fn(async () => {})
      } as any,
      messages: [
        {
          key: {
            id: 'm-1',
            remoteJid: '5216183610698@s.whatsapp.net',
            senderPn: '5216183610698@s.whatsapp.net',
            fromMe: false
          }
        }
      ] as any
    });

    expect(result).toEqual({
      clearSenderAndReconnect: {
        remoteJid: '5216183610698@s.whatsapp.net',
        senderPn: '5216183610698@s.whatsapp.net'
      }
    });
    expect(queueAddMock).toHaveBeenCalled();
  });

  it('no marca clearSenderAndReconnect cuando stub no es de decryption', async () => {
    normalizeInboundMessageMock.mockReturnValue({
      from: '5216183610698@s.whatsapp.net',
      content: {
        type: 'stub',
        text: 'history sync in progress'
      }
    });

    const { handleMessagesUpsert } = await import('./inbound.js');
    const result = await handleMessagesUpsert({
      deviceId: 'device-1',
      sock: {
        user: { id: 'me@s.whatsapp.net' },
        sendPresenceUpdate: vi.fn(async () => {}),
        readMessages: vi.fn(async () => {})
      } as any,
      messages: [
        {
          key: {
            id: 'm-2',
            remoteJid: '5216183610698@s.whatsapp.net',
            fromMe: false
          }
        }
      ] as any
    });

    expect(result).toBeUndefined();
  });

  it('procesa burst de mensajes sin acumular errores de encolado', async () => {
    normalizeInboundMessageMock.mockImplementation(({ message }: any) => ({
      from: message.key.remoteJid,
      content: {
        type: 'text',
        text: 'ok'
      }
    }));

    const { handleMessagesUpsert } = await import('./inbound.js');
    const sock = {
      user: { id: 'me@s.whatsapp.net' },
      sendPresenceUpdate: vi.fn(async () => {}),
      readMessages: vi.fn(async () => {})
    } as any;

    const messageCount = 100;
    const messages = Array.from({ length: messageCount }, (_, i) => ({
      key: {
        id: `burst-${i}`,
        remoteJid: `521000000${i}@s.whatsapp.net`,
        fromMe: false
      }
    })) as any;

    await handleMessagesUpsert({
      deviceId: 'device-1',
      sock,
      messages
    });

    // Cada mensaje válido genera 1 entrega de webhook (hay 1 endpoint mockeado).
    expect(queueAddMock).toHaveBeenCalledTimes(messageCount);
  });

  it('mantiene comportamiento estable en soak corto de mensajes de texto', async () => {
    normalizeInboundMessageMock.mockImplementation(({ message }: any) => ({
      from: message.key.remoteJid,
      content: {
        type: 'text',
        text: 'soak'
      }
    }));

    const { handleMessagesUpsert } = await import('./inbound.js');
    const sock = {
      user: { id: 'me@s.whatsapp.net' },
      sendPresenceUpdate: vi.fn(async () => {}),
      readMessages: vi.fn(async () => {})
    } as any;

    for (let i = 0; i < 20; i += 1) {
      await handleMessagesUpsert({
        deviceId: 'device-1',
        sock,
        messages: [
          {
            key: {
              id: `soak-${i}`,
              remoteJid: `52177700${i}@s.whatsapp.net`,
              fromMe: false
            }
          }
        ] as any
      });
    }

    expect(queueAddMock).toHaveBeenCalledTimes(20);
  });

  it('procesa tipos de media como mensajes válidos sin disparar clearSenderAndReconnect', async () => {
    const mediaTypes = ['image', 'document', 'audio'] as const;
    const { handleMessagesUpsert } = await import('./inbound.js');
    const sock = {
      user: { id: 'me@s.whatsapp.net' },
      sendPresenceUpdate: vi.fn(async () => {}),
      readMessages: vi.fn(async () => {})
    } as any;

    for (const mediaType of mediaTypes) {
      normalizeInboundMessageMock.mockReturnValueOnce({
        from: '5216183610698@s.whatsapp.net',
        content: {
          type: mediaType,
          text: null
        }
      });

      const result = await handleMessagesUpsert({
        deviceId: 'device-1',
        sock,
        messages: [
          {
            key: {
              id: `media-${mediaType}`,
              remoteJid: '5216183610698@s.whatsapp.net',
              fromMe: false
            }
          }
        ] as any
      });

      expect(result).toBeUndefined();
    }
  });

  it('continúa procesando cuando readMessages falla (caos de dependencia)', async () => {
    normalizeInboundMessageMock.mockReturnValue({
      from: '5216183610698@s.whatsapp.net',
      content: {
        type: 'text',
        text: 'resilience'
      }
    });

    const { handleMessagesUpsert } = await import('./inbound.js');
    await handleMessagesUpsert({
      deviceId: 'device-1',
      sock: {
        user: { id: 'me@s.whatsapp.net' },
        sendPresenceUpdate: vi.fn(async () => {}),
        readMessages: vi.fn(async () => {
          throw new Error('redis_blip');
        })
      } as any,
      messages: [
        {
          key: {
            id: 'chaos-1',
            remoteJid: '5216183610698@s.whatsapp.net',
            fromMe: false
          }
        }
      ] as any
    });

    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });
});
