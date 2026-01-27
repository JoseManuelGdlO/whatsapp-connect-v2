import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalKeyStore } from '@whiskeysockets/baileys';

import { prisma } from '../lib/prisma.js';
import { decryptString, encryptString } from '../lib/crypto.js';

type StoredKeyData = Record<string, Record<string, any>>;

function makeKeyStore(data: StoredKeyData, onUpdate?: () => void): SignalKeyStore {
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
      let hasChanges = false;
      for (const [type, entries] of Object.entries(update)) {
        data[type] ||= {};
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value == null) {
            if (data[type]![id] != null) {
              delete data[type]![id];
              hasChanges = true;
            }
          } else {
            if (JSON.stringify(data[type]![id]) !== JSON.stringify(value)) {
              data[type]![id] = value;
              hasChanges = true;
            }
          }
        }
      }
      // Trigger save when keys are updated (debounced save will handle it)
      if (hasChanges && onUpdate) {
        onUpdate();
      }
    }
  };
}

export async function loadAuthState(deviceId: string): Promise<{
  state: AuthenticationState;
  save: () => Promise<void>;
  clearCorruptedSessions: () => Promise<void>;
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

  let savePending = false;
  let saveTimeout: NodeJS.Timeout | null = null;

  const triggerSave = () => {
    // Debounce saves to avoid too frequent DB writes
    if (savePending) return;
    
    savePending = true;
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    
    saveTimeout = setTimeout(async () => {
      try {
        const payload = JSON.stringify({ creds: state.creds, keysData }, BufferJSON.replacer);
        const authStateEnc = encryptString(payload);
        await prisma.waSession.upsert({
          where: { deviceId },
          create: { deviceId, authStateEnc },
          update: { authStateEnc }
        });
      } catch (err) {
        // Log but don't throw - saving is best effort
        console.error(`[authStateDb] Failed to save state for ${deviceId}:`, err);
      } finally {
        savePending = false;
        saveTimeout = null;
      }
    }, 2000); // Save after 2 seconds of inactivity
  };

  const state: AuthenticationState = {
    creds,
    keys: makeKeyStore(keysData, triggerSave) // Pass callback to trigger save on key updates
  };

  const save = async () => {
    triggerSave();
  };

  // Force immediate save (for critical updates like creds.update)
  const saveImmediate = async () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    savePending = false;
    try {
      const payload = JSON.stringify({ creds: state.creds, keysData }, BufferJSON.replacer);
      const authStateEnc = encryptString(payload);
      await prisma.waSession.upsert({
        where: { deviceId },
        create: { deviceId, authStateEnc },
        update: { authStateEnc }
      });
    } catch (err) {
      console.error(`[authStateDb] Failed to save state immediately for ${deviceId}:`, err);
      throw err;
    }
  };

  // Function to clear corrupted session keys when sync error occurs
  const clearCorruptedSessions = async () => {
    try {
      // Clear session-related keys that might be corrupted
      // This includes 'sessions', 'sender-key', and 'sender-key-memory'
      const keysToClear = ['sessions', 'sender-key', 'sender-key-memory'];
      for (const keyType of keysToClear) {
        if (keysData[keyType]) {
          delete keysData[keyType];
        }
      }
      // Save the cleaned state
      await saveImmediate();
    } catch (err) {
      console.error(`[authStateDb] Failed to clear corrupted sessions for ${deviceId}:`, err);
    }
  };

  // Wrap save to provide both debounced and immediate versions
  const saveWrapper = async () => {
    await save();
  };
  (saveWrapper as any).immediate = saveImmediate;

  return { state, save: saveWrapper, clearCorruptedSessions };
}

