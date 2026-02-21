import nodemailer from 'nodemailer';

const ALERT_TIMEOUT_MS = 5000;

function isConfigured(): boolean {
  const to = process.env.ALERT_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  return Boolean(to && host);
}

function getTransporter(): nodemailer.Transporter | null {
  if (!isConfigured()) return null;
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined
  });
}

/**
 * Send an alert email. No-op if SMTP/ALERT_EMAIL_TO not configured.
 * Resolves after send or after timeout so it doesn't block process.exit.
 */
export async function sendAlert(
  service: 'api' | 'worker',
  subject: string,
  body: string
): Promise<void> {
  if (!isConfigured()) return;
  const transporter = getTransporter();
  if (!transporter) return;
  const from = process.env.ALERT_EMAIL_FROM ?? process.env.ALERT_EMAIL_TO ?? 'noreply@localhost';
  const to = process.env.ALERT_EMAIL_TO!;
  const fullBody = `[${service}]\n\n${body}\n\n---\nRevisa los logs en la base de datos o consola para más detalle.`;
  try {
    await Promise.race([
      transporter.sendMail({
        from,
        to,
        subject: `[WhatsApp Connect] ${subject}`,
        text: fullBody
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Alert email timeout')), ALERT_TIMEOUT_MS)
      )
    ]);
  } catch (err) {
    console.error(`[alert] Failed to send email:`, err instanceof Error ? err.message : err);
  }
}

export interface DeviceDisconnectContext {
  statusCode?: number;
  reason?: string;
  willReconnect?: boolean;
}

/**
 * Send an alert when a device is disconnected or has been disconnected.
 * Includes reason and log reference.
 */
export async function sendDeviceDisconnectAlert(
  deviceId: string,
  reason: string,
  options?: {
    label?: string | null;
    tenantId?: string | null;
    logContext?: DeviceDisconnectContext;
  }
): Promise<void> {
  if (!isConfigured()) return;
  const { label, tenantId, logContext } = options ?? {};
  const subject = `Dispositivo desconectado: ${label ?? deviceId}`;
  const lines = [
    `Dispositivo: ${label ?? deviceId} (${deviceId})`,
    `Tenant: ${tenantId ?? '—'}`,
    `Razón del fallo: ${reason}`
  ];
  if (logContext) {
    if (logContext.statusCode != null) lines.push(`statusCode: ${logContext.statusCode}`);
    if (logContext.reason != null) lines.push(`reason: ${logContext.reason}`);
    if (logContext.willReconnect != null) lines.push(`willReconnect: ${logContext.willReconnect}`);
  }
  lines.push('', 'Revisa los logs del worker (deviceId/tenantId) para más detalle.');
  await sendAlert('worker', subject, lines.join('\n'));
}
