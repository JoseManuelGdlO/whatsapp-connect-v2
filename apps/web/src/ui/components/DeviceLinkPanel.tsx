function formatPairingCode(code: string): string {
  const clean = code.replace(/[\s-]/g, '');
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

type DeviceLinkPanelProps = {
  qrDataUrl: string | null;
  pairingCode: string | null;
  deviceLabel?: string;
  isLinking: boolean;
  needsPhoneForPairing?: boolean;
};

export function DeviceLinkPanel({
  qrDataUrl,
  pairingCode,
  deviceLabel,
  isLinking,
  needsPhoneForPairing = false
}: DeviceLinkPanelProps) {
  if (!isLinking) return null;

  return (
    <div style={{ textAlign: 'center', marginTop: 16 }}>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Escanea el código QR o usa el código de emparejamiento en WhatsApp.
      </p>

      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="QR Code"
          style={{ width: 260, height: 260, margin: '0 auto', display: 'block' }}
        />
      ) : (
        <p className="muted" style={{ margin: '2rem 0' }}>Generando QR…</p>
      )}

      <div style={{ marginTop: 20 }}>
        {pairingCode ? (
          <>
            <p className="muted" style={{ marginBottom: 8, fontSize: 14 }}>
              O vincula con número de teléfono en WhatsApp → Dispositivos vinculados:
            </p>
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                letterSpacing: '0.2em',
                fontFamily: 'ui-monospace, monospace',
                margin: '0 auto'
              }}
            >
              {formatPairingCode(pairingCode)}
            </div>
          </>
        ) : needsPhoneForPairing ? (
          <p className="muted" style={{ fontSize: 14 }}>
            Ingresa tu número de teléfono arriba y genera el código para vincular sin escanear el QR.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            Generando código de emparejamiento… Si no aparece en unos segundos, vuelve a generar el código con el número ingresado.
          </p>
        )}
      </div>

      {deviceLabel ? (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Dispositivo: {deviceLabel}
        </p>
      ) : null}
    </div>
  );
}
