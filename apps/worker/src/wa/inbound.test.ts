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
});
