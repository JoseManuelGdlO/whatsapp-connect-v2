import { describe, expect, it } from 'vitest';
import { isReachoutTimelockAck, shouldBlockColdSend } from './outboundAck.js';

describe('isReachoutTimelockAck', () => {
  it('detecta 463 en messageStubParameters', () => {
    expect(isReachoutTimelockAck({ messageStubParameters: ['463'] })).toBe(true);
  });

  it('detecta error 463 en attrs del ack', () => {
    expect(isReachoutTimelockAck({}, '463')).toBe(true);
  });

  it('ignora updates sin 463', () => {
    expect(isReachoutTimelockAck({ messageStubParameters: ['404'] })).toBe(false);
    expect(isReachoutTimelockAck({})).toBe(false);
  });
});

describe('shouldBlockColdSend', () => {
  it('bloquea outreach a contactos frios mientras hay timelock', () => {
    expect(
      shouldBlockColdSend({ reachoutLocked: true, isBroadcast: false, hasRecentInbound: false })
    ).toBe(true);
  });

  it('permite respuestas a chats calientes y estados', () => {
    expect(
      shouldBlockColdSend({ reachoutLocked: true, isBroadcast: false, hasRecentInbound: true })
    ).toBe(false);
    expect(
      shouldBlockColdSend({ reachoutLocked: true, isBroadcast: true, hasRecentInbound: false })
    ).toBe(false);
  });

  it('no bloquea si no hay timelock', () => {
    expect(
      shouldBlockColdSend({ reachoutLocked: false, isBroadcast: false, hasRecentInbound: false })
    ).toBe(false);
  });
});
