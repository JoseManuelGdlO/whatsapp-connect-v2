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
    expect(normalized.adContext).toBeNull();
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
    expect(normalized.adContext).toBeNull();
  });

  it('extrae adContext de externalAdReply CTWA', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: null,
      message: {
        key: {
          id: 'm-ad-1',
          remoteJid: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: {
          extendedTextMessage: {
            text: 'Hola! Quiero más información',
            contextInfo: {
              externalAdReply: {
                title: 'Nissan Versa 2020',
                body: 'Estas vacaciones merecen un Versa listo para entregar',
                sourceType: 'ad',
                sourceId: 'ad-123',
                sourceUrl: 'https://fb.me/ad',
                sourceApp: 'facebook',
                ctwaClid: 'clid-abc',
                mediaUrl: 'https://cdn.example/ad.jpg',
                showAdAttribution: true,
                greetingMessageBody: 'Hola! Quiero más información'
              }
            }
          }
        }
      }
    });

    expect(normalized.content.text).toBe('Hola! Quiero más información');
    expect(normalized.adContext).toEqual({
      isAd: true,
      title: 'Nissan Versa 2020',
      body: 'Estas vacaciones merecen un Versa listo para entregar',
      sourceId: 'ad-123',
      sourceUrl: 'https://fb.me/ad',
      sourceApp: 'facebook',
      ctwaClid: 'clid-abc',
      mediaUrl: 'https://cdn.example/ad.jpg',
      greetingMessageBody: 'Hola! Quiero más información'
    });
  });

  it('no inventa adContext en mensajes normales con texto comercial', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: null,
      message: {
        key: {
          id: 'm-no-ad',
          remoteJid: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: { conversation: 'Quiero info del Nissan Versa 2020' }
      }
    });

    expect(normalized.adContext).toBeNull();
  });

  it('no marca adContext en preview de link (solo title/body/url)', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: null,
      message: {
        key: {
          id: 'm-link-preview',
          remoteJid: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: {
          extendedTextMessage: {
            text: 'mira este auto https://example.com/versa',
            contextInfo: {
              externalAdReply: {
                title: 'Nissan Versa 2020',
                body: 'Ficha del Versa en stock',
                sourceUrl: 'https://example.com/versa',
                mediaUrl: 'https://cdn.example/preview.jpg'
              }
            }
          }
        }
      }
    });

    expect(normalized.adContext).toBeNull();
  });

  it('detecta CTWA por entryPointConversionSource sin externalAdReply', () => {
    const normalized = normalizeInboundMessage({
      deviceJid: null,
      message: {
        key: {
          id: 'm-ctwa-entry',
          remoteJid: '5216183610698@s.whatsapp.net',
          fromMe: false
        } as TestMessageKey,
        message: {
          extendedTextMessage: {
            text: 'Hola! Quiero más información',
            contextInfo: {
              entryPointConversionSource: 'ctwa_ad',
              conversionSource: 'FB_Ads',
              entryPointConversionApp: 'instagram'
            }
          }
        }
      }
    });

    expect(normalized.adContext).toEqual({
      isAd: true,
      title: null,
      body: null,
      sourceId: null,
      sourceUrl: null,
      sourceApp: 'instagram',
      ctwaClid: null,
      mediaUrl: null,
      greetingMessageBody: null
    });
  });
});
