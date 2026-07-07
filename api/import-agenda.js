import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { trialExpired } from '../lib/trial-gate.js';

const rateMap = new Map(); // ip -> { count, resetAt } - fallback in-memory
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

const PROMPT_TEMPLATE = `Sei un estrattore di liste di appuntamenti da agende mediche italiane. Ricevi un'immagine, screenshot, PDF o testo che rappresenta la lista di appuntamenti di una giornata in un centro medico. Estrai in JSON.

CONTESTO (fornito dal sistema):
- Medico titolare dell'agenda: {{MEDICO}}. Il suo nome/cognome puo comparire come prefisso o etichetta sulle righe o in intestazioni di fascia oraria: NON e il paziente ne la prestazione.
- Catalogo prestazioni del medico: {{TIPI_VISITA}}.

Regole:
- Rispondi SOLO con un oggetto JSON valido: nessun testo prima/dopo, nessun markdown, nessun commento.
- Non inventare MAI dati. Campo non leggibile o assente -> null. Inventare un nome e un errore grave: meglio null + confidenza bassa.
- "data": data della giornata SE scritta, normalizzata a YYYY-MM-DD; altrimenti null. NON dedurla da "domani" o dal contesto.
- "centro_raw": nome del centro cosi come appare; null se assente.
- "righe": una per voce della lista, in ordine di lettura. Per ciascuna:
    - "ora": "HH:MM" se presente, altrimenti null.
    - "nome": nome del PAZIENTE come scritto; rimuovi il nome del medico; null se illeggibile o assente.
    - "tipo": SOLO la prestazione come scritta (rimuovi il nome del medico se appiccicato); null se assente.
    - "tipo_catalogo": se il tipo corrisponde chiaramente a una voce di {{TIPI_VISITA}}, riporta la voce canonica; altrimenti null.
    - "e_appuntamento": true se e l'appuntamento di un paziente; false se e intestazione, fascia di presenza del medico, pausa o annotazione.
    - "stato": "cancellato" se la riga appare barrata o marcata come disdetta/annullata; altrimenti "attivo".
    - "confidenza": 0.0-1.0 sulla riga nel complesso.
- Se due righe condividono lo stesso orario, abbassa la confidenza di entrambe: possibile disdetta non epurata o doppia prenotazione.
- Fallback: se l'artefatto indica solo un conteggio o e troppo illeggibile per estrarre righe -> "righe": [] e "n_visite_fallback": il numero (o null).
- Se compaiono piu centri o piu giornate, estrai solo il primo blocco coerente e abbassa le confidenze.

Schema:
{ "data": "YYYY-MM-DD|null", "centro_raw": "string|null", "righe": [ { "ora": "HH:MM|null", "nome": "string|null", "tipo": "string|null", "tipo_catalogo": "string|null", "e_appuntamento": true, "stato": "attivo", "confidenza": 0.0 } ], "n_visite_fallback": null }`;

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
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,titolo,nome,cognome,piano,created_at`,
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
  const md = medicoData[0];
  const medicoNome = [md.titolo, md.nome, md.cognome].map(s => (s || '').trim()).filter(Boolean).join(' ') || 'Medico';

  const tipiRes = await fetch(
    `${supabaseUrl}/rest/v1/tipi_visita?medico_id=eq.${encodeURIComponent(md.id)}&select=nome`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  const tipiData = tipiRes && tipiRes.ok ? await tipiRes.json().catch(() => []) : [];
  const tipiList = (Array.isArray(tipiData) && tipiData.length)
    ? tipiData.map(t => t.nome).filter(Boolean).join(', ')
    : '(nessuna prestazione a catalogo)';

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'import-agenda', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const { file, text } = req.body || {};
    const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

    const prompt = PROMPT_TEMPLATE
      .replace(/\{\{MEDICO\}\}/g, medicoNome)
      .replace(/\{\{TIPI_VISITA\}\}/g, tipiList);

    let contentBlocks;
    if (file && typeof file.base64 === 'string' && ALLOWED.has(file.type)) {
      contentBlocks = [
        { type: file.type === 'application/pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: file.type, data: file.base64 } },
        { type: 'text', text: prompt }
      ];
    } else if (typeof text === 'string' && text.trim()) {
      contentBlocks = [
        { type: 'text', text: prompt + '\n\nLISTA DA ESTRARRE (testo incollato):\n' + text.trim() }
      ];
    } else {
      return res.status(400).json({ error: 'Fornisci un file (immagine/PDF) o del testo da estrarre' });
    }

    const data = await bedrock.messages.create({
      model: process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    res.json(data);
  } catch (err) {
    console.error('import-agenda error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si \u00e8 verificato un errore. Riprova.' });
  }
}