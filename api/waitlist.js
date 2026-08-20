// api/waitlist.js
// Lista d'attesa per anticipazione della visita (v1).
// Il paziente, dal link nella email di conferma (/?anticipa=<cancellation_token>),
// può iscriversi per essere AVVISATO se si libera uno slot prima della data del
// suo appuntamento. Nessuna riserva dello slot: first-come-first-served.
//
// Auth: possesso del cancellation_token (stesso modello di cancel-appointment).
// Superficie anonima su lista_attesa = zero: RLS on / zero policy, solo service_role.
// L'email dell'iscritto è derivata SEMPRE server-side da appuntamenti.email_paziente.
//
// POST { action: 'lookup'|'subscribe'|'unsubscribe', token, consenso? }
// - lookup      → 200 { appt: {...}, iscritto: bool }
// - subscribe   → 200 { ok: true } | 409 { error: 'gia_cancellato'|'appuntamento_passato'|'email_mancante' }
//                 richiede body.consenso === true (consenso cons-wl-1)
// - unsubscribe → 200 { ok: true }
// - token non trovato → 404 UNIFORME { error: 'not_found' } (non-enumerabilità)

const rateMap = new Map(); // ip -> { count, resetAt } — fallback in-memory
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const CONSENSO_VERSIONE = 'cons-wl-1';

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

const LOOKUP_FIELDS = 'id,medico_id,centro_id,nome_paziente,cognome_paziente,email_paziente,data,ora,tipo_visita,cancelled';

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
  if (!(await checkSupabaseRateLimit(ip, 'waitlist', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  }

  const b = req.body || {};
  const action = typeof b.action === 'string' ? b.action : '';
  const token  = typeof b.token  === 'string' ? b.token.trim().slice(0, 64) : '';
  if (!token || !/^[0-9a-fA-F-]{32,36}$/.test(token)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const sb = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, ...(init.headers || {}) }
  });

  try {
    // Risoluzione token → appuntamento (autenticazione = possesso del token)
    const r0 = await sb(`appuntamenti?cancellation_token=eq.${encodeURIComponent(token)}&select=${LOOKUP_FIELDS}&limit=1`);
    if (!r0.ok) return res.status(500).json({ error: 'Errore server' });
    const rows0 = await r0.json().catch(() => []);
    const appt = Array.isArray(rows0) ? rows0[0] : null;
    if (!appt) return res.status(404).json({ error: 'not_found' });

    // Stato iscrizione corrente (per lookup e per idempotenza)
    const rW = await sb(`lista_attesa?appuntamento_id=eq.${encodeURIComponent(appt.id)}&select=id,attivo&limit=1`);
    const rowsW = rW.ok ? await rW.json().catch(() => []) : [];
    const iscrizione = Array.isArray(rowsW) ? rowsW[0] : null;
    const iscritto = !!(iscrizione && iscrizione.attivo);

    if (action === 'lookup') {
      return res.status(200).json({
        appt: {
          nome_paziente: appt.nome_paziente,
          cognome_paziente: appt.cognome_paziente,
          data: appt.data,
          ora: appt.ora,
          tipo_visita: appt.tipo_visita,
          cancelled: appt.cancelled
        },
        iscritto
      });
    }

    if (action === 'subscribe') {
      if (appt.cancelled) return res.status(409).json({ error: 'gia_cancellato' });
      const ora = (appt.ora || '00:00').substring(0, 5);
      const apptDate = new Date(`${appt.data}T${ora}:00`);
      if (!Number.isNaN(apptDate.getTime()) && apptDate <= new Date()) {
        return res.status(409).json({ error: 'appuntamento_passato' });
      }
      if (!appt.email_paziente || !String(appt.email_paziente).includes('@')) {
        return res.status(409).json({ error: 'email_mancante' });
      }
      if (b.consenso !== true) {
        return res.status(400).json({ error: 'consenso_richiesto' });
      }
      // UPSERT per idempotenza: una sola riga per appuntamento (UNIQUE appuntamento_id)
      const r1 = await sb(`lista_attesa?on_conflict=appuntamento_id`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          appuntamento_id: appt.id,
          medico_id: appt.medico_id,
          centro_id: appt.centro_id,
          email: appt.email_paziente,
          attivo: true,
          consenso_at: new Date().toISOString(),
          consenso_versione: CONSENSO_VERSIONE
        })
      });
      if (!r1.ok) return res.status(500).json({ error: 'Errore server' });
      const created = await r1.json().catch(() => []);
      if (!Array.isArray(created) || created.length === 0) {
        return res.status(500).json({ error: 'Errore server' });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'unsubscribe') {
      if (iscrizione) {
        const r1 = await sb(`lista_attesa?appuntamento_id=eq.${encodeURIComponent(appt.id)}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify({ attivo: false })
        });
        if (!r1.ok) return res.status(500).json({ error: 'Errore server' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Azione non valida' });
  } catch (e) {
    console.error('[waitlist]', e.message);
    return res.status(500).json({ error: 'Errore server' });
  }
}
