// lib/consenso-token.js
// Token HMAC stateless per il consenso alle comunicazioni proattive (s20).
// Firmati con SUPABASE_SERVICE_ROLE_KEY. Payload:
//   { a:'c', ap:<appuntamento_id>, v, exp }   richiesta di consenso (da prenotazione)
//   { a:'c', p:<paziente_id>, v, exp }         richiesta di consenso (da fascicolo creato a mano)
//   { a:'r', p:<paziente_id>, exp }            dal fascicolo (email di cluster)
//   { a:'r', e:<email>, m:<medico_id>, exp }   dalla prenotazione (email di conferma)
import { createHmac, timingSafeEqual } from 'crypto';

export const CONS_COMM_VERSIONE = 'cons-comm-0.1-bozza'; // segnaposto: testo definitivo dal corpus legale (gate C)

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function signPayload(secret, payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
  return body + '.' + sig;
}

export function readPayload(secret, token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', secret).update(parts[0], 'utf8').digest();
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
  return payload;
}

export function consensoLink(host, secret, { apptId, pazienteId }) {
  const payload = apptId
    ? { a: 'c', ap: apptId, v: CONS_COMM_VERSIONE, exp: Date.now() + 30 * 86400000 }
    : { a: 'c', p: pazienteId, v: CONS_COMM_VERSIONE, exp: Date.now() + 30 * 86400000 };
  return `https://${host}/?consenso=${encodeURIComponent(signPayload(secret, payload))}`;
}

export function revocaLink(host, secret, { pazienteId, email, medicoId }) {
  const payload = pazienteId
    ? { a: 'r', p: pazienteId, exp: Date.now() + 365 * 86400000 }
    : { a: 'r', e: String(email || '').toLowerCase(), m: medicoId, exp: Date.now() + 365 * 86400000 };
  return `https://${host}/?revoca_comm=${encodeURIComponent(signPayload(secret, payload))}`;
}
