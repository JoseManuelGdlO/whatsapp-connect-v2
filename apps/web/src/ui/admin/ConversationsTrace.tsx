import { useEffect, useState } from 'react';
import { apiJson } from '../../api/client';
import type { ChatMessage, Conversation, Device } from '../../types';
import { TenantSelector } from './TenantSelector';

function formatJidDisplay(jid: string): string {
  const match = jid.match(/^(\d+)@|^([^@]+)@/);
  if (match) {
    const num = match[1] ?? match[2] ?? '';
    if (num.length > 4) return `${num.slice(0, 2)}***${num.slice(-2)}`;
    return num;
  }
  return jid;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type ConversationsResponse = { conversations: Conversation[] };
type MessagesResponse = { messages: ChatMessage[] };

export function ConversationsTrace({ token, tenantIdOverride }: { token: string; tenantIdOverride: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantIdOverride || !token) {
      setDevices([]);
      return;
    }
    apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantIdOverride)}`, token)
      .then((data) => setDevices(data.map((d) => ({ ...d, label: d.label || d.id || 'Device sin nombre' }))))
      .catch(() => setDevices([]));
  }, [token, tenantIdOverride]);

  useEffect(() => {
    if (!token || !selectedDeviceId) {
      setConversations([]);
      setSelectedJid(null);
      return;
    }
    setConversationsLoading(true);
    setConversations([]);
    setSelectedJid(null);
    apiJson<ConversationsResponse>(`/devices/${selectedDeviceId}/conversations`, token)
      .then((r) => setConversations(r.conversations))
      .catch((err) => setMsg(err?.message ?? 'Error al cargar conversaciones'))
      .finally(() => setConversationsLoading(false));
  }, [token, selectedDeviceId]);

  useEffect(() => {
    if (!token || !selectedDeviceId || !selectedJid) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    setMessages([]);
    const url = `/devices/${selectedDeviceId}/conversations/messages?remoteJid=${encodeURIComponent(selectedJid)}`;
    apiJson<MessagesResponse>(url, token)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]))
      .finally(() => setMessagesLoading(false));
  }, [token, selectedDeviceId, selectedJid]);

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  return (
    <div className="conversationsTraceFull">
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 0 }}>
        <h3>Trace de conversaciones (por dispositivo)</h3>
        <TenantSelector />
        <p className="muted">Elige un dispositivo para ver sus conversaciones.</p>

        <label>
          Dispositivo
          <select
            value={selectedDeviceId ?? ''}
            onChange={(e) => setSelectedDeviceId(e.target.value || null)}
            style={{ marginTop: 4 }}
          >
            <option value="">-- Seleccionar --</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} ({d.status})
              </option>
            ))}
          </select>
        </label>

        {msg && <div className="error">{msg}</div>}
      </div>

      <div className="conversationsTraceChatGrid">
        <div className="chatSidebar" style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontWeight: 600 }}>
            Conversaciones {selectedDevice ? `· ${selectedDevice.label}` : ''}
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {conversationsLoading && <p className="muted" style={{ padding: 12 }}>Cargando...</p>}
            {!conversationsLoading && conversations.length === 0 && selectedDeviceId && (
              <p className="muted" style={{ padding: 12 }}>Sin conversaciones</p>
            )}
            {!conversationsLoading &&
              conversations.map((c) => (
                <button
                  key={c.remoteJid}
                  type="button"
                  className={`chatConversationRow ${selectedJid === c.remoteJid ? 'active' : ''}`}
                  onClick={() => setSelectedJid(c.remoteJid)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="rowTitle" style={{ marginBottom: 2 }}>
                      {formatJidDisplay(c.remoteJid)}
                      {c.stuck && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>Trabado</span>
                      )}
                    </div>
                    <div className="rowMeta">
                      {c.messageCount} msg · {formatTime(c.lastMessageAt)}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>

        <div className="chatPanel" style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 12, borderBottom: '1px solid #e2e8f0', fontWeight: 600, flexShrink: 0 }}>
            {selectedJid ? formatJidDisplay(selectedJid) : 'Selecciona una conversación'}
          </div>
          <div className="chatThread chatThreadScroll" style={{ flex: 1, overflow: 'auto', padding: 12, minHeight: 0 }}>
            {messagesLoading && <p className="muted">Cargando mensajes...</p>}
            {!messagesLoading && messages.length === 0 && selectedJid && <p className="muted">Sin mensajes</p>}
            {!messagesLoading &&
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`chatBubble chatBubble--${m.fromMe ? 'outbound' : 'inbound'}`}
                >
                  <div className="chatBubbleText">{m.text || '(sin texto)'}</div>
                  <div className="chatBubbleMeta">
                    {formatTime(m.timestamp)}
                    {m.fromMe && m.status && (
                      <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.8 }}>{m.status}</span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
