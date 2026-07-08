import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { API_URL } from '../../api/client';
import { DeviceLinkPanel } from '../components/DeviceLinkPanel';

export function PublicQrPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<'loading' | 'QR' | 'ONLINE' | 'EXPIRED' | 'NOT_FOUND'>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [awaitingPairing, setAwaitingPairing] = useState(false);

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
        setPairingCode(data.pairingCode ?? null);

        if (data.pairingCode) {
          setAwaitingPairing(false);
          setSubmitError(null);
        }

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

  const requestPairingCode = async () => {
    if (!token) return;
    const phone = phoneNumber.trim();
    if (!phone) {
      setSubmitError('Ingresa tu número con código de país (ej. 521XXXXXXXXXX).');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_URL}/public/qr/${token}/pairing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.error === 'invalid_phone_number') {
          throw new Error('Número inválido. Usa solo dígitos con código de país, mínimo 10.');
        }
        if (data?.status === 'EXPIRED' || data?.error === 'expired') {
          setStatus('EXPIRED');
          throw new Error('Este link ha expirado.');
        }
        if (data?.status === 'ONLINE' || data?.error === 'already_online') {
          setStatus('ONLINE');
          return;
        }
        throw new Error(data?.error || `Error HTTP ${res.status}`);
      }
      setAwaitingPairing(true);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'No se pudo generar el código');
      setAwaitingPairing(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: '500px', margin: '2rem auto', textAlign: 'center' }}>
      <h2>Sincronizar WhatsApp</h2>

      {status === 'loading' && (
        <div>
          <p>Cargando...</p>
        </div>
      )}

      {status === 'QR' && (
        <>
          {!pairingCode ? (
            <div style={{ marginBottom: 16, textAlign: 'left' }}>
              <p className="muted" style={{ marginBottom: 8, fontSize: 14 }}>
                Para generar el código de emparejamiento (sin escanear QR), ingresa el número de WhatsApp:
                Todos los números de Mexico deben ser con el prefijo 521. Ejemplo: 521XXXXXXXXXX.
              </p>
              <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="521XXXXXXXXXX"
                  inputMode="tel"
                  autoComplete="tel"
                  style={{ flex: 1, minWidth: 180 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void requestPairingCode();
                    }
                  }}
                />
                <button type="button" disabled={submitting} onClick={() => void requestPairingCode()}>
                  {submitting ? 'Generando…' : 'Generar código'}
                </button>
              </div>
              {submitError ? (
                <p className="error" style={{ marginTop: 8, fontSize: 13 }}>
                  {submitError}
                </p>
              ) : null}
            </div>
          ) : null}

          <DeviceLinkPanel
            qrDataUrl={qrDataUrl}
            pairingCode={pairingCode}
            deviceLabel={deviceLabel}
            isLinking
            needsPhoneForPairing={!phoneNumber.trim() && !awaitingPairing && !pairingCode}
          />
        </>
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
