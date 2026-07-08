const MIN_PAIRING_PHONE_DIGITS = 10;

/** E.164 digits only (no +, spaces, or punctuation). Returns null if invalid. */
export function sanitizePairingPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < MIN_PAIRING_PHONE_DIGITS) return null;
  return digits;
}
