import type { proto } from '@whiskeysockets/baileys';
import { getChatId, jidNormalizedUser, isJidBroadcast, isJidGroup } from '@whiskeysockets/baileys';

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
  from: string;
  /** JID completo al que el bot debe responder. Usar este para enviar y como clave de hilo estable (mismo contacto = mismo replyToJid cuando hay senderPn). */
  replyToJid: string;
  /** JID remoto del mensaje (p. ej. número@s.whatsapp.net o xxx@lid). */
  remoteJid: string;
  /** Número de teléfono en JID cuando WhatsApp lo envía; usar como clave estable para el mismo contacto. */
  senderPn: string | null;
  to: string | null;
  timestamp: number | null;
  content: {
    type: 'text' | 'media' | 'stub' | 'unknown';
    text: string | null;
    media: any | null;
  };
};

export function normalizeInboundMessage(params: {
  message: proto.IWebMessageInfo;
  deviceJid: string | null;
}): NormalizedInboundMessage {
  const m = params.message;
  const key = m.key;
  const messageId = key?.id ?? '';

  // Reply-to JID: use getChatId so broadcast uses participant; for 1:1 prefer senderPn (phone) over LID
  const chatId = key ? getChatId(key) : '';
  const keyAny = key as { senderPn?: string } | undefined;
  const isOneToOne = chatId && !isJidGroup(chatId) && !isJidBroadcast(chatId);
  const replyToJid = (isOneToOne && keyAny?.senderPn ? keyAny.senderPn : chatId) || key?.remoteJid || '';
  const from = (jidNormalizedUser(replyToJid || '') || replyToJid || key?.remoteJid) ?? '';
  const remoteJid = key?.remoteJid ?? '';
  const senderPn = keyAny?.senderPn ?? null;

  const to = params.deviceJid;
  const timestamp = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : (m.messageTimestamp as any)?.toNumber?.() ?? null;

  let text = getText(m.message ?? undefined);
  const media = getMediaMeta(m.message ?? undefined);

  // Stub messages (e.g. "No session record", group join/leave) have no conversation/text
  const msgAny = m as { messageStubType?: number; messageStubParameters?: string[] };
  const isStub = text == null && media == null && (msgAny.messageStubType != null || (msgAny.messageStubParameters?.length ?? 0) > 0);
  if (isStub && msgAny.messageStubParameters?.length) {
    text = msgAny.messageStubParameters.join(' ').trim() || null;
  }

  const type: 'text' | 'media' | 'stub' | 'unknown' =
    text && !isStub ? 'text' : media ? 'media' : isStub ? 'stub' : 'unknown';

  return {
    kind: 'inbound_message',
    messageId,
    from,
    replyToJid,
    remoteJid,
    senderPn,
    to,
    timestamp,
    content: { type, text: text || null, media }
  };
}

