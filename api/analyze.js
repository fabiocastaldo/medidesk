const rateMap = new Map(); // ip -> { count, resetAt } — fallback in-memory
const RATE_LIMIT = 10;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'analyze', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
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
        return header + '\n' + (v.clinica || '(nessuna sintesi disponibile)');
      }).join('\n\n---\n\n');
      const prompt = `Sei un medico specialista${spec ? ' in '+spec : ''}. Di seguito trovi le sintesi di ${visite.length} visite di un paziente${eta ? ' di '+eta+' anni' : ''}, in ordine cronologico.

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

    } else if (mode === 'referti') {
      const { isNew, files } = req.body;
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
      const multiLabel = n > 1 ? `questi ${n} referti` : 'questo referto';
      const multiNote  = n > 1 ? ` unificata dei ${n} documenti (usa la data più recente se ci sono più date)` : '';
      let prompt;
      if (isNew) {
        prompt = `Sei un assistente medico. Analizza ${multiLabel} e produci una sintesi clinica concisa ma completa.

ESTRAI questi dati e rispondi SOLO con JSON valido (zero testo aggiuntivo, zero markdown):
{
  "nome": "nome del paziente",
  "cognome": "cognome del paziente",
  "data_nascita": "gg/mm/aaaa o vuoto",
  "data_visita": "gg/mm/aaaa della visita",
  "luogo": "centro/ambulatorio/ospedale dove è stata fatta",
  "contenuto_clinico": "SINTESI CLINICA STRUTTURATA${multiNote}: anamnesi, esame obiettivo, diagnosi, esami eseguiti, terapie prescritte, conclusioni e follow-up. Usa elenchi puntati e sezioni chiare. Conserva tutti i dati medici rilevanti, ma NON riportare nome, cognome o data di nascita del paziente nel testo."
}`;
      } else {
        prompt = `Sei un assistente medico. Analizza ${multiLabel} e produci una sintesi clinica strutturata.

Rispondi SOLO con JSON valido (zero testo aggiuntivo, zero markdown):
{
  "data_visita": "gg/mm/aaaa della visita",
  "luogo": "centro/ambulatorio/ospedale dove è stata fatta",
  "contenuto_clinico": "SINTESI CLINICA STRUTTURATA${multiNote}: anamnesi, esame obiettivo, diagnosi, esami eseguiti, terapie prescritte, conclusioni e follow-up. Usa elenchi puntati e sezioni chiare. Conserva tutti i dati medici rilevanti, ma NON riportare nome, cognome o data di nascita del paziente nel testo."
}`;
      }
      const contentBlocks = files.map(f => ({
        type: f.type === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: f.type, data: f.base64 }
      }));
      contentBlocks.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content: contentBlocks }];

    } else {
      return res.status(400).json({ error: 'Campo mode mancante o non valido' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, messages })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Errore Anthropic' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
