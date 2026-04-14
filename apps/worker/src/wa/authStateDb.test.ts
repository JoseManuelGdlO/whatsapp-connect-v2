import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '../lib/crypto.js';

type SessionRow = { deviceId: string; authStateEnc: string };

const sessionStore = new Map<string, SessionRow>();

vi.mock('../lib/prisma.js', () => {
  return {
    prisma: {
      waSession: {
        findUnique: vi.fn(async ({ where }: { where: { deviceId: string } }) => {
          return sessionStore.get(where.deviceId) ?? null;
        }),
        upsert: vi.fn(
          async ({
            where,
            create,
            update
          }: {
            where: { deviceId: string };
            create: SessionRow;
            update: { authStateEnc: string };
          }) => {
            const existing = sessionStore.get(where.deviceId);
            const row: SessionRow = existing
              ? { ...existing, authStateEnc: update.authStateEnc }
              : { deviceId: create.deviceId, authStateEnc: create.authStateEnc };
            sessionStore.set(where.deviceId, row);
            return row;
          }
        )
      }
    }
  };
});

describe('authStateDb', () => {
  beforeEach(() => {
    process.env.WA_AUTH_ENC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
    sessionStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('guarda authState cifrado y lo recupera descifrado', async () => {
    vi.useFakeTimers();
    const { loadAuthState } = await import('./authStateDb.js');

    const deviceId = 'device-1';
    const loaded = await loadAuthState(deviceId);

    await loaded.state.keys.set({
      session: {
        '5216183610698@s.whatsapp.net': { chainKey: { counter: 1 } }
      }
    });

    await loaded.save();
    await vi.advanceTimersByTimeAsync(2500);

    const persisted = sessionStore.get(deviceId);
    expect(persisted).toBeDefined();
    expect(persisted?.authStateEnc.startsWith('v1:')).toBe(true);
    expect(persisted?.authStateEnc).not.toContain('5216183610698@s.whatsapp.net');

    const reloaded = await loadAuthState(deviceId);
    const keys = await reloaded.state.keys.get('session', ['5216183610698@s.whatsapp.net']);
    expect(keys['5216183610698@s.whatsapp.net']).toBeDefined();
  });

  it('mantiene estable el ciclo guardar/cargar en múltiples rondas', async () => {
    vi.useFakeTimers();
    const { loadAuthState } = await import('./authStateDb.js');

    const deviceId = 'device-stress';
    for (let i = 0; i < 100; i += 1) {
      const loaded = await loadAuthState(deviceId);
      const jid = `52${i}@s.whatsapp.net`;
      await loaded.state.keys.set({
        session: {
          [jid]: { chainKey: { counter: i } }
        }
      });
      await loaded.save();
      await vi.advanceTimersByTimeAsync(2500);

      const reloaded = await loadAuthState(deviceId);
      const keys = await reloaded.state.keys.get('session', [jid]);
      expect(keys[jid]).toBeDefined();
    }
  });

  it('si authStateEnc está corrupto inicia un estado limpio sin romper', async () => {
    const { loadAuthState } = await import('./authStateDb.js');

    const deviceId = 'device-corrupt';
    sessionStore.set(deviceId, {
      deviceId,
      authStateEnc: 'v1:not-valid:payload'
    });

    const loaded = await loadAuthState(deviceId);
    const keys = await loaded.state.keys.get('session', ['999@s.whatsapp.net']);
    expect(keys['999@s.whatsapp.net']).toBeUndefined();
  });

  it('si cambia la llave de cifrado no reutiliza estado previo y arranca limpio', async () => {
    const { loadAuthState } = await import('./authStateDb.js');
    const deviceId = 'device-key-rotation';

    process.env.WA_AUTH_ENC_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
    const payload = JSON.stringify({
      creds: { noiseKey: { private: 'x' } },
      keysData: { session: { 'abc@s.whatsapp.net': { chainKey: { counter: 7 } } } }
    });
    sessionStore.set(deviceId, { deviceId, authStateEnc: encryptString(payload) });

    // Simula despliegue con llave distinta: debe fallar decrypt y usar estado nuevo.
    process.env.WA_AUTH_ENC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');
    const loaded = await loadAuthState(deviceId);
    const keys = await loaded.state.keys.get('session', ['abc@s.whatsapp.net']);
    expect(keys['abc@s.whatsapp.net']).toBeUndefined();
  });
});
