// api/create-booking.js
// Prenotazione pubblica via link diretto del medico (source='paziente', da_centro=false).
// Completa la strada 1 del fix P0 RLS `appuntamenti`: anche l'INSERT pubblico passa
// dal server con service_role, così la superficie anon sulla tabella scende a zero
// (DROP anon_insert_booking + REVOKE INSERT/SELECT in fase DB).
// Gemello di create-booking-centro.js: stessa struttura, ma senza booking_token —
// medico_id/centro_id arrivano dal client e vengono validati (il centro deve
// appartenere al medico), con in più i campi consenso della via diretta.

import { randomUUID } from 'node:crypto';

const rateMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkInMemoryRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function checkSupabaseRateLimit(ip, endpoint, max, windowSeconds) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return true;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: ip, p_max_count: max, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return true;
    return (await res.json()) === true;
  } catch { return true; }
}

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isUuid  = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }
  if (!(await checkSupabaseRateLimit(ip, 'create-booking', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }

  const b = req.body || {};
  const medicoId = clean(b.medico_id, 36);
  const centroId = clean(b.centro_id, 36);
  if (!isUuid(medicoId) || !isUuid(centroId)) {
    return res.status(400).json({ error: 'Riferimenti non validi' });
  }

  const nome    = clean(b.nome, 80);
  const cognome = clean(b.cognome, 80);
  const email   = clean(b.email, 160);
  const tel     = clean(b.tel, 40);
  const tipo    = clean(b.tipo, 120);
  const area    = clean(b.area, 120);
  const note    = clean(b.note, 500);
  const data    = clean(b.data, 10);
  const ora     = clean(b.ora, 5);
  const perConto = b.per_conto === true;
  const consensoVersione = clean(b.consenso_versione, 40);
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Email non valida' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data non valida' });
  if (!/^\d{2}:\d{2}$/.test(ora)) return res.status(400).json({ error: 'Ora non valida' });
  if (!consensoVersione) return res.status(400).json({ error: 'Consenso mancante' });

  const sb = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, ...(init.headers || {}) }
  });

  // 1) Il centro deve esistere e appartenere al medico indicato (guardia che la
  //    vecchia policy anon non applicava).
  try {
    const r = await sb(`centri?id=eq.${encodeURIComponent(centroId)}&medico_id=eq.${encodeURIComponent(medicoId)}&select=id&limit=1`);
    if (!r.ok) return res.status(502).json({ error: 'Verifica fallita' });
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Riferimenti non validi' });
    }
  } catch { return res.status(502).json({ error: 'Verifica fallita' }); }

  // 2) INSERT appuntamento (service-role); token generato server-side
  const consentTs = new Date().toISOString();
  const cancellationToken = randomUUID().replace(/-/g, '');
  let apptId;
  try {
    const r = await sb('appuntamenti?select=id', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        medico_id: medicoId,
        centro_id: centroId,
        data, ora,
        nome_paziente: nome,
        cognome_paziente: cognome,
        telefono_paziente: tel || null,
        email_paziente: email || null,
        tipo_visita: tipo || null,
        area_tematica: area || null,
        note: note || null,
        source: 'paziente',
        cancellation_token: cancellationToken,
        consenso_base_at: consentTs,
        consenso_health_at: consentTs,
        consenso_versione: consensoVersione,
        per_conto: perConto,
        da_centro: false
      })
    });
    if (r.status === 409) return res.status(409).json({ error: 'slot_taken' });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (body.includes('appuntamenti_slot_unique') || body.includes('23505')) {
        return res.status(409).json({ error: 'slot_taken' });
      }
      return res.status(500).json({ error: 'Creazione prenotazione fallita' });
    }
    const arr = await r.json().catch(() => []);
    apptId = arr?.[0]?.id;
    if (!apptId) return res.status(500).json({ error: 'Creazione prenotazione fallita' });
  } catch { return res.status(500).json({ error: 'Creazione prenotazione fallita' }); }

  // 3) emit token email + conferma al paziente (come il gemello centro). Soft-fail.
  if (email) {
    try {
      const r = await sb('rpc/emit_email_token_for_appt', { method: 'POST', body: JSON.stringify({ p_appt_id: apptId }) });
      if (r.ok) {
        const tok = await r.json().catch(() => null);
        const jti = Array.isArray(tok) ? tok[0]?.jti : tok?.jti;
        if (jti) {
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          await fetch(`https://${host}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo: 'conferma_appt_anon', email_token: jti })
          }).catch(() => {});
        }
      }
    } catch { /* soft-fail: appuntamento salvato, email no */ }
  }

  // notifica personale al medico (gate server-side su medici.mail_medico_prenotazione)
  try {
    const hostN = req.headers['x-forwarded-host'] || req.headers.host;
    if (hostN) {
      await fetch(`https://${hostN}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo: 'notifica_medico_prenotazione', appt_id: apptId, cancellation_token: cancellationToken })
      }).catch(() => {});
    }
  } catch { /* soft-fail */ }

  return res.status(200).json({ ok: true, appt_id: apptId });
}
