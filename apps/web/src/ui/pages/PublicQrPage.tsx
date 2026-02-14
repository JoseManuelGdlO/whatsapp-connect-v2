import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { API_URL } from '../../api/client';

export function PublicQrPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<'loading' | 'QR' | 'ONLINE' | 'EXPIRED' | 'NOT_FOUND'>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setStatus('NOT_FOUND');
      return;
    }

    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/public/qr/${token}`);
        if (!alive) return;

        if (!res.ok) {
          if (res.status === 404) {
            setStatus('NOT_FOUND');
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!alive) return;

        setStatus(data.status);
        setDeviceLabel(data.deviceLabel || '');

        if (data.status === 'QR' && data.qr) {
          const url = await QRCode.toDataURL(data.qr);
          if (alive) setQrDataUrl(url);
        } else {
          setQrDataUrl(null);
        }

        if (data.status === 'ONLINE' || data.status === 'EXPIRED' || data.status === 'NOT_FOUND') {
          return;
        }
      } catch (err) {
        if (!alive) return;
        console.error('Error fetching QR status:', err);
      }
    };

    tick();
    const interval = setInterval(tick, 2000);

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [token]);

  return (
    <div className="card" style={{ maxWidth: '500px', margin: '2rem auto', textAlign: 'center' }}>
      <h2>Sincronizar WhatsApp</h2>

      {status === 'loading' && (
        <div>
          <p>Cargando...</p>
        </div>
      )}

      {status === 'QR' && qrDataUrl && (
        <div>
          <p style={{ marginBottom: '1rem' }}>Escanea este código QR con WhatsApp para sincronizar tu dispositivo.</p>
          <img src={qrDataUrl} alt="QR Code" style={{ width: 300, height: 300, margin: '0 auto', display: 'block' }} />
          {deviceLabel && <p className="muted" style={{ marginTop: '1rem' }}>Dispositivo: {deviceLabel}</p>}
        </div>
      )}

      {status === 'ONLINE' && (
        <div>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
          <h3 style={{ color: '#22c55e', marginBottom: '1rem' }}>¡WhatsApp sincronizado!</h3>
          <p>Tu WhatsApp se ha sincronizado correctamente. Puedes cerrar esta ventana.</p>
        </div>
      )}

      {status === 'EXPIRED' && (
        <div>
          <p className="error">Este link ha expirado o el dispositivo ya está conectado.</p>
          {deviceLabel && <p className="muted">Dispositivo: {deviceLabel}</p>}
        </div>
      )}

      {status === 'NOT_FOUND' && (
        <div>
          <p className="error">Link no encontrado o inválido.</p>
        </div>
      )}
    </div>
  );
}
