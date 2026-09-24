// api/ottimizza-comunicazione.js
// «Ottimizza con AI» per il testo delle comunicazioni proattive (modulo 'comunicazioni', s20).
// Clona il pattern di genera-referto: JWT medico, trial gate, doppio rate limit, Bedrock.
// Il testo prodotto e' IDENTICO per tutti i destinatari e viaggia in chiaro via email:
// il prompt vieta contenuti riferiti al singolo paziente e dati clinici individuali.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { richiediAal2 } from '../lib/aal-guard.js';
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
  const aalKo = richiediAal2(jwt);
  if (aalKo) {
    return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,specializzazione,piano,created_at,moduli`,
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
  if (!(medicoData[0].moduli && medicoData[0].moduli.comunicazioni === true)) {
    return res.status(403).json({ error: 'modulo_non_attivo' });
  }
  const spec = (medicoData[0].specializzazione || '').trim();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'ottimizza-comunicazione', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const b = req.body || {};
    const bozza = String(b.corpo == null ? '' : b.corpo).trim().slice(0, 4000);
    if (!bozza) {
      return res.status(400).json({ error: 'corpo_mancante' });
    }

    const system = `Sei l'assistente di redazione di un medico specialista${spec ? ' in ' + spec : ''}. Ricevi la bozza di una comunicazione proattiva che il medico inviera' via email, con testo IDENTICO, a un gruppo di suoi pazienti (promemoria di prevenzione, richiami, avvisi organizzativi). Riscrivila in italiano chiaro, cordiale e professionale, dando del tu al lettore, in TESTO SEMPLICE. REGOLE TASSATIVE: usa SOLO le informazioni presenti nella bozza, non inventare date, orari, prezzi, recapiti o indicazioni cliniche non indicati; il testo e' uguale per tutti i destinatari, quindi niente nomi di pazienti, niente dati clinici individuali e niente riferimenti a un caso specifico: se la bozza ne contiene, riformulali in termini generali; se la bozza invita a prenotare, chiamare o contattare lo studio, la segreteria o un numero di telefono, riformula SEMPRE l'invito come prenotazione online (es. 'puoi prenotare online dal pulsante qui sotto'), senza inventare link o recapiti: il pulsante di prenotazione lo aggiunge il sistema in fondo alla mail; nessun oggetto, nessun saluto con nome, nessuna firma (aggiunti dal sistema); NON usare alcun markdown o simbolo di formattazione; mantieni il testo asciutto, idealmente sotto le 150 parole, e se la bozza e' gia' buona limitati a ripulirla. Restituisci SOLO il testo della comunicazione.`;

    const apiData = await bedrock.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: `Bozza del medico:\n${bozza}` }]
    });

    res.json(apiData);
  } catch (err) {
    console.error('ottimizza-comunicazione error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}
