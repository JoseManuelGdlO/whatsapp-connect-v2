import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from './crypto.js';

function setValidCryptoKey() {
  process.env.WA_AUTH_ENC_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
}

describe('crypto', () => {
  it('cifra y descifra un texto simple', () => {
    setValidCryptoKey();
    const plaintext = 'hola mundo';
    const encrypted = encryptString(plaintext);

    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptString(encrypted)).toBe(plaintext);
  });

  it('usa IV aleatorio y soporta muchas rondas seguidas', () => {
    setValidCryptoKey();
    const ciphertexts = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      const plaintext = `payload-${i}-${Math.random()}`;
      const encrypted = encryptString(plaintext);
      const decrypted = decryptString(encrypted);
      expect(decrypted).toBe(plaintext);
      ciphertexts.add(encrypted);
    }

    // Con IV aleatorio no deberían repetirse cifrados en este volumen.
    expect(ciphertexts.size).toBe(1000);
  });
});
