import nodemailer from 'nodemailer';

const ALERT_TIMEOUT_MS = 5000;

/** No enviar otra alerta del mismo dispositivo antes de este tiempo (evita inundar el correo). */
const DEVICE_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hora

export type DeviceAlertSeverity = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY_ORDER: Record<DeviceAlertSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function parseMinAlertLevel(): DeviceAlertSeverity {
  const raw = (process.env.DEVICE_ALERT_MIN_LEVEL ?? 'error').toLowerCase();
  if (raw in SEVERITY_ORDER) return raw as DeviceAlertSeverity;
  return 'error';
}

/** True if an alert at this severity should be emailed given DEVICE_ALERT_MIN_LEVEL. */
export function shouldSendDeviceAlert(severity: DeviceAlertSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[parseMinAlertLevel()];
}

function isConfigured(): boolean {
  const to = process.env.ALERT_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  return Boolean(to && host);
}

/** Lista de correos destino: ALERT_EMAIL_TO puede ser "a@b.com, c@d.com" o uno solo. */
function getAlertToAddresses(): string[] {
  const raw = process.env.ALERT_EMAIL_TO ?? '';
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
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
  const addresses = getAlertToAddresses();
  if (addresses.length === 0) return;
  const transporter = getTransporter();
  if (!transporter) return;
  const from = process.env.ALERT_EMAIL_FROM ?? addresses[0] ?? 'noreply@localhost';
  const fullBody = `[${service}]\n\n${body}\n\n---\nRevisa los logs en la base de datos o consola para más detalle.`;
  try {
    await Promise.race([
      transporter.sendMail({
        from,
        to: addresses,
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

/** Por dispositivo: timestamp del último correo enviado (para no repetir el mismo error). */
const lastDeviceAlertAt = new Map<string, number>();

/** Reset cooldown state (tests only). */
export function resetDeviceAlertStateForTests(): void {
  lastDeviceAlertAt.clear();
}

/**
 * Send an alert when a device is disconnected or has been disconnected.
 * Includes reason and log reference.
 * Solo envía un correo por dispositivo como máximo cada 1 hora (evita inundar).
 * Respeta DEVICE_ALERT_MIN_LEVEL: eventos por debajo del umbral no envían correo ni consumen cooldown.
 */
export async function sendDeviceDisconnectAlert(
  deviceId: string,
  reason: string,
  options?: {
    label?: string | null;
    tenantId?: string | null;
    severity?: DeviceAlertSeverity;
    logContext?: DeviceDisconnectContext;
  }
): Promise<void> {
  if (!isConfigured()) return;

  const severity = options?.severity ?? 'error';
  if (!shouldSendDeviceAlert(severity)) return;

  const now = Date.now();
  const last = lastDeviceAlertAt.get(deviceId) ?? 0;
  if (now - last < DEVICE_ALERT_COOLDOWN_MS) return;
  lastDeviceAlertAt.set(deviceId, now);

  const { label, tenantId, logContext } = options ?? {};
  const subject = `Dispositivo desconectado: ${label ?? deviceId}`;
  const lines = [
    `Dispositivo: ${label ?? deviceId} (${deviceId})`,
    `Tenant: ${tenantId ?? '—'}`,
    `Severidad: ${severity}`,
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
