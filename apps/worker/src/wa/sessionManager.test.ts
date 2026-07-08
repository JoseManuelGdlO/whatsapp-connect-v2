import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handlersBySocket: Array<Record<string, Array<(...args: any[]) => any>>> = [];
  const sockets: Array<{ end: ReturnType<typeof vi.fn>; requestPairingCode: ReturnType<typeof vi.fn> }> = [];

  const makeSocket = () => {
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const requestPairingCode = vi.fn(async () => 'ABCD1234');
    const socket = {
      user: { id: '5216183610698@s.whatsapp.net' },
      authState: { creds: { registered: false } },
      requestPairingCode,
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
    requestPairingCodeMock: () => sockets[sockets.length - 1]?.requestPairingCode as ReturnType<typeof vi.fn>,
    loadAuthStateMock: vi.fn(),
    handleMessagesUpsertMock: vi.fn(),
    clearCorruptedSessionsMock: vi.fn(async () => {}),
    clearSenderSessionsInMemoryMock: vi.fn(),
    saveMock: vi.fn(async () => {}),
    saveImmediateMock: vi.fn(async () => {}),
    prismaDeviceUpdateMock: vi.fn(async () => ({})),
    prismaDeviceFindUniqueMock: vi.fn(async ({ where }: any): Promise<{
      id: string;
      tenantId: string;
      label: string;
      phoneHint: string | null;
    }> => ({
      id: where.id,
      tenantId: 'tenant-1',
      label: 'Device 1',
      phoneHint: null
    }))
  };
});

vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: vi.fn((opts?: { auth?: { creds?: { registered?: boolean } } }) => {
      const socket = hoisted.makeSocket();
      if (opts?.auth?.creds) {
        socket.authState.creds = {
          registered: opts.auth.creds.registered ?? false
        };
      }
      return socket;
    }),
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
        findUnique: hoisted.prismaDeviceFindUniqueMock
      },
      publicQrLink: {
        updateMany: vi.fn(async () => ({}))
      },
      event: {
        findMany: vi.fn(async () => [])
      },
      waSession: {
        findUnique: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ count: 0 }))
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
      state: { creds: { registered: false }, keys: { get: vi.fn(), set: vi.fn() } },
      save: hoisted.saveMock,
      clearCorruptedSessions: hoisted.clearCorruptedSessionsMock,
      clearSenderSessionsInMemory: hoisted.clearSenderSessionsInMemoryMock
    }));
    hoisted.prismaDeviceFindUniqueMock.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      tenantId: 'tenant-1',
      label: 'Device 1',
      phoneHint: null
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

  it('aplica backoff exponencial cuando hay cierres consecutivos de conexión', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-reconnect-backoff');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 }, message: 'closed' } }
    });

    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(2);

    const handlersSecondSocket = hoisted.handlersBySocket[1];
    const onConnectionUpdateSecondSocket = handlersSecondSocket['connection.update']?.[0];
    expect(onConnectionUpdateSecondSocket).toBeDefined();

    await onConnectionUpdateSecondSocket?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 }, message: 'closed-again' } }
    });

    await vi.advanceTimersByTimeAsync(9999);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(3);
  });

  it('no reconecta cuando el cierre es loggedOut', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-logged-out');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged-out' } }
    });

    await vi.advanceTimersByTimeAsync(60000);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(1);
    expect(manager.get('device-logged-out')).toBeNull();
  });

  it('no reconecta cuando loggedOut viene en error.data', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-logged-out-data');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({
      connection: 'close',
      lastDisconnect: { error: { data: 401, message: 'logged-out-data' } }
    });

    await vi.advanceTimersByTimeAsync(60000);
    expect(hoisted.loadAuthStateMock).toHaveBeenCalledTimes(1);
    expect(manager.get('device-logged-out-data')).toBeNull();
  });

  it('guarda phoneHint al abrir conexión cuando aún no existe', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-phone-hint');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({ connection: 'open' });

    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-phone-hint' },
        data: expect.objectContaining({
          status: 'ONLINE',
          phoneHint: '5216183610698'
        })
      })
    );
  });

  it('no reescribe phoneHint si ya coincide con el número conectado', async () => {
    hoisted.prismaDeviceFindUniqueMock.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      tenantId: 'tenant-1',
      label: 'Device 1',
      phoneHint: '5216183610698'
    }));

    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-phone-hint-same');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({ connection: 'open' });

    const wrotePhoneHintOnOpen = (
      hoisted.prismaDeviceUpdateMock.mock.calls as unknown as Array<
        [{ data?: { status?: string; phoneHint?: string } }]
      >
    ).some((call) => {
      const data = call[0]?.data;
      return data?.status === 'ONLINE' && data.phoneHint !== undefined;
    });
    expect(wrotePhoneHintOnOpen).toBe(false);
  });

  it('backfill phoneHint desde sesiones activas sin esperar reconexión', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-backfill');

    hoisted.prismaDeviceUpdateMock.mockClear();
    await manager.syncPhoneHintsForActiveSessions();

    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith({
      where: { id: 'device-backfill' },
      data: { phoneHint: '5216183610698' }
    });
  });

  it('genera QR y pairingCode cuando hay phoneNumber', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-pairing', { phoneNumber: '5215512345678' });

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    expect(onConnectionUpdate).toBeDefined();

    await onConnectionUpdate?.({ qr: 'qr-payload' });

    expect(hoisted.requestPairingCodeMock()).toHaveBeenCalledWith('5215512345678');
    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-pairing' },
        data: expect.objectContaining({ status: 'QR', qr: 'qr-payload' })
      })
    );
    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-pairing' },
        data: expect.objectContaining({ status: 'QR', pairingCode: 'ABCD1234' })
      })
    );
  });

  it('solo genera QR si no hay phoneNumber', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-qr-only');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    await onConnectionUpdate?.({ qr: 'qr-payload' });

    expect(hoisted.requestPairingCodeMock()).not.toHaveBeenCalled();
    const wrotePairingCode = (
      hoisted.prismaDeviceUpdateMock.mock.calls as unknown as Array<[{ data?: { pairingCode?: string | null } }]>
    ).some((call) => typeof call[0]?.data?.pairingCode === 'string');
    expect(wrotePairingCode).toBe(false);
  });

  it('limpia pairingCode al abrir conexión', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-pairing-open');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    await onConnectionUpdate?.({ connection: 'open' });

    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-pairing-open' },
        data: expect.objectContaining({
          status: 'ONLINE',
          qr: null,
          pairingCode: null
        })
      })
    );
  });

  it('limpia pairingCode cuando falla requestPairingCode', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-pairing-fail', { phoneNumber: '5215512345678' });

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    hoisted.requestPairingCodeMock().mockRejectedValueOnce(new Error('rate limited'));

    await onConnectionUpdate?.({ qr: 'qr-payload' });

    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-pairing-fail' },
        data: expect.objectContaining({
          pairingCode: null,
          lastError: 'pairing_code_error: rate limited'
        })
      })
    );
  });

  it('no pide código si creds.registered', async () => {
    hoisted.loadAuthStateMock.mockImplementation(async () => ({
      state: { creds: { registered: true }, keys: { get: vi.fn(), set: vi.fn() } },
      save: hoisted.saveMock,
      clearCorruptedSessions: hoisted.clearCorruptedSessionsMock,
      clearSenderSessionsInMemory: hoisted.clearSenderSessionsInMemoryMock
    }));

    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-registered', { phoneNumber: '5215512345678' });

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    await onConnectionUpdate?.({ qr: 'qr-payload' });

    expect(hoisted.requestPairingCodeMock()).not.toHaveBeenCalled();
  });

  it('pide código en sesión existente si Connect se vuelve a llamar con teléfono', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-late-phone');

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    await onConnectionUpdate?.({ qr: 'qr-payload' });
    expect(hoisted.requestPairingCodeMock()).not.toHaveBeenCalled();

    await manager.connect('device-late-phone', { phoneNumber: '5215512345678' });

    expect(hoisted.requestPairingCodeMock()).toHaveBeenCalledWith('5215512345678');
    expect(hoisted.prismaDeviceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'device-late-phone' },
        data: expect.objectContaining({ status: 'QR', pairingCode: 'ABCD1234' })
      })
    );
    // Must not open a second socket
    expect(hoisted.handlersBySocket.length).toBe(1);
  });

  it('no pide código en connecting (solo tras evento qr)', async () => {
    const { SessionManager } = await import('./sessionManager.js');
    const manager = new SessionManager();
    await manager.connect('device-connecting-only', { phoneNumber: '5215512345678' });

    const handlers = hoisted.handlersBySocket[0];
    const onConnectionUpdate = handlers['connection.update']?.[0];
    await onConnectionUpdate?.({ connection: 'connecting' });

    expect(hoisted.requestPairingCodeMock()).not.toHaveBeenCalled();
  });
});
