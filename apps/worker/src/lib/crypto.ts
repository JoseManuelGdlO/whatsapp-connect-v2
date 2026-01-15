import crypto from 'crypto';

function getKey(): Buffer {
  const b64 = process.env.WA_AUTH_ENC_KEY_B64;
  if (!b64) throw new Error('WA_AUTH_ENC_KEY_B64 is required');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('WA_AUTH_ENC_KEY_B64 must decode to 32 bytes');
  return key;
}

export function assertCryptoKeyConfigured() {
  // will throw if invalid
  getKey();
}

export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptString(enc: string): string {
  const [v, ivB64, tagB64, ctB64] = enc.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Invalid encrypted payload');
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

