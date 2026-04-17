import { describe, expect, it } from 'vitest';

const runReal = process.env.RUN_REAL_WA_TESTS === 'true';

describe('Suite real opcional de WhatsApp', () => {
  it('permanece protegida por bandera en ejecución por defecto', () => {
    expect(runReal).toBe(false);
  });
});

const realDescribe = runReal ? describe : describe.skip;

realDescribe('Pruebas reales de WhatsApp (manual)', () => {
  it('requiere variables mínimas para ejecutarse', () => {
    expect(process.env.WA_REAL_DEVICE_ID).toBeTruthy();
    expect(process.env.WA_REAL_TARGET_JID).toBeTruthy();
  });
});
