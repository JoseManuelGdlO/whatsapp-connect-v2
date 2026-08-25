const PN_DOMAIN = 's.whatsapp.net';

function isPassthroughJid(to: string): boolean {
  return (
    to.endsWith('@lid') ||
    to.endsWith('@g.us') ||
    to.endsWith('@broadcast') ||
    to === 'status@broadcast'
  );
}

/** WhatsApp Mexico mobiles use 521 + 10 national digits. */
export function normalizeMexicoWhatsAppDigits(digits: string): string {
  if (digits.length === 10) return `521${digits}`;
  if (digits.length === 12 && digits.startsWith('52') && !digits.startsWith('521')) {
    return `521${digits.slice(2)}`;
  }
  return digits;
}

/** Build a chat JID, fixing Mexican numbers that omit 52 or the mobile 1. */
export function toJid(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) return trimmed;
  if (isPassthroughJid(trimmed)) return trimmed;

  const at = trimmed.indexOf('@');
  const user = at === -1 ? trimmed : trimmed.slice(0, at);
  const digits = user.replace(/\D/g, '');
  if (!digits) return trimmed;
  return `${normalizeMexicoWhatsAppDigits(digits)}@${PN_DOMAIN}`;
}
