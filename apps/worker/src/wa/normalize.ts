import type { proto } from '@whiskeysockets/baileys';

function getText(msg: proto.IMessage | undefined): string | null {
  if (!msg) return null;
  const anyMsg: any = msg as any;
  return (
    anyMsg.conversation ??
    anyMsg.extendedTextMessage?.text ??
    anyMsg.imageMessage?.caption ??
    anyMsg.videoMessage?.caption ??
    null
  );
}

function getMediaMeta(msg: proto.IMessage | undefined) {
  if (!msg) return null;
  const anyMsg: any = msg as any;

  const image = anyMsg.imageMessage;
  if (image) return { kind: 'image', mimetype: image.mimetype ?? null, fileLength: image.fileLength?.toString?.() ?? null };

  const video = anyMsg.videoMessage;
  if (video) return { kind: 'video', mimetype: video.mimetype ?? null, fileLength: video.fileLength?.toString?.() ?? null };

  const audio = anyMsg.audioMessage;
  if (audio) return { kind: 'audio', mimetype: audio.mimetype ?? null, fileLength: audio.fileLength?.toString?.() ?? null };

  const doc = anyMsg.documentMessage;
  if (doc)
    return {
      kind: 'document',
      mimetype: doc.mimetype ?? null,
      fileName: doc.fileName ?? null,
      fileLength: doc.fileLength?.toString?.() ?? null
    };

  return null;
}

export type NormalizedInboundMessage = {
  kind: 'inbound_message';
  messageId: string;
  /** JID for replying (LID when WhatsApp uses @lid). */
  from: string;
  /** E.164-style digits for display/CRM only; null when PN is not available. */
  fromPhone: string | null;
  to: string | null;
  timestamp: number | null;
  content: {
    type: 'text' | 'media' | 'unknown' | 'stub';
    text: string | null;
    media: any | null;
  };
};

/** Extract national/international digits from a phone JID (`user@s.whatsapp.net`). */
export function phoneDigitsFromPnJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const at = jid.indexOf('@');
  const user = at === -1 ? jid : jid.slice(0, at);
  const domain = at === -1 ? 's.whatsapp.net' : jid.slice(at + 1);
  if (domain !== 's.whatsapp.net') return null;
  const digits = user.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

type MessageKeyWithPn = {
  participant?: string;
  participantAlt?: string;
  senderPn?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
};

/**
 * Phone digits for display only. Does not affect reply routing (`from` stays on LID when needed).
 */
export function resolveFromPhone(key: proto.IMessageKey | undefined, from: string): string | null {
  const k = (key ?? {}) as MessageKeyWithPn;
  const candidates = [
    k.senderPn,
    k.remoteJidAlt,
    k.participantAlt,
    from.endsWith('@s.whatsapp.net') ? from : null,
    k.remoteJid?.endsWith('@s.whatsapp.net') ? k.remoteJid : null,
    k.participant?.endsWith('@s.whatsapp.net') ? k.participant : null
  ];
  for (const jid of candidates) {
    const phone = phoneDigitsFromPnJid(jid);
    if (phone) return phone;
  }
  return null;
}

/**
 * Resolve the canonical "from" JID for replying.
 * - Groups: use participant (sender in group).
 * - 1:1 with LID: use remoteJid (e.g. xxx@lid) so the reply goes to the same chat and
 *   clears "Esperando el mensaje"; using senderPn would send to number@s.whatsapp.net
 *   and the LID conversation would not get the reply.
 * - Else: senderPn or remoteJid.
 */
function resolveFromJid(key: proto.IMessageKey | undefined): string {
  if (!key) return '';
  const k = key as { participant?: string; senderPn?: string; remoteJid?: string };
  if (k.participant) return k.participant;
  if (k.remoteJid && k.remoteJid.endsWith('@lid')) return k.remoteJid;
  if (k.senderPn) return k.senderPn;
  return k.remoteJid ?? '';
}

export function normalizeInboundMessage(params: {
  message: proto.IWebMessageInfo;
  deviceJid: string | null;
}): NormalizedInboundMessage {
  const m = params.message;
  const messageId = m.key?.id ?? '';
  const from = resolveFromJid(m.key ?? undefined);
  const fromPhone = resolveFromPhone(m.key ?? undefined, from);
  const to = params.deviceJid;
  const timestamp = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : (m.messageTimestamp as any)?.toNumber?.() ?? null;

  const text = getText(m.message ?? undefined);
  const media = getMediaMeta(m.message ?? undefined);
  const isStub = (m as { messageStubType?: number }).messageStubType != null;

  const type: 'text' | 'media' | 'unknown' | 'stub' = isStub
    ? 'stub'
    : text
      ? 'text'
      : media
        ? 'media'
        : 'unknown';

  return {
    kind: 'inbound_message',
    messageId,
    from,
    fromPhone,
    to,
    timestamp,
    content: { type, text, media }
  };
}

