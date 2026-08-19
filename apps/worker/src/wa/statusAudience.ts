/** Usuario autenticado en el socket Baileys (`sock.user`). */
export type SocketUser = { id?: string; lid?: string };

/** Quita el sufijo de dispositivo (`5216…:4@s.whatsapp.net` → `5216…@s.whatsapp.net`). */
export function normalizeUserJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at <= 0) return jid;
  const user = jid.slice(0, at).split(':')[0];
  const server = jid.slice(at + 1);
  if (!user || !server) return jid;
  return `${user}@${server}`;
}

function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

function isPnJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net');
}

/**
 * Elige el JID propio alineado con la audiencia para no mezclar PN y LID
 * (WhatsApp responde ACK 400 si el fanout mezcla servidores).
 * Si hay más LID que PN, usa `user.lid`; si no, `user.id`.
 */
export function ownJidForStatusAudience(statusJidList: string[], user: SocketUser | undefined): string | null {
  if (!user?.id && !user?.lid) return null;
  const lidCount = statusJidList.filter(isLidJid).length;
  const pnCount = statusJidList.filter(isPnJid).length;
  const preferLid = lidCount > pnCount;
  if (preferLid) {
    if (user.lid) return normalizeUserJid(user.lid);
    if (user.id) return normalizeUserJid(user.id);
    return null;
  }
  if (user.id) return normalizeUserJid(user.id);
  if (user.lid) return normalizeUserJid(user.lid);
  return null;
}

/** Añade el JID propio si no está ya en la lista (comparando JIDs normalizados). */
export function withOwnStatusJid(statusJidList: string[], user: SocketUser | undefined): string[] {
  const own = ownJidForStatusAudience(statusJidList, user);
  if (!own) return statusJidList;
  const seen = new Set(statusJidList.map(normalizeUserJid));
  if (seen.has(normalizeUserJid(own))) return statusJidList;
  return [...statusJidList, own];
}
