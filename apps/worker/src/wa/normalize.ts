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
    type: 'text' | 'media' | 'unknown';
    text: string | null;
    media: any | null;
  };
};

export function normalizeInboundMessage(params: {
  message: proto.IWebMessageInfo;
  deviceJid: string | null;
}): NormalizedInboundMessage {
  const m = params.message;
  const messageId = m.key?.id ?? '';
  const from = m.key?.remoteJid ?? '';
  const to = params.deviceJid;
  const timestamp = typeof m.messageTimestamp === 'number' ? m.messageTimestamp : (m.messageTimestamp as any)?.toNumber?.() ?? null;

  const text = getText(m.message ?? undefined);
  const media = getMediaMeta(m.message ?? undefined);

  const type: 'text' | 'media' | 'unknown' = text ? 'text' : media ? 'media' : 'unknown';

  return {
    kind: 'inbound_message',
    messageId,
    from,
    to,
    timestamp,
    content: { type, text, media }
  };
}

