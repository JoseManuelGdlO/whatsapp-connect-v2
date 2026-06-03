import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.fn(async () => ({}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock
    }))
  }
}));

import {
  resetDeviceAlertStateForTests,
  sendDeviceDisconnectAlert,
  shouldSendDeviceAlert
} from './index.js';

describe('device alert severity', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDeviceAlertStateForTests();
    process.env = {
      ...envBackup,
      SMTP_HOST: 'smtp.example.com',
      ALERT_EMAIL_TO: 'ops@example.com',
      DEVICE_ALERT_MIN_LEVEL: 'error'
    };
  });

  afterEach(() => {
    process.env = envBackup;
    resetDeviceAlertStateForTests();
  });

  describe('shouldSendDeviceAlert', () => {
    it('blocks info when min level is error', () => {
      process.env.DEVICE_ALERT_MIN_LEVEL = 'error';
      expect(shouldSendDeviceAlert('info')).toBe(false);
      expect(shouldSendDeviceAlert('error')).toBe(true);
    });

    it('allows info when min level is info', () => {
      process.env.DEVICE_ALERT_MIN_LEVEL = 'info';
      expect(shouldSendDeviceAlert('info')).toBe(true);
      expect(shouldSendDeviceAlert('debug')).toBe(false);
    });

    it('falls back to error for invalid min level', () => {
      process.env.DEVICE_ALERT_MIN_LEVEL = 'invalid';
      expect(shouldSendDeviceAlert('warn')).toBe(false);
      expect(shouldSendDeviceAlert('error')).toBe(true);
    });
  });

  describe('sendDeviceDisconnectAlert', () => {
    it('does not send email when severity is below threshold', async () => {
      await sendDeviceDisconnectAlert('dev-1', 'connection_closed', { severity: 'info' });
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('sends email when severity meets threshold', async () => {
      await sendDeviceDisconnectAlert('dev-1', 'loggedOut', { severity: 'error' });
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Severidad: error')
        })
      );
    });

    it('does not consume cooldown when severity is below threshold', async () => {
      await sendDeviceDisconnectAlert('dev-1', 'transient', { severity: 'info' });
      await sendDeviceDisconnectAlert('dev-1', 'loggedOut', { severity: 'error' });
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });
  });
});
