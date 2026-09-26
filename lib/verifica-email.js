// lib/verifica-email.js
// Codice di verifica dell'email per la prenotazione pubblica (s53, relazione BPM § 3.3).
// Stateless: il server firma { email, scadenza, nonce } insieme al codice con HMAC
// (CONSENSO_TOKEN_SECRET, separazione di scopo 'pr-email-v1'). Il client riceve la
// "sfida" (senza codice), l'utente riceve il codice via email; alla prenotazione il
// server ricalcola la firma. I tentativi per sfida sono limitati dal chiamante con
// check_rate_limit sul nonce (cambiare nonce invalida la firma).
import { createHmac, timingSafeEqual, randomInt, randomBytes } from 'crypto';

const SCOPO = 'pr-email-v1';
export const VALIDITA_MS = 10 * 60 * 1000;
export const TENTATIVI_MAX = 5;

export const normEmail = (e) => String(e || '').trim().toLowerCase();

// Scopo firmato: 'pr-email-v1' prenotazione (default), 'reg-medico-v1' registrazione del medico (s55).
// Un codice rilasciato per uno scopo non vale per l'altro.
function firma(secret, body, codice, scopo = SCOPO) {
  return createHmac('sha256', secret).update(`${scopo}|${body}|${codice}`, 'utf8').digest();
}

export function creaSfida(secret, email, scopo = SCOPO) {
  const codice = String(randomInt(0, 1000000)).padStart(6, '0');
  const payload = { e: normEmail(email), x: Date.now() + VALIDITA_MS, n: randomBytes(9).toString('base64url') };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { codice, sfida: body + '.' + firma(secret, body, codice, scopo).toString('base64url') };
}

// Legge il nonce senza verificare (serve al limite dei tentativi prima della verifica).
export function nonceSfida(sfida) {
  try {
    const body = String(sfida || '').split('.')[0];
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof p?.n === 'string' ? p.n.slice(0, 20) : null;
  } catch { return null; }
}

// { ok:true } | { ok:false, motivo:'codice_errato'|'codice_scaduto'|'email_diversa'|'sfida_non_valida' }
export function verificaCodice(secret, sfida, codice, email, scopo = SCOPO) {
  if (typeof sfida !== 'string' || sfida.length > 400) return { ok: false, motivo: 'sfida_non_valida' };
  const parts = sfida.split('.');
  if (parts.length !== 2) return { ok: false, motivo: 'sfida_non_valida' };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, motivo: 'sfida_non_valida' }; }
  if (!payload || typeof payload.e !== 'string' || !Number.isFinite(payload.x)) return { ok: false, motivo: 'sfida_non_valida' };
  const c = String(codice || '').replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, motivo: 'codice_errato' };
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch { return { ok: false, motivo: 'sfida_non_valida' }; }
  const expected = firma(secret, parts[0], c, scopo);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, motivo: 'codice_errato' };
  if (Date.now() > payload.x) return { ok: false, motivo: 'codice_scaduto' };
  if (payload.e !== normEmail(email)) return { ok: false, motivo: 'email_diversa' };
  return { ok: true };
}
