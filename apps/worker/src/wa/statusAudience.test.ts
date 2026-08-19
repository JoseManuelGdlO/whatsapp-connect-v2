import { describe, expect, it } from 'vitest';

import { normalizeUserJid, ownJidForStatusAudience, withOwnStatusJid } from './statusAudience.js';

const user = {
  id: '5216184487125:4@s.whatsapp.net',
  lid: '15325181567089:4@lid'
};

describe('normalizeUserJid', () => {
  it('quita el sufijo de dispositivo', () => {
    expect(normalizeUserJid('5216184487125:4@s.whatsapp.net')).toBe('5216184487125@s.whatsapp.net');
    expect(normalizeUserJid('15325181567089:4@lid')).toBe('15325181567089@lid');
  });

  it('deja un JID ya normalizado', () => {
    expect(normalizeUserJid('5216184487125@s.whatsapp.net')).toBe('5216184487125@s.whatsapp.net');
  });
});

describe('ownJidForStatusAudience', () => {
  it('usa PN propio si la audiencia es PN', () => {
    expect(ownJidForStatusAudience(['5216181234567@s.whatsapp.net'], user)).toBe('5216184487125@s.whatsapp.net');
  });

  it('usa LID propio si la audiencia es LID', () => {
    expect(ownJidForStatusAudience(['60911863783463@lid'], user)).toBe('15325181567089@lid');
  });

  it('en empate PN/LID usa PN para no introducir un segundo LID', () => {
    expect(
      ownJidForStatusAudience(['5216181234567@s.whatsapp.net', '60911863783463@lid'], user)
    ).toBe('5216184487125@s.whatsapp.net');
  });
});

describe('withOwnStatusJid', () => {
  it('hace append del JID propio', () => {
    expect(withOwnStatusJid(['5216181234567@s.whatsapp.net'], user)).toEqual([
      '5216181234567@s.whatsapp.net',
      '5216184487125@s.whatsapp.net'
    ]);
  });

  it('no duplica si el propio ya esta (con o sin sufijo de device)', () => {
    expect(withOwnStatusJid(['5216184487125:4@s.whatsapp.net'], user)).toEqual(['5216184487125:4@s.whatsapp.net']);
    expect(withOwnStatusJid(['5216184487125@s.whatsapp.net'], user)).toEqual(['5216184487125@s.whatsapp.net']);
  });

  it('no muta la lista original', () => {
    const input = ['5216181234567@s.whatsapp.net'];
    const out = withOwnStatusJid(input, user);
    expect(input).toEqual(['5216181234567@s.whatsapp.net']);
    expect(out).not.toBe(input);
  });
});
