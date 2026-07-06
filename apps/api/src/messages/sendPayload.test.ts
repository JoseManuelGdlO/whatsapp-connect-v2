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
});
