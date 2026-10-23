import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { richiediAal2 } from '../lib/aal-guard.js';
import { profiloBedrock, regioneBedrock } from '../lib/bedrock-modelli.js';
import { richiediInServizio } from '../lib/servizio-guard.js';

const rateMap = new Map(); // ip -> { count, resetAt } — fallback in-memory
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Client Bedrock. Le credenziali AWS si risolvono dall'ambiente standard:
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
const bedrock = new AnthropicBedrock({ awsRegion: regioneBedrock() });

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
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null; // contatore non disponibile
  try {
    const res = await fetch(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ p_endpoint: endpoint, p_ip: ip, p_max_count: max, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return null; // contatore non disponibile
    return (await res.json()) === true;
  } catch { return null; }
}

// C-11 (riesame 22/10/2026, s94): limiti per richiesta anche lato server (prima solo il client)
const LIMITE_FILE = 20, LIMITE_VOCI = 300, LIMITE_TESTO = 400000, LIMITE_BASE64 = 6000000;

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
  const serviceKey  = process.env.SUPABASE_SECRET_KEY;
  const anonKey     = process.env.SUPABASE_PUBLISHABLE_KEY;
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
  const aalKo = richiediAal2(jwt, userData);
  if (aalKo) {
    return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });
  }
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,specializzazione,piano,created_at`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }
  // A2 (s64): regola unica del database al posto del solo calcolo dei 45 giorni (copre anche uscita ed eliminazione)
  const servizio = await richiediInServizio(medicoData[0].id, { supabaseUrl, serviceKey });
  if (!servizio.ok) return res.status(servizio.status).json(servizio.body);
  const spec = (medicoData[0].specializzazione || '').trim();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  // Quote AI per medico, non per rete: la chiave segue l'account (piano privacy riga 68)
  const quotaKey = `medico:${medicoData[0].id}`;

  if (!checkInMemoryRateLimit(quotaKey)) {
    return res.status(429).json({ error: "Troppe richieste. Riprova tra un'ora." });
  }
  const quota = await checkSupabaseRateLimit(quotaKey, 'analyze', RATE_LIMIT, 3600);
  if (quota === null) {
    // fail-closed: senza contatore la funzione AI non parte (piano privacy riga 68)
    return res.status(503).json({ error: 'Servizio momentaneamente non disponibile. Riprova tra poco.', code: 'QUOTA_NON_VERIFICABILE' });
  }
  if (!quota) {
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
      if (visite.length > LIMITE_VOCI || visite.reduce((t, v) => t + String(v?.clinica || '').length + String(v?.referto || '').length, 0) > LIMITE_TESTO) {
        return res.status(413).json({ error: 'Contenuto troppo lungo per una sintesi: riduci le visite incluse', code: 'TROPPO_GRANDE' });
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

REGOLA TASSATIVA: riporta esclusivamente informazioni scritte nei dati forniti, mantenendo la stessa forza delle indicazioni (per esempio «si consiglia» resta «si consiglia»). Non aggiungere diagnosi, classificazioni o stadiazioni, interpretazioni, stime di probabilità, cause, date calcolate, esami, valori, misure o terapie che non siano scritti. Se due documenti o visite sono in contrasto tra loro, riportali entrambi con la loro data e scrivi «Dati discordanti tra i documenti», senza spiegare né risolvere la discordanza. Se ritieni utile una considerazione clinica che non è scritta nei dati, mettila SOLO in una sezione finale intitolata «Considerazioni non presenti nei documenti», con frasi brevi; fuori da quella sezione non deve comparire nulla che non sia scritto nei dati.

Produci una STORIA CLINICA UNIFICATA che:
- Descrive l'evoluzione clinica in ordine cronologico
- Riporta diagnosi, terapie rilevanti e loro andamento nel tempo
- Include esami strumentali/laboratorio significativi con i risultati principali
- Segnala eventuali cambiamenti terapeutici e il motivo
- OMETTE informazioni ripetitive, amministrative, di routine o di scarso valore clinico
- Usa linguaggio medico appropriato, sezioni chiare ed elenchi puntati dove utile

VISITE:
${visiteTesto}

Rispondi SOLO con la storia clinica, senza introduzioni; l'unica parte aggiuntiva ammessa è la sezione finale «Considerazioni non presenti nei documenti».`;
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
      const testiRichiesta = Array.isArray(req.body.refertiTesto) ? req.body.refertiTesto : [];
      if (files.length > LIMITE_FILE || files.reduce((t, f) => t + f.base64.length, 0) > LIMITE_BASE64
          || testiRichiesta.length > LIMITE_VOCI || testiRichiesta.reduce((t, r) => t + String(r?.testo || '').length, 0) > LIMITE_TESTO) {
        return res.status(413).json({ error: 'Troppi referti o file troppo grandi per una sintesi', code: 'TROPPO_GRANDE' });
      }
      const n = files.length;
      // Etichetta del documento (data della visita) dal client: dato, ripulito e accorciato, mai istruzione
      const etichettaPulita = e => typeof e === 'string' ? e.replace(/[^0-9A-Za-zÀ-ÿ /\-—().,:]/g, '').slice(0, 60).trim() : '';
      const refertiValidi = Array.isArray(refertiTesto)
        ? refertiTesto.filter(r => r && typeof r.testo === 'string' && r.testo.trim())
        : [];
      const prompt = `Sei un medico specialista${spec ? ' in '+spec : ''}. Di seguito trovi ${n>1 ? n+' referti' : 'un referto'} di un paziente${eta ? ' di '+eta+' anni' : ''}, forniti come immagini/documenti${refertiValidi.length ? ', oltre ad alcuni referti redatti in formato testo' : ''}.

I dati anagrafici del paziente (nome, cognome, data di nascita) sono volutamente omessi e gestiti separatamente: NON inserirli, non creare intestazioni anagrafiche e non segnalare la loro assenza.

Ogni documento è preceduto da un'etichetta «DOCUMENTO n — visita del …». Inizia la risposta con una sezione «Documenti considerati» che elenca, una riga ciascuno, ogni DOCUMENTO e ogni REFERTO TESTO, riportando l'etichetta così come fornita, e l'esito: «usato», oppure «non usato — motivo» soltanto se il documento è illeggibile, privo di contenuto clinico o duplicato di un altro. Ogni documento fornito deve comparire nell'elenco.

Non conosci l'identità del paziente e non devi valutarla: non escludere né segnalare MAI un documento perché ti sembra riferito a un'altra persona, e non commentare nominativi, sesso o date di nascita. L'attribuzione dei documenti al paziente spetta al medico, che li ha inseriti nel fascicolo. Nella storia clinica indica alla fine di ogni sezione il documento di provenienza tra parentesi, per esempio «(DOCUMENTO 2)», così che il medico possa verificarlo sulla fonte. Dopo la sezione «Documenti considerati», prosegui con il contenuto clinico.

REGOLA TASSATIVA: riporta esclusivamente informazioni scritte nei dati forniti, mantenendo la stessa forza delle indicazioni (per esempio «si consiglia» resta «si consiglia»). Non aggiungere diagnosi, classificazioni o stadiazioni, interpretazioni, stime di probabilità, cause, date calcolate, esami, valori, misure o terapie che non siano scritti. Se due documenti o visite sono in contrasto tra loro, riportali entrambi con la loro data e scrivi «Dati discordanti tra i documenti», senza spiegare né risolvere la discordanza. Se ritieni utile una considerazione clinica che non è scritta nei dati, mettila SOLO in una sezione finale intitolata «Considerazioni non presenti nei documenti», con frasi brevi; fuori da quella sezione non deve comparire nulla che non sia scritto nei dati.

Produci una STORIA CLINICA UNIFICATA che:
- Ordina i referti in modo cronologico quando le date sono leggibili nei documenti
- Descrive l'evoluzione clinica nel tempo
- Riporta diagnosi, terapie rilevanti e il loro andamento
- Include esami strumentali e di laboratorio significativi con i risultati principali
- Segnala eventuali cambiamenti terapeutici e il motivo
- OMETTE informazioni ripetitive, amministrative o di scarso valore clinico
- Usa linguaggio medico appropriato, con sezioni chiare ed elenchi puntati dove utile

Rispondi SOLO con la sezione «Documenti considerati» seguita dalla storia clinica, in testo. NESSUN JSON, nessuna introduzione; l'unica parte aggiuntiva ammessa è la sezione finale «Considerazioni non presenti nei documenti».`;
      const contentBlocks = files.flatMap((f, i) => [
        { type: 'text', text: `DOCUMENTO ${i + 1}${etichettaPulita(f.etichetta) ? ' — ' + etichettaPulita(f.etichetta) : ''}` },
        { type: f.type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: f.type, data: f.base64 } }
      ]);
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
      model: profiloBedrock('BEDROCK_MODEL_ID'),
      max_tokens,
      messages
    });

    res.json(data);
  } catch (err) {
    console.error('analyze error:', err?.status, err?.name, String(err?.message || '').slice(0, 200)); // C-12: mai l'oggetto intero
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}