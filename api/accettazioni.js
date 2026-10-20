// api/accettazioni.js — stato e registrazione delle accettazioni dei testi legali in vigore (s84, 20/10/2026;
// piano privacy righe 22 e 76; Termini rev 2.3 artt. 6 e 11). Con il token di sessione del medico.
//   GET  → { da_accettare: [{documento, nome, pagina, versione, hash, decorrenza, bloccante}], bloccante,
//            prossima_decorrenza, avvisi: [avvisi di servizio attivi] }
//   POST { documenti: ['tos','dpa'] } → registra in accettazioni_legali una riga per documento, con versione e
//        impronta prese da lib/testi-vigenti.js (mai dal client); il database rifiuta se il testo integrale non
//        è in testi_legali. Ricevuta per email (soft-fail) e traccia audit accettazione_testi_legali.
// 401 senza token; verifica AAL2 come gli altri endpoint del medico; 404 se l'utente non è un medico;
// limite di richieste per IP (fail-closed).
import { richiediAal2 } from '../lib/aal-guard.js';
import { TESTI_VIGENTI, statoAccettazioni, avvisiAttivi, dataIt } from '../lib/testi-vigenti.js';
import { nuovoMailer, mailerConfigurato, pseudonimoRecapito } from '../lib/mailer.js';
import { emailShell, emailTitle, detailCard, detailRow, noteBox, esc } from '../lib/email-shell.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configurazione server mancante' });
  const base = `${supabaseUrl}/rest/v1`;
  const headers = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  res.setHeader('Cache-Control', 'no-store');

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    const r = await fetch(`${base}/rpc/check_rate_limit`, { method: 'POST', headers,
      body: JSON.stringify({ p_endpoint: 'accettazioni', p_ip: `ip:${ip}`, p_max_count: 60, p_window_seconds: 3600 }) });
    if (!r.ok || (await r.json()) !== true) return res.status(429).json({ error: 'Troppe richieste' });
  } catch { return res.status(429).json({ error: 'Troppe richieste' }); }

  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!jwt) return res.status(401).json({ error: 'Non autenticato' });
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${jwt}` } }).catch(() => null);
  if (!userRes || !userRes.ok) return res.status(401).json({ error: 'Non autenticato' });
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) return res.status(401).json({ error: 'Non autenticato' });
  const aalKo = richiediAal2(jwt, userData);
  if (aalKo) return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });

  const mr = await fetch(`${base}/medici?user_id=eq.${userData.id}&select=id,email,titolo,nome,cognome,stato&limit=1`, { headers }).catch(() => null);
  const medico = mr && mr.ok ? (await mr.json().catch(() => []))[0] : null;
  if (!medico) return res.status(404).json({ error: 'Account medico non trovato' });

  const ar = await fetch(`${base}/accettazioni_legali?medico_id=eq.${medico.id}&select=documento,hash_testo,versione,accepted_at`, { headers }).catch(() => null);
  if (!ar || !ar.ok) return res.status(503).json({ error: 'Lettura delle accettazioni non disponibile, riprova tra poco.' });
  const accettazioni = await ar.json().catch(() => []);
  const stato = statoAccettazioni(accettazioni, Date.now());

  if (req.method === 'GET') {
    return res.status(200).json({ ...stato, avvisi: avvisiAttivi().map(a => ({ id: a.id, titolo: a.titolo, testo: a.testo, dal: a.dal, al: a.al })) });
  }

  // POST: solo i documenti ancora da accettare, con i dati in vigore lato server.
  const richiesti = Array.isArray(req.body?.documenti) ? req.body.documenti.map(String) : [];
  const daFare = stato.da_accettare.filter(d => richiesti.includes(d.documento));
  if (!daFare.length) return res.status(400).json({ error: 'Nessun documento da accettare tra quelli indicati.', code: 'NIENTE_DA_ACCETTARE' });
  const righe = daFare.map(d => ({ medico_id: medico.id, email: medico.email, documento: d.documento, versione: d.versione, hash_testo: d.hash }));
  const ins = await fetch(`${base}/accettazioni_legali`, { method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' }, body: JSON.stringify(righe) }).catch(() => null);
  if (!ins || !ins.ok) {
    const t = ins ? await ins.text().catch(() => '') : '';
    console.error('[accettazioni] insert', ins ? ins.status : '-', t.slice(0, 200));
    return res.status(503).json({ error: 'Registrazione dell\'accettazione non riuscita, riprova tra poco.', code: 'ACCETTAZIONE_NON_REGISTRATA' });
  }
  const accRows = await ins.json().catch(() => righe);
  await fetch(`${base}/audit_log`, { method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ medico_id: medico.id, action: 'accettazione_testi_legali', target_type: 'account', target_id: String(medico.id),
      details: { documenti: accRows.map(a => `${a.documento}:${a.versione}:${String(a.hash_testo).slice(0, 8)}`), origine: 'gestionale' } })
  }).catch(err => console.error('[accettazioni] audit:', err.message));

  // Ricevuta (soft-fail), come alla registrazione.
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (medico.email && mailerConfigurato(resendApiKey)) {
      const oraApp = accRows[0]?.accepted_at ? new Date(accRows[0].accepted_at) : new Date();
      const oraIt = oraApp.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const dettagli = accRows.map(a => detailRow(TESTI_VIGENTI[a.documento]?.nome || a.documento,
        `versione ${esc(a.versione)} — impronta SHA-256 ${esc(String(a.hash_testo).slice(0, 16))}…${TESTI_VIGENTI[a.documento]?.decorrenza ? ` — in vigore dal ${esc(dataIt(TESTI_VIGENTI[a.documento].decorrenza))}` : ''}`)).join('');
      const html = emailShell(
        emailTitle('Ricevuta delle accettazioni') +
        `<p>Gentile ${esc([medico.titolo, medico.nome, medico.cognome].filter(Boolean).join(' '))}, questa è la ricevuta di ciò che hai accettato dal gestionale Delphi~Med il ${esc(oraIt)} (ora italiana).</p>` +
        detailCard(dettagli) +
        `<p>Di ogni documento conserviamo il testo integrale della versione accettata, l'impronta crittografica, la versione e l'ora applicativa dell'accettazione. Puoi rileggerli da Impostazioni → Documenti, sezione «Versioni che hai accettato».</p>` +
        noteBox(`L'ora indicata è quella registrata dai nostri sistemi e non costituisce una marca temporale qualificata.`)
      );
      const { data: rd, error: rErr } = await nuovoMailer(resendApiKey).emails.send({ from: 'noreply@delphi-med.com', to: [medico.email], subject: 'Ricevuta delle accettazioni — Delphi~Med', html });
      if (rErr) console.error('[accettazioni] ricevuta:', rErr.message);
      else await fetch(`${base}/audit_log`, { method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ medico_id: medico.id, action: 'email_inviata', target_type: 'account', target_id: String(medico.id),
          details: { tipo: 'accettazioni_ricevuta', to: pseudonimoRecapito(medico.email), resend_id: rd?.id || null, documenti: accRows.map(a => `${a.documento}:${a.versione}:${String(a.hash_testo).slice(0, 8)}`) } })
      }).catch(err => console.error('[accettazioni] audit ricevuta:', err.message));
    }
  } catch (e) { console.error('[accettazioni] ricevuta exception:', e.message); }

  const dopo = statoAccettazioni([...accettazioni, ...righe], Date.now());
  return res.status(200).json({ ok: true, accettati: accRows.map(a => a.documento), ...dopo });
}
