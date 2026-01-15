import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalKeyStore } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { decryptString, encryptString } from '../lib/crypto.js';

type StoredKeyData = Record<string, Record<string, any>>;

function makeKeyStore(data: StoredKeyData): SignalKeyStore {
  return {
    get: async (type, ids) => {
      const bucket = data[type] ?? {};
      const out: Record<string, any> = {};
      for (const id of ids) {
        if (bucket[id] != null) out[id] = bucket[id];
      }
      return out;
    },
    set: async (update) => {
      for (const [type, entries] of Object.entries(update)) {
        data[type] ||= {};
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value == null) delete data[type]![id];
          else data[type]![id] = value;
        }
      }
    }
  };
}

export async function loadAuthState(deviceId: string): Promise<{
  state: AuthenticationState;
  save: () => Promise<void>;
}> {
  const existing = await prisma.waSession.findUnique({ where: { deviceId } });

  let creds = initAuthCreds();
  const keysData: StoredKeyData = {};

  if (existing?.authStateEnc) {
    try {
      const plaintext = decryptString(existing.authStateEnc);
      const parsed = JSON.parse(plaintext, BufferJSON.reviver) as { creds: any; keysData: StoredKeyData };
      creds = parsed.creds;
      for (const [k, v] of Object.entries(parsed.keysData ?? {})) keysData[k] = v as any;
    } catch {
      // if decrypt/parse fails, start fresh
    }
  }

  const state: AuthenticationState = {
    creds,
    keys: makeKeyStore(keysData)
  };

  const save = async () => {
    const payload = JSON.stringify({ creds: state.creds, keysData }, BufferJSON.replacer);
    const authStateEnc = encryptString(payload);
    await prisma.waSession.upsert({
      where: { deviceId },
      create: { deviceId, authStateEnc },
      update: { authStateEnc }
    });
  };

  return { state, save };
}

