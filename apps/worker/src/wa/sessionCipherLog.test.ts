import { describe, expect, it } from 'vitest';
import { installSessionCipherLogFilter } from './sessionCipherLog.js';

describe('installSessionCipherLogFilter', () => {
  it('omite logs de Closing session que exponen claves', () => {
    const captured: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args);
    };
    const restore = installSessionCipherLogFilter();
    try {
      console.log('Closing session: SessionEntry { privKey: secret }');
      console.log('mensaje normal');
      expect(captured.some((args) => String(args[0]).startsWith('Closing session'))).toBe(false);
      expect(captured.some((args) => args[0] === 'mensaje normal')).toBe(true);
    } finally {
      restore();
      console.log = original;
    }
  });
});
