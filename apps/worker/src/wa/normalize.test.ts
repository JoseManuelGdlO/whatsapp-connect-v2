import { describe, expect, it } from 'vitest';

import { normalizeInboundMessage, phoneDigitsFromPnJid, resolveFromPhone } from './normalize.js';

describe('phoneDigitsFromPnJid', () => {
  it('extrae dígitos de un JID PN', () => {
    expect(phoneDigitsFromPnJid('5216183610698@s.whatsapp.net')).toBe('5216183610698');
  });

  it('ignora JIDs que no son PN', () => {
    expect(phoneDigitsFromPnJid('60911863783463@lid')).toBeNull();
  });
});

describe('resolveFromPhone', () => {
  it('usa senderPn cuando from es LID', () => {
    expect(
      resolveFromPhone(
        {
          remoteJid: '60911863783463@lid',
          senderPn: '5216183610698@s.whatsapp.net'
        },
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
        },
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
        },
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
        },
        message: { conversation: 'hola' }
      }
    });

    expect(normalized.from).toBe('5216183610698@s.whatsapp.net');
    expect(normalized.fromPhone).toBe('5216183610698');
  });
});
