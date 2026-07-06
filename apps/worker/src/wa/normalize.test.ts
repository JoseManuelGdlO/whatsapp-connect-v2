import { describe, expect, it } from 'vitest';
import type { proto } from '@whiskeysockets/baileys';

import { normalizeInboundMessage, phoneDigitsFromPnJid, resolveFromPhone } from './normalize.js';

/** Baileys v7 message keys may include PN fields not yet on IMessageKey. */
type TestMessageKey = proto.IMessageKey & {
  senderPn?: string;
  remoteJidAlt?: string;
  participantAlt?: string;
};

describe('phoneDigitsFromPnJid', () => {
  it('extrae dígitos de un JID PN', () => {
    expect(phoneDigitsFromPnJid('5216183610698@s.whatsapp.net')).toBe('5216183610698');
  });

  it('ignora JIDs que no son PN', () => {
    expect(phoneDigitsFromPnJid('60911863783463@lid')).toBeNull();
  });

  it('ignora el sufijo :device en JIDs multi-device', () => {
    expect(phoneDigitsFromPnJid('5216182327598:22@s.whatsapp.net')).toBe('5216182327598');
  });
});

describe('resolveFromPhone', () => {
  it('usa senderPn cuando from es LID', () => {
    expect(
      resolveFromPhone(
        {
          remoteJid: '60911863783463@lid',
          senderPn: '5216183610698@s.whatsapp.net'
        } as TestMessageKey,
        '60911863783463@lid'
      )
    ).toBe('5216183610698');
  });

  it('usa remoteJidAlt si no hay senderPn', () => {
    expect(
      resolveFromPhone(
        {
          remoteJid: '60911863783463@lid',
          remoteJidAlt: '5216183610698@s.whatsapp.net'
        } as TestMessageKey,
        '60911863783463@lid'
      )
    ).toBe('5216183610698');
  });

  it('devuelve null si solo hay LID sin fuentes PN', () => {
    expect(resolveFromPhone({ remoteJid: '60911863783463@lid' }, '60911863783463@lid')).toBeNull();
  });
});

describe('normalizeInboundMessage', () => {
  it('mantiene from en LID y agrega fromPhone para display', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: '5490000000000@s.whatsapp.net',
      message: {
        key: {
          id: 'm-1',
          remoteJid: '60911863783463@lid',
          senderPn: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: { conversation: 'hola' },
        messageTimestamp: 1736900000
      }
    });

    expect(normalized.from).toBe('60911863783463@lid');
    expect(normalized.fromPhone).toBe('5216183610698');
  });

  it('rellena fromPhone en chats PN clásicos', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: null,
      message: {
        key: {
          id: 'm-2',
          remoteJid: '5216183610698@s.whatsapp.net',
          senderPn: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: { conversation: 'hola' }
      }
    });

    expect(normalized.from).toBe('5216183610698@s.whatsapp.net');
    expect(normalized.fromPhone).toBe('5216183610698');
  });
});
