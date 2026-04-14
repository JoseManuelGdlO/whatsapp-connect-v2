import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handlersBySocket: Array<Record<string, Array<(...args: any[]) => any>>> = [];
  const sockets: Array<{ end: ReturnType<typeof vi.fn> }> = [];

  const makeSocket = () => {
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const socket = {
      user: { id: 'me@s.whatsapp.net' },
      ev: {
        on: (event: string, cb: (...args: any[]) => any) => {
          handlers[event] ||= [];
          handlers[event].push(cb);
        }
      },
      end: vi.fn()
    };
    handlersBySocket.push(handlers);
    sockets.push(socket);
    return socket as any;
  };

  return {
    makeSocket,
    handlersBySocket,
    sockets,
    loadAuthStateMock: vi.fn(),
    handleMessagesUpsertMock: vi.fn(),
    clearCorruptedSessionsMock: vi.fn(async () => {}),
    clearSenderSessionsInMemoryMock: vi.fn(),
    saveMock: vi.fn(async () => {}),
    saveImmediateMock: vi.fn(async () => {}),
    prismaDeviceUpdateMock: vi.fn(async () => ({}))
  };
});

vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: vi.fn(() => hoisted.makeSocket()),
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] }))
  };
});

vi.mock('./authStateDb.js', () => {
  return {
    loadAuthState: hoisted.loadAuthStateMock
  };
});

vi.mock('./inbound.js', () => {
  return {
    handleMessagesUpsert: hoisted.handleMessagesUpsertMock
  };
});

vi.mock('../lib/prisma.js', () => {
  return {
    prisma: {
      device: {
        update: hoisted.prismaDeviceUpdateMock,
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id,
          tenantId: 'tenant-1',
          label: 'Device 1'
        }))
      },
      publicQrLink: {
        updateMany: vi.fn(async () => ({}))
      },
      event: {
        findMany: vi.fn(async () => [])
      }
    }
  };
});

vi.mock('@wc/logger', () => {
  return {
    createLogger: vi.fn(() => ({
      warn: vi.fn(async () => {}),
      info: vi.fn(async () => {}),
      error: vi.fn(async () => {})
    }))
  };
});

vi.mock('@wc/alert', () => {
  return {
    sendDeviceDisconnectAlert: vi.fn(async () => {})
  };
});

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hoisted.handlersBySocket.length = 0;
    hoisted.sockets.length = 0;

    hoisted.saveMock.mockImplementation(async () => {});
    hoisted.saveImmediateMock.mockImplementation(async () => {});
    (hoisted.saveMock as any).immediate = hoisted.saveImmediateMock;
    hoisted.loadAuthStateMock.mockImplementation(async () => ({
      state: { creds: {}, keys: { get: vi.fn(), set: vi.fn() } },
      save: hoisted.saveMock,
      clearCorruptedSessions: hoisted.clearCorruptedSessionsMock,
      clearSenderSessionsInMemory: hoisted.clearSenderSessionsInMemoryMock
    }));
  });

  it('aplica debounce para clearSenderAndReconnect', async () => {
    hoisted.handleMessagesUpsertMock.mockResolvedValue({
      clearSenderAndReconnect: {
        remoteJid: '5216183610698@s.whatsapp.net',
        senderPn: '5216183610698@s.whatsapp.net'
      }
    });

    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-debounce');

    const handlers = hoisted.handlersBySocket[0];
    expect(handlers).toBeDefined();
    const onMessagesUpsert = handlers['messages.upsert']?.[0];
    expect(onMessagesUpsert).toBeDefined();

    await onMessagesUpsert?.({ messages: [{ key: { id: 'm1' } }] });
    await onMessagesUpsert?.({ messages: [{ key: { id: 'm2' } }] });

    expect(hoisted.clearSenderSessionsInMemoryMock).toHaveBeenCalledTimes(1);
    expect(hoisted.saveImmediateMock).toHaveBeenCalledTimes(1);
  });

  it('limpia sesiones corruptas y reintenta conexión en session sync error', async () => {
    hoisted.handleMessagesUpsertMock.mockRejectedValue(new Error('Failed to decrypt message (Bad MAC)'));

    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-sync-error');

    const handlers = hoisted.handlersBySocket[0];
    const onMessagesUpsert = handlers['messages.upsert']?.[0];
    expect(onMessagesUpsert).toBeDefined();

    await onMessagesUpsert?.({ messages: [{ key: { id: 'm1' } }] });

    expect(hoisted.clearCorruptedSessionsMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sockets[0].end).toHaveBeenCalledTimes(1);

    // Debe programar reconexión a 5s tras limpiar estado.
    await vi.advanceTimersByTimeAsync(5000);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(2);
  });
});
