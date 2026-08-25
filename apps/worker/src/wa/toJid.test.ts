import { describe, expect, it } from 'vitest';
import { toJid } from './toJid.js';

describe('toJid', () => {
  it('antepone 521 a numeros mexicanos de 10 digitos', () => {
    expect(toJid('6181020927')).toBe('5216181020927@s.whatsapp.net');
    expect(toJid('6181020927@s.whatsapp.net')).toBe('5216181020927@s.whatsapp.net');
  });

  it('inserta el 1 movil cuando llega 52 + 10 digitos', () => {
    expect(toJid('526181556489@s.whatsapp.net')).toBe('5216181556489@s.whatsapp.net');
  });

  it('deja intactos JIDs mexicanos ya correctos', () => {
    expect(toJid('5216181556489@s.whatsapp.net')).toBe('5216181556489@s.whatsapp.net');
  });

  it('no altera LID ni status broadcast', () => {
    expect(toJid('60911863783463@lid')).toBe('60911863783463@lid');
    expect(toJid('status@broadcast')).toBe('status@broadcast');
  });
});
