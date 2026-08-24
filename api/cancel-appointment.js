// api/cancel-appointment.js
import { avvisaListaAttesa } from '../lib/waitlist.js';
// Fix P0 RLS `appuntamenti` (strada 1 — difesa in profondità).
// Sostituisce l'accesso anon diretto al DB dalla pagina pubblica ?cancel=<token>:
// lookup e cancellazione passano da qui con service_role, match SEMPRE sul token
// (mai sull'id). Le policy anon `anon_select_by_token` / `anon_cancel_by_token`
// vengono droppate in produzione dopo il deploy di questo endpoint.
//
// POST { action: 'lookup'|'cancel', token: <cancellation_token> }
// - lookup → 200 { appt: {id, nome_paziente, cognome_paziente, data, ora, tipo_visita, cancelled} }
// - cancel → 200 { ok: true } | 409 { error: 'termine_scaduto' | 'gia_cancellato' }
// - token non trovato → 404 UNIFORME { error: 'not_found' } (non-enumerabilità, chiude R10)
//   Gli stati distinti (scaduto/già cancellato) sono restituiti SOLO a chi possiede
//   un token valido: il possesso del token è l'autenticazione del paziente.

const rateMap = new Map(); // ip -> { count, resetAt } — fallback in-memory
const RATE_LIMIT = 30;
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

const LOOKUP_FIELDS = 'id,nome_paziente,cognome_paziente,data,ora,tipo_visita,cancelled';

// Cancellazione consentita fino a CANCEL_CUTOFF_H ore prima dell'appuntamento
// (stessa regola già mostrata dal client; qui è la guardia autorevole).
const CANCEL_CUTOFF_H = 2;

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
  if (!(await checkSupabaseRateLimit(ip, 'cancel-appointment', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }

  const b = req.body || {};
  const action = typeof b.action === 'string' ? b.action : '';
  const token  = typeof b.token  === 'string' ? b.token.trim().slice(0, 64) : '';
  // Token = UUIDv4, con o senza trattini (le due vie di generazione differiscono).
  if (!token || !/^[0-9a-fA-F-]{32,36}$/.test(token)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const sb = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, ...(init.headers || {}) }
  });

  try {
    if (action === 'lookup') {
      const r = await sb(`appuntamenti?cancellation_token=eq.${encodeURIComponent(token)}&select=${LOOKUP_FIELDS}&limit=1`);
      if (!r.ok) return res.status(500).json({ error: 'Errore server' });
      const rows = await r.json().catch(() => []);
      const appt = Array.isArray(rows) ? rows[0] : null;
      if (!appt) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ appt });
    }

    if (action === 'cancel') {
      // Stato attuale (per distinguere già-cancellato e verificare il cutoff server-side)
      const r0 = await sb(`appuntamenti?cancellation_token=eq.${encodeURIComponent(token)}&select=id,data,ora,cancelled,medico_id,centro_id&limit=1`);
      if (!r0.ok) return res.status(500).json({ error: 'Errore server' });
      const rows0 = await r0.json().catch(() => []);
      const appt0 = Array.isArray(rows0) ? rows0[0] : null;
      if (!appt0) return res.status(404).json({ error: 'not_found' });
      if (appt0.cancelled) return res.status(409).json({ error: 'gia_cancellato' });

      const ora = (appt0.ora || '00:00').substring(0, 5);
      const apptDate = new Date(`${appt0.data}T${ora}:00`);
      if (!Number.isNaN(apptDate.getTime())) {
        const diffH = (apptDate - new Date()) / 3600000;
        if (diffH < CANCEL_CUTOFF_H) return res.status(409).json({ error: 'termine_scaduto' });
      }

      // UPDATE con match sul TOKEN (mai sull'id) + guardia cancelled=false + RETURNING
      const r1 = await sb(
        `appuntamenti?cancellation_token=eq.${encodeURIComponent(token)}&cancelled=eq.false`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ cancelled: true, cancelled_at: new Date().toISOString() })
        }
      );
      if (!r1.ok) return res.status(500).json({ error: 'Errore server' });
      const updated = await r1.json().catch(() => []);
      if (!Array.isArray(updated) || updated.length === 0) {
        // Corsa persa tra il check e l'UPDATE: qualcuno ha già cancellato
        return res.status(409).json({ error: 'gia_cancellato' });
      }
      // notifica personale al medico (gate server-side su medici.mail_medico_cancellazione)
      try {
        const hostN = req.headers['x-forwarded-host'] || req.headers.host;
        if (hostN) {
          await fetch(`https://${hostN}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo: 'notifica_medico_cancellazione', appt_id: appt0.id, cancellation_token: token })
          }).catch(() => {});
        }
      } catch { /* soft-fail */ }
      // Lista d'attesa (v1): hook condiviso in lib/waitlist.js (solo slot futuri,
      // best-effort, cap 10 destinatari).
      const hostW = req.headers['x-forwarded-host'] || req.headers.host;
      await avvisaListaAttesa({ sb, host: hostW, appt: appt0 });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  } catch (e) {
    console.error('[cancel-appointment]', e.message);
    return res.status(500).json({ error: 'Errore server' });
  }
}
