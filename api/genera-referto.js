import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

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
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,specializzazione`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }
  const spec = (medicoData[0].specializzazione || '').trim();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'genera-referto', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const b = req.body || {};
    const bozza = clean(b.bozza, 8000);
    if (!bozza) {
      return res.status(400).json({ error: 'Campo bozza mancante o vuoto' });
    }
    const etaNum = parseInt(b.eta, 10);
    const eta = Number.isFinite(etaNum) && etaNum > 0 && etaNum < 120 ? etaNum : null;
    const tipo = clean(b.tipo, 80);
    const data = clean(b.data, 20);

    const system = `Sei l'assistente di redazione di un medico specialista${spec ? ' in ' + spec : ''}. Ricevi la bozza/appunti di un referto e la riscrivi come referto medico professionale in italiano, in TESTO SEMPLICE. REGOLE TASSATIVE: usa SOLO le informazioni presenti nella bozza, non inventare diagnosi, valori, esami o terapie non indicati; non aggiungere dati anagrafici, intestazioni, date, luoghi o firme (gestiti separatamente); mantieni la terminologia medica della bozza correggendo refusi e sintassi; NON usare alcun markdown o simbolo di formattazione: niente #, niente *, niente trattini come elenco. Organizza il testo in sezioni scrivendo il titolo della sezione in MAIUSCOLO su una riga a sé (es. MOTIVO DELLA VISITA, ANAMNESI, ESAME OBIETTIVO, DIAGNOSI, TERAPIA), seguito dal testo della sezione; separa le sezioni con una riga vuota; per gli elenchi usa righe semplici senza simboli iniziali; se la bozza è scarna limitati a ripulirla senza gonfiarla. Restituisci SOLO il testo del referto.`;

    const userContent = `Tipo di visita: ${tipo || 'non indicato'}
Età del paziente: ${eta != null ? eta + ' anni' : 'non indicata'}

Bozza del medico:
${bozza}`;

    const apiData = await bedrock.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userContent }]
    });

    res.json(apiData);
  } catch (err) {
    console.error('genera-referto error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}
