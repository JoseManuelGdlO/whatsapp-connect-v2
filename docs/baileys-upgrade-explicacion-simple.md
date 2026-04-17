# Actualizacion de Baileys: explicacion simple y completa

## Resumen rapido

Se actualizo la libreria `@whiskeysockets/baileys` del worker para reducir errores de conexion con WhatsApp (como `bad-request`, `HTTP 428` y desconexiones repetidas al iniciar o reconectar).

Este cambio busca que la conexion sea mas estable y que el sistema se recupere mejor cuando WhatsApp corta la sesion.

---

## 1) Por que se hizo este cambio

### Problema que veiamos

En produccion aparecian errores de desconexion en momentos de reconexion o inicializacion de sesion.  
En varios casos se observaba:

- cierres inesperados de conexion;
- errores como `bad-request` y `HTTP 428`;
- reintentos automaticos que a veces no resolvian el problema.

### Causa probable (en lenguaje simple)

Baileys es la libreria que "habla" con WhatsApp Web.  
WhatsApp cambia internamente con frecuencia. Si la libreria queda desfasada, puede enviar/esperar informacion en un formato o secuencia que ya no coincide con lo que WhatsApp pide.

Cuando eso pasa, WhatsApp responde con errores de precondicion (como 428) o corta la conexion.

Por eso actualizar Baileys suele ser una solucion correcta: alinea el cliente con cambios recientes del protocolo.

---

## 2) Que se cambio exactamente

## 2.1 Dependencia

Se actualizo:

- `apps/worker/package.json`
  - `@whiskeysockets/baileys` de `^6.7.21` a `^7.0.0-rc.9`

Tambien se actualizo el lockfile:

- `package-lock.json`

Esto asegura que el entorno instale la version correcta y consistente.

## 2.2 Compatibilidad en manejo de desconexiones

Archivo modificado:

- `apps/worker/src/wa/sessionManager.ts`

Se mejoro la extraccion del codigo de error de desconexion (`statusCode`) para soportar distintas formas en que Baileys/Boom puede enviar ese dato segun version.

Antes se leía practicamente solo desde una ruta.  
Ahora se intenta leer desde varias rutas posibles del error.

### Por que esto importa

Con versiones nuevas, el objeto de error puede cambiar de forma.  
Si no leemos bien ese dato:

- podemos interpretar mal el motivo de cierre;
- podemos reconectar cuando no debemos;
- o dejar de reconectar cuando si debemos.

Con esta mejora, la decision de reconexion es mas confiable.

## 2.3 Prueba agregada

Archivo modificado:

- `apps/worker/src/wa/sessionManager.test.ts`

Se agrego una prueba para validar el caso donde `loggedOut` llega en otra propiedad del error (`error.data = 401`).

### Por que se agrego

Para asegurar que, aun si cambia el formato interno del error, el sistema siga comportandose correctamente:

- si es `loggedOut`, no reconecta automaticamente;
- evita loops inutiles de reconexion.

---

## 3) En que afecta este cambio

## 3.1 Impacto funcional esperado

### Positivo

- Menos falsos diagnosticos del motivo de desconexion.
- Mejor decision entre reconectar o no reconectar.
- Menor probabilidad de loops de reconexion por mala interpretacion del error.
- Mayor alineacion con cambios recientes del lado de WhatsApp.

### Neutral / sin cambios de negocio

- No cambia reglas de usuarios, tenants, permisos ni API de negocio.
- No cambia el flujo funcional de mensajes (inbound/outbound) por diseño.

### Riesgos reales

- Toda actualizacion de libreria de protocolo puede traer cambios de comportamiento no visibles en tests mock.
- Algunos escenarios solo aparecen con dispositivos reales y trafico real.

Por eso se preparo validacion en preproduccion y canary.

---

## 4) Que se anadio y por que

Se anadieron dos cosas principales:

1. **Extraccion robusta del error de desconexion** en `sessionManager.ts`  
   Para tolerar cambios de formato de error entre versiones.

2. **Cobertura de test adicional** en `sessionManager.test.ts`  
   Para verificar que el caso `loggedOut` siga detectandose correctamente.

Adicionalmente se documento el runbook de despliegue y rollback en:

- `docs/baileys-test-report.md`

---

## 5) Como afectaria en produccion

Si el despliegue sale como se espera:

- deberia bajar la frecuencia de desconexiones "raras" por incompatibilidad;
- deberian disminuir alertas repetitivas por cierres de sesion no terminales;
- deberia mejorar el tiempo de recuperacion de sesiones en reconexion normal.

Si algo sale mal:

- podria subir temporalmente la tasa de cierres/reintentos;
- podria haber mas `lastError` por dispositivo;
- podria requerir rollback rapido.

Por eso se definieron umbrales y criterios de rollback.

---

## 6) Ya esta listo para produccion?

### Estado actual

**Listo para pasar a etapa de despliegue controlado (preprod + canary), no para despliegue total inmediato sin observacion.**

### Que ya esta hecho

- Dependencia actualizada.
- Ajustes de compatibilidad aplicados.
- Build y tests del worker en verde.
- Runbook documentado con criterios de rollback.

### Que falta para considerarlo "listo total prod"

1. Ejecutar validacion preproduccion con dispositivo real.
2. Ejecutar canary (1-2 dispositivos no criticos por 24h).
3. Confirmar metricas dentro de umbral:
   - sin aumento sostenido de desconexiones;
   - sin loops de reconexion;
   - sin caida en entrega outbound.

Si esos puntos pasan, entonces si se considera **listo para produccion completa**.

---

## 7) Decision recomendada

Recomendacion practica:

- avanzar con **despliegue canary controlado**;
- monitorear 24h;
- ampliar por lotes (10%, 30%, 100%) solo con señales estables;
- rollback inmediato si se rompe algun umbral definido.

Esta estrategia reduce riesgo operativo y permite capturar problemas reales sin afectar a todos los dispositivos al mismo tiempo.
