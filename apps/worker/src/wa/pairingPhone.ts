const MIN_PAIRING_PHONE_DIGITS = 10;

/** E.164 digits only (no +, spaces, or punctuation). Returns null if invalid. */
export function sanitizePairingPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < MIN_PAIRING_PHONE_DIGITS) return null;
  return digits;
}

/** Display pairing code with a hyphen after the 4th character (e.g. ABCD-1234). */
export function formatPairingCode(code: string): string {
  const clean = code.replace(/[\s-]/g, '');
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}
