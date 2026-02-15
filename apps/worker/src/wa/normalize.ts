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
  from: string;
  to: string | null;
  timestamp: number | null;
  content: {
    type: 'text' | 'media' | 'unknown' | 'stub';
    text: string | null;
    media: any | null;
  };
};

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
    to,
    timestamp,
    content: { type, text, media }
  };
}

