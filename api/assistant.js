import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { trialExpired } from '../lib/trial-gate.js';

const rateMap = new Map();
const RATE_LIMIT = 40;
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

// ── Registry tool v1: ogni tool qui dichiarato ha un esecutore client in medidesk.html (assert nel gate) ──
const TOOLS = [
  {
    name: 'vai_a',
    description: 'Porta il medico a una pagina del gestionale. Nessuna conferma necessaria.',
    input_schema: {
      type: 'object',
      properties: {
        pagina: { type: 'string', enum: ['dashboard', 'agenda', 'pazienti', 'statistiche', 'centri', 'prestazioni', 'piani', 'impostazioni', 'profilo', 'manutenzione-archivio'] }
      },
      required: ['pagina']
    }
  },
  {
    name: 'cerca_paziente',
    description: 'Cerca pazienti per nome, cognome, email o telefono tra fascicoli e prenotati. Restituisce i match con id. Usalo prima di aprire fascicoli o preparare azioni su un paziente. Se i match sono più di uno, chiedi al medico quale.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'apri_fascicolo',
    description: 'Apre il fascicolo di un paziente (serve il paziente_id da cerca_paziente). Nessuna conferma necessaria.',
    input_schema: {
      type: 'object',
      properties: { paziente_id: { type: 'string' } },
      required: ['paziente_id']
    }
  },
  {
    name: 'prepara_appuntamento',
    description: "Apre il wizard di nuovo appuntamento precompilando data e nome paziente. Il medico sceglie slot e conferma nel wizard: nessuna scrittura diretta. Chiedi SEMPRE ok in chat prima di chiamarlo.",
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cognome: { type: 'string' },
        telefono: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD, opzionale' }
      },
      required: []
    }
  },
  {
    name: 'carica_visita',
    description: "Apre il caricamento di una nuova visita, agganciato a un appuntamento (appuntamento_id) oppure a un paziente dal fascicolo (paziente_id). Il salvataggio finale lo fa il medico. Chiedi SEMPRE ok in chat prima di chiamarlo.",
    input_schema: {
      type: 'object',
      properties: {
        appuntamento_id: { type: 'string' },
        paziente_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'segna_erogata',
    description: "Segna come erogato un appuntamento (o annulla l'erogazione se già erogato). Scrive subito. Chiedi SEMPRE ok esplicito in chat prima di chiamarlo, citando paziente e orario.",
    input_schema: {
      type: 'object',
      properties: { appuntamento_id: { type: 'string' } },
      required: ['appuntamento_id']
    }
  },
  {
    name: 'leggi_statistiche',
    description: "Calcola statistiche sugli appuntamenti del medico: totali, effettuate, cancellate, erogate, ripartizione per centro e per tipo. Periodo: oggi | settimana | mese | anno | intervallo (con da/a YYYY-MM-DD). Stessa fonte dati della pagina Statistiche.",
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', enum: ['oggi', 'settimana', 'mese', 'anno', 'intervallo'] },
        da: { type: 'string' },
        a: { type: 'string' },
        centro: { type: 'string', description: 'nome del centro, opzionale' }
      },
      required: ['periodo']
    }
  }
];

const SYSTEM_STATIC = `Sei l'assistente integrato di Delphi~Med, il gestionale del medico specialista con cui stai parlando. Lo aiuti a usare il sito: navighi, spieghi come si fa, prepari azioni, rispondi su numeri e statistiche.

REGOLE TASSATIVE
1. Mai azioni con effetti senza ok esplicito in chat. Prima di chiamare prepara_appuntamento, carica_visita o segna_erogata: riassumi cosa stai per fare (paziente, data, ora) e attendi che il medico confermi nel messaggio successivo. Navigazione, ricerche e statistiche non richiedono conferma.
2. Non inventare. Se un paziente non risulta, un dato manca o una funzione non esiste, dillo. Fuori dal tuo perimetro: spiega come farlo a mano indicando la pagina giusta.
3. Rispondi breve, in italiano, come un collega pratico. Un'azione o una risposta per volta. Niente markdown: testo semplice.
4. Le domande cliniche non sono compito tuo: rimanda alle sezioni referti e fascicolo, non interpretare contenuti sanitari.
5. Se cerca_paziente restituisce piu' match, chiedi quale prima di procedere.

MAPPA DEL SITO
- Dashboard: appuntamenti di oggi con azioni rapide "Segna come erogata" e "Carica visita"; banner scadenze.
- Agenda: calendario settimanale (drag e drop per spostare, con conferma e notifica al paziente) e vista mese; "+ Nuovo appuntamento"; "Overbooking" per orari fuori griglia; "Importa giornata" in testata per caricare la lista visite da foto o PDF della segreteria.
- Pazienti: tabella unificata fascicoli + prenotati; ricerca per nome, email, telefono; filtro per centro e stato; "+ Crea fascicolo paziente". Dal fascicolo: anagrafica editabile, visite, referti con sintesi AI, storia clinica (stampa, PDF, email, copia).
- Statistiche: KPI su periodi confrontabili, filtri per periodo.
- Centri: sedi di lavoro, turni, compensi (export XLSX e PDF), chiusure.
- Prestazioni: listino prestazioni, import listino.
- Piani: abbonamento e fatturazione.
- Impostazioni e Profilo: preferenze, dati del medico, firma, tema.
- Manutenzione archivio: pulizia e gestione dati.

COME SI FA
- Prenotare: Agenda, "+ Nuovo appuntamento", wizard a passi (centro, data, slot, dati paziente). Orario fuori griglia: "Overbooking".
- Caricare una visita o referto: dalla Dashboard sull'appuntamento di oggi ("Carica visita"), oppure dal fascicolo del paziente. Il caricamento aggancia ed eroga l'appuntamento corrispondente.
- Segnare erogata: Dashboard o pagina Pazienti. Annullare l'erogazione NON cancella il fascicolo.
- Importare la giornata: Agenda, "Importa giornata", carica foto o PDF, controlla e conferma le righe estratte.
- Spostare un appuntamento: trascinalo in Agenda; il sistema chiede conferma e propone la notifica al paziente.`;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-24);
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content.slice(0, 4000) });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const b of m.content.slice(0, 12)) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          blocks.push({ type: 'text', text: b.text.slice(0, 4000) });
        } else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          blocks.push({ type: 'tool_use', id: b.id.slice(0, 80), name: b.name.slice(0, 60), input: b.input && typeof b.input === 'object' ? b.input : {} });
        } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id.slice(0, 80), content: clean(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 4000) });
        } else {
          return null;
        }
      }
      if (!blocks.length) return null;
      out.push({ role: m.role, content: blocks });
    } else {
      return null;
    }
  }
  return out.length ? out : null;
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

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkInMemoryRateLimit(ip)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  if (!(await checkSupabaseRateLimit(ip, 'assistant', RATE_LIMIT, 3600))) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }

  try {
    const b = req.body || {};
    if (JSON.stringify(b).length > 120000) {
      return res.status(400).json({ error: 'Richiesta troppo grande' });
    }
    const messages = sanitizeMessages(b.messages);
    if (!messages) {
      return res.status(400).json({ error: 'Messaggi mancanti o malformati' });
    }
    const ctx = b.context && typeof b.context === 'object' ? b.context : {};
    const contesto = clean(JSON.stringify({
      data_oggi: clean(ctx.data_oggi, 20),
      pagina_corrente: clean(ctx.pagina_corrente, 40),
      appuntamenti_oggi: Array.isArray(ctx.appuntamenti_oggi) ? ctx.appuntamenti_oggi.slice(0, 20) : [],
      pazienti_totali: Number.isFinite(ctx.pazienti_totali) ? ctx.pazienti_totali : null
    }), 6000);

    const apiData = await bedrock.messages.create({
      model: process.env.BEDROCK_ASSISTANT_MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `CONTESTO ATTUALE (JSON): ${contesto}` }
      ],
      tools: TOOLS,
      messages
    });

    res.json({ content: apiData.content, stop_reason: apiData.stop_reason });
  } catch (err) {
    console.error('assistant error:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}
