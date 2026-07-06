/** Envía composing al recibir inbound (legacy). Por defecto desactivado; composing solo en outbound. */
export function isInboundAutoComposingEnabled(): boolean {
  return process.env.WORKER_INBOUND_AUTO_COMPOSING === 'true';
}

export const INBOUND_COMPOSING_PAUSE_AFTER_MS = 25_000;
