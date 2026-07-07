import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { trialExpired } from '../lib/trial-gate.js';

const rateMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const bedrock = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'eu-central-1' });

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
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

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,piano,created_at`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }
  if (trialExpired(medicoData[0].piano, medicoData[0].created_at)) {
    return res.status(403).json({ error: 'Periodo di prova scaduto', code: 'TRIAL_EXPIRED' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'genera-presentazione', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const b = req.body || {};
    const note = clean(b.note, 4000);
    const titolo = clean(b.titolo, 60);
    const nome = clean(b.nome, 80);
    const cognome = clean(b.cognome, 80);
    const spec = clean(b.spec, 120);
    const specAltre = Array.isArray(b.specAltre) ? b.specAltre.map(s => clean(s, 120)).filter(Boolean).slice(0, 10) : [];
    const citta = Array.isArray(b.citta) ? b.citta.map(s => clean(s, 80)).filter(Boolean).slice(0, 15) : [];
    const lingue = Array.isArray(b.lingue) ? b.lingue.map(s => clean(s, 40)).filter(Boolean).slice(0, 12) : [];
    const espNum = parseInt(b.esperienza, 10);
    const esperienza = Number.isFinite(espNum) && espNum > 0 && espNum < 80 ? espNum : null;

    const nomeCompleto = [titolo, nome, cognome].filter(Boolean).join(' ').trim();
    const specTutte = [...new Set([spec, ...specAltre].filter(Boolean))];

    const system = `Sei l'estensore della presentazione professionale di un medico per la sua pagina pubblica. Scrivi in italiano, in PRIMA persona singolare (io). Lunghezza 150-220 parole, 1-2 paragrafi. Tono professionale, caloroso e sobrio. NON usare superlativi né enfasi pubblicitaria. NON promettere risultati, guarigioni o esiti. Usa SOLO le informazioni fornite: non inventare titoli, numeri, certificazioni, sedi, lingue o esperienze non indicate. Struttura il testo come: chi sono / di cosa mi occupo / titoli e ambiti (solo se presenti nelle note) / dove ricevo e in quali lingue. Restituisci SOLO il testo della presentazione, senza intestazioni, virgolette, elenchi puntati o commenti.`;

    const userContent = `Genera la presentazione a partire da questi dati.

Nome completo: ${nomeCompleto || 'non indicato'}
Specializzazioni: ${specTutte.join(', ') || 'non indicate'}
Città in cui ricevo: ${citta.join(', ') || 'non indicate'}
Lingue: ${lingue.join(', ') || 'non indicate'}
Anni di esperienza: ${esperienza != null ? esperienza : 'non indicati'}

Note libere (aree di expertise, prestazioni, patologie trattate, titoli, approccio):
${note || '(nessuna nota fornita)'}`;

    const data = await bedrock.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: userContent }]
    });

    res.json(data);
  } catch (err) {
    console.error('genera-presentazione error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}
