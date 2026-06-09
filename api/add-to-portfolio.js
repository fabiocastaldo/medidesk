import { randomUUID } from 'node:crypto';

const rateMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkInMemoryRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) { rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++; return true;
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configurazione server mancante' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });
  if (!(await checkSupabaseRateLimit(ip, 'add-to-portfolio', RATE_LIMIT, 3600))) return res.status(429).json({ error: 'Troppe richieste. Riprova tra qualche minuto.' });

  const b = req.body || {};
  const centroToken    = clean(b.centro_token, 64);
  const portfolioToken = clean(b.portfolio_token, 64);
  const email          = clean(b.email, 160);
  if (!centroToken) return res.status(400).json({ error: 'Token centro mancante' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Email non valida' });

  const sb = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, ...(init.headers || {}) }
  });

  // 1) token centro -> medico + centro (server-side)
  let resolved;
  try {
    const r = await sb('rpc/get_centro_by_token', { method: 'POST', body: JSON.stringify({ p_token: centroToken }) });
    if (!r.ok) return res.status(502).json({ error: 'Verifica link fallita' });
    resolved = await r.json();
  } catch { return res.status(502).json({ error: 'Verifica link fallita' }); }
  if (!resolved || !resolved.medico_id || !resolved.centro?.id || !resolved.slug) {
    return res.status(401).json({ error: 'Link non valido o revocato' });
  }

  // 2) gate medico pubblico + snapshot nome/spec (stessa logica di bkRenderHero)
  let medRow;
  try {
    const r = await sb('rpc/get_medico_pubblico', { method: 'POST', body: JSON.stringify({ p_slug: resolved.slug }) });
    if (!r.ok) return res.status(502).json({ error: 'Verifica medico fallita' });
    const arr = await r.json().catch(() => []);
    medRow = Array.isArray(arr) ? arr[0] : arr;
  } catch { return res.status(502).json({ error: 'Verifica medico fallita' }); }
  if (!medRow) return res.status(401).json({ error: 'Link non valido o revocato' });

  const medicoNome = [medRow.titolo, medRow.nome, medRow.cognome].filter(Boolean).join(' ').trim() || 'Medico';
  const medicoSpec = [...new Set([medRow.specializzazione, ...(medRow.specializzazioni || [])].filter(Boolean))].join(' · ') || null;
  const c = resolved.centro;
  const centroNome = c.nome || 'Centro';
  const centroIndirizzo = [c.via, [c.cap, c.citta].filter(Boolean).join(' '), c.provincia].filter(Boolean).join(', ') || null;

  // 3) trova o crea il portafoglio
  let portfolioId = null, finalToken = portfolioToken;
  if (portfolioToken) {
    try {
      const r = await sb(`portfolios?select=id&token=eq.${encodeURIComponent(portfolioToken)}`, { method: 'GET' });
      const arr = r.ok ? await r.json().catch(() => []) : [];
      portfolioId = arr?.[0]?.id || null;
    } catch { portfolioId = null; }
  }
  if (!portfolioId) {
    finalToken = randomUUID().replace(/-/g, '');
    try {
      const r = await sb('portfolios?select=id', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ token: finalToken, email: email || null })
      });
      if (!r.ok) return res.status(500).json({ error: 'Creazione portafoglio fallita' });
      const arr = await r.json().catch(() => []);
      portfolioId = arr?.[0]?.id || null;
    } catch { return res.status(500).json({ error: 'Creazione portafoglio fallita' }); }
    if (!portfolioId) return res.status(500).json({ error: 'Creazione portafoglio fallita' });
  }

  // 4) upsert grant (re-add = rifresca snapshot+token = "ricollega")
  try {
    const r = await sb('portfolio_grants?on_conflict=portfolio_id,centro_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        portfolio_id: portfolioId,
        medico_id: resolved.medico_id,
        centro_id: c.id,
        booking_token_snapshot: centroToken,
        medico_nome_snapshot: medicoNome,
        medico_spec_snapshot: medicoSpec,
        centro_nome_snapshot: centroNome,
        centro_indirizzo_snapshot: centroIndirizzo
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[Delphi~Med] add-to-portfolio grant:', r.status, t);
      return res.status(500).json({ error: 'Aggiunta al portafoglio fallita' });
    }
  } catch (e) {
    console.error('[Delphi~Med] add-to-portfolio:', e);
    return res.status(500).json({ error: 'Aggiunta al portafoglio fallita' });
  }

  return res.status(200).json({ ok: true, portfolio_token: finalToken });
}
