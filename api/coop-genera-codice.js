// api/coop-genera-codice.js
// Genera un codice di collegamento monouso (scadenza 7 giorni) che un medico
// riscatterà da medidesk per agganciare un proprio centro alla cooperativa.
// Autorizzazione: JWT regista → segreterie(stato=attiva) → cooperative(stato=attiva).
// Scrittura con service_role e Prefer: return=representation (read-back).

import { randomBytes } from 'node:crypto';

const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRate(key) {
  const now = Date.now();
  const e = rateMap.get(key);
  if (!e || now > e.resetAt) { rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS }); return true; }
  if (e.count >= RATE_LIMIT) return false;
  e.count++; return true;
}

// alfabeto senza caratteri ambigui (niente 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generaCodice() {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `CP-${s.slice(0, 4)}-${s.slice(4)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }
  if (!checkRate(String(userData.id))) {
    return res.status(429).json({ error: 'Troppi codici generati. Riprova più tardi.' });
  }

  const srvHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

  const segRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,ruolo,cooperativa_id,cooperative(id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!segRes || !segRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const seg = (await segRes.json().catch(() => []))?.[0];
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  if (seg.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Operazione riservata all\'amministratore' });
  }

  const codice = generaCodice();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const insRes = await fetch(`${supabaseUrl}/rest/v1/coop_codici`, {
    method: 'POST',
    headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ cooperativa_id: seg.cooperativa_id, codice, expires_at: expiresAt })
  }).catch(() => null);
  if (!insRes || !insRes.ok) {
    return res.status(500).json({ error: 'Generazione codice non riuscita' });
  }
  const inserted = (await insRes.json().catch(() => []))?.[0];
  if (!inserted?.codice) {
    return res.status(500).json({ error: 'Generazione codice non confermata' });
  }

  return res.status(200).json({ codice: inserted.codice, expires_at: inserted.expires_at });
}
