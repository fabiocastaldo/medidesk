import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { trialExpired } from '../lib/trial-gate.js';

const rateMap = new Map(); // ip -> { count, resetAt } — fallback in-memory
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Client Bedrock. Le credenziali AWS si risolvono dall'ambiente standard:
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
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

  // A.4: verifica JWT Supabase
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
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,specializzazione,piano,created_at`,
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
  const spec = (medicoData[0].specializzazione || '').trim();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'analyze', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Richiesta non valida' });
  }

  const reqMax = parseInt(req.body.max_tokens, 10);
  const max_tokens = Math.min(Number.isFinite(reqMax) ? reqMax : 2000, 4096);
  let messages;

  try {
    const { mode } = req.body;

    if (mode === 'storia') {
      const { eta, visite } = req.body;
      if (!Array.isArray(visite) || !visite.length) {
        return res.status(400).json({ error: 'Campo visite mancante o non valido' });
      }
      const visiteTesto = visite.map((v, i) => {
        const header = `VISITA ${i+1}${v.data ? ' — '+v.data : ''}`;
        const parti = [];
        const cl = (v.clinica || '').trim();
        const rf = (v.referto || '').trim();
        if (cl) parti.push('NOTE CLINICHE:\n' + cl);
        if (rf) parti.push('REFERTO:\n' + rf);
        if (!parti.length) parti.push('(nessun contenuto clinico disponibile)');
        return header + '\n' + parti.join('\n\n');
      }).join('\n\n---\n\n');
      const prompt = `Sei un medico specialista${spec ? ' in '+spec : ''}. Di seguito trovi i dati di ${visite.length} visite di un paziente${eta ? ' di '+eta+' anni' : ''}, in ordine cronologico. Per ciascuna visita possono essere presenti note cliniche e/o un referto redatto dal medico.

I dati anagrafici del paziente (nome, data di nascita) sono volutamente omessi e gestiti separatamente: NON inserirli, non creare intestazioni anagrafiche e non segnalare la loro assenza. Inizia direttamente dal contenuto clinico.

Produci una STORIA CLINICA UNIFICATA che:
- Descrive l'evoluzione clinica in ordine cronologico
- Riporta diagnosi, terapie rilevanti e loro andamento nel tempo
- Include esami strumentali/laboratorio significativi con i risultati principali
- Segnala eventuali cambiamenti terapeutici e il motivo
- OMETTE informazioni ripetitive, amministrative, di routine o di scarso valore clinico
- Usa linguaggio medico appropriato, sezioni chiare ed elenchi puntati dove utile

VISITE:
${visiteTesto}

Rispondi SOLO con la storia clinica, senza introduzioni o commenti finali.`;
      messages = [{ role: 'user', content: prompt }];

    } else if (mode === 'sintesi-referti') {
      const { eta, files, refertiTesto } = req.body;
      if (!Array.isArray(files) || !files.length) {
        return res.status(400).json({ error: 'Campo files mancante o non valido' });
      }
      const ALLOWED = new Set(['image/jpeg','image/png','image/gif','image/webp','application/pdf']);
      for (const f of files) {
        if (!f || typeof f.base64 !== 'string' || !ALLOWED.has(f.type)) {
          return res.status(400).json({ error: 'File non valido' });
        }
      }
      const n = files.length;
      const refertiValidi = Array.isArray(refertiTesto)
        ? refertiTesto.filter(r => r && typeof r.testo === 'string' && r.testo.trim())
        : [];
      const prompt = `Sei un medico specialista${spec ? ' in '+spec : ''}. Di seguito trovi ${n>1 ? n+' referti' : 'un referto'} di un paziente${eta ? ' di '+eta+' anni' : ''}, forniti come immagini/documenti${refertiValidi.length ? ', oltre ad alcuni referti redatti in formato testo' : ''}.

I dati anagrafici del paziente (nome, cognome, data di nascita) sono volutamente omessi e gestiti separatamente: NON inserirli, non creare intestazioni anagrafiche e non segnalare la loro assenza. Inizia direttamente dal contenuto clinico.

Produci una STORIA CLINICA UNIFICATA che:
- Ordina i referti in modo cronologico quando le date sono leggibili nei documenti
- Descrive l'evoluzione clinica nel tempo
- Riporta diagnosi, terapie rilevanti e il loro andamento
- Include esami strumentali e di laboratorio significativi con i risultati principali
- Segnala eventuali cambiamenti terapeutici e il motivo
- OMETTE informazioni ripetitive, amministrative o di scarso valore clinico
- Usa linguaggio medico appropriato, con sezioni chiare ed elenchi puntati dove utile

Rispondi SOLO con la storia clinica in testo. NESSUN JSON, nessuna introduzione, nessun commento finale.`;
      const contentBlocks = files.map(f => ({
        type: f.type === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: f.type, data: f.base64 }
      }));
      if (refertiValidi.length) {
        const bloccoTesti = refertiValidi
          .map((r, i) => `REFERTO TESTO ${i+1}${r.data ? ' — '+r.data : ''}\n${r.testo.trim()}`)
          .join('\n\n---\n\n');
        contentBlocks.push({ type: 'text', text: 'REFERTI IN FORMATO TESTO:\n\n' + bloccoTesti });
      }
      contentBlocks.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content: contentBlocks }];

    } else {
      return res.status(400).json({ error: 'Campo mode mancante o non valido' });
    }

    const data = await bedrock.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6',
      max_tokens,
      messages
    });

    res.json(data);
  } catch (err) {
    console.error('analyze error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}