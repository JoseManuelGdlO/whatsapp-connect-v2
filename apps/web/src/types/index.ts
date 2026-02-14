export type Device = {
  id: string;
  tenantId?: string;
  label: string;
  status: string;
  qr: string | null;
  lastError: string | null;
};

export type WebhookEndpoint = {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  enabled: boolean;
  createdAt: string;
};

export type OutboundMessage = {
  id: string;
  to: string;
  status: string;
  isTest: boolean;
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
};

export type Tenant = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
};

export type Conversation = {
  remoteJid: string;
  lastMessageAt: string;
  messageCount: number;
  stuck?: boolean;
};

export type ChatMessage = {
  id: string;
  type: 'inbound' | 'outbound';
  text: string;
  timestamp: string;
  fromMe: boolean;
  status?: string;
};
