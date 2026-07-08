import { describe, expect, it } from 'vitest';
import { formatPairingCode, sanitizePairingPhone } from './pairingPhone.js';

describe('sanitizePairingPhone', () => {
  it('normaliza número con símbolos', () => {
    expect(sanitizePairingPhone('+52 1 55 1234 5678')).toBe('5215512345678');
  });

  it('acepta solo dígitos', () => {
    expect(sanitizePairingPhone('5215512345678')).toBe('5215512345678');
  });

  it('rechaza vacío', () => {
    expect(sanitizePairingPhone('')).toBeNull();
  });

  it('rechaza solo símbolos', () => {
    expect(sanitizePairingPhone('+-() ')).toBeNull();
  });

  it('rechaza menos de 10 dígitos', () => {
    expect(sanitizePairingPhone('123456789')).toBeNull();
  });
});

describe('formatPairingCode', () => {
  it('inserta guión después del 4º carácter', () => {
    expect(formatPairingCode('ABCD1234')).toBe('ABCD-1234');
  });
});
