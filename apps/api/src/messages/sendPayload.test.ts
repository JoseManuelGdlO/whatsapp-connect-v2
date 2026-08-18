import { describe, expect, it } from 'vitest';
import { sendMessageBodySchema } from './sendPayload.js';

describe('sendMessageBodySchema', () => {
  it('acepta payload legacy de texto sin type', () => {
    const parsed = sendMessageBodySchema.parse({
      to: '5216183610698@s.whatsapp.net',
      text: 'hola'
    });

    expect(parsed.type).toBe('text');
    if (parsed.type !== 'text') throw new Error('Expected text payload');
    expect(parsed.text).toBe('hola');
  });

  it('acepta payload de imagen con caption opcional', () => {
    const parsed = sendMessageBodySchema.parse({
      to: '5216183610698@s.whatsapp.net',
      type: 'image',
      imageUrl: 'https://example.com/a.png',
      caption: 'Imagen del vehiculo'
    });

    expect(parsed.type).toBe('image');
    if (parsed.type !== 'image') throw new Error('Expected image payload');
    expect(parsed.imageUrl).toContain('example.com');
  });

  it('rechaza imageUrl no http/https', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        to: '5216183610698@s.whatsapp.net',
        type: 'image',
        imageUrl: 'file:///tmp/a.png'
      })
    ).toThrow();
  });

  it('acepta payload de documento PDF con caption opcional', () => {
    const parsed = sendMessageBodySchema.parse({
      to: '5216183610698@s.whatsapp.net',
      type: 'document',
      documentUrl: 'https://example.com/cotizacion.pdf',
      fileName: 'cotizacion.pdf',
      caption: 'Tu cotizacion'
    });

    expect(parsed.type).toBe('document');
    if (parsed.type !== 'document') throw new Error('Expected document payload');
    expect(parsed.documentUrl).toContain('example.com');
    expect(parsed.fileName).toBe('cotizacion.pdf');
  });

  it('acepta payload de documento sin fileName ni caption', () => {
    const parsed = sendMessageBodySchema.parse({
      to: '5216183610698@s.whatsapp.net',
      type: 'document',
      documentUrl: 'https://example.com/doc.pdf'
    });

    expect(parsed.type).toBe('document');
    if (parsed.type !== 'document') throw new Error('Expected document payload');
    expect(parsed.fileName).toBeUndefined();
  });

  it('rechaza documentUrl no http/https', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        to: '5216183610698@s.whatsapp.net',
        type: 'document',
        documentUrl: 'file:///tmp/doc.pdf'
      })
    ).toThrow();
  });

  it('rechaza fileName sin extension .pdf', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        to: '5216183610698@s.whatsapp.net',
        type: 'document',
        documentUrl: 'https://example.com/doc.pdf',
        fileName: 'cotizacion.docx'
      })
    ).toThrow();
  });

  it('acepta status_image con statusJidList y caption opcional', () => {
    const parsed = sendMessageBodySchema.parse({
      type: 'status_image',
      imageUrl: 'https://cdn.cliente.com/estado.jpg',
      caption: 'Texto del estado',
      statusJidList: ['5216181234567@s.whatsapp.net', '123456789012345@lid']
    });

    expect(parsed.type).toBe('status_image');
    if (parsed.type !== 'status_image') throw new Error('Expected status_image payload');
    expect(parsed.imageUrl).toContain('cdn.cliente.com');
    expect(parsed.statusJidList).toHaveLength(2);
    expect(parsed.caption).toBe('Texto del estado');
  });

  it('rechaza status_image con statusJidList vacio', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        type: 'status_image',
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        statusJidList: []
      })
    ).toThrow();
  });

  it('rechaza status_image con imageUrl no http/https', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        type: 'status_image',
        imageUrl: 'file:///tmp/estado.jpg',
        statusJidList: ['5216181234567@s.whatsapp.net']
      })
    ).toThrow();
  });

  it('rechaza status_image con mas de 500 jids', () => {
    expect(() =>
      sendMessageBodySchema.parse({
        type: 'status_image',
        imageUrl: 'https://cdn.cliente.com/estado.jpg',
        statusJidList: Array.from({ length: 501 }, (_, i) => `${5216000000000 + i}@s.whatsapp.net`)
      })
    ).toThrow();
  });
});
