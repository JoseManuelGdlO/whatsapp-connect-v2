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
});
