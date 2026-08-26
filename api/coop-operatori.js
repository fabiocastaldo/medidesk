// api/coop-operatori.js
// Gestione delle persone autorizzate della segreteria (art. 29 GDPR /
// art. 2-quaterdecies Codice). Solo Admin. Azioni:
//   GET                                  → registro: elenco autorizzati + log append-only
//   POST { azione:'aggiungi', email, nome }        → autorizza un operatore (riga senza user_id:
//                                                    l'utenza si aggancia al primo login OTP in coop-me)
//   POST { azione:'stato', segreteria_id, attiva } → sospende/riattiva un operatore
// Ogni variazione scrive una riga nel log coop_autorizzazioni_log (mai UPDATE, mai DELETE):
// è il registro auditabile che alimenta il registro dei trattamenti art. 30.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

  const srvHeaders = { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };
  const segRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,ruolo,cooperativa_id,cooperative(id,nome,stato,intestazione_legale)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  if (seg.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Operazione riservata all\'amministratore' });
  }
  const coopId = seg.cooperativa_id;
  const jsonHeaders = { ...srvHeaders, 'Content-Type': 'application/json' };

  async function scriviLog(segreteriaId, azione, note) {
    await fetch(`${supabaseUrl}/rest/v1/coop_autorizzazioni_log`, {
      method: 'POST',
      headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ cooperativa_id: coopId, segreteria_id: segreteriaId, azione, eseguita_da: seg.id, note: note || '' })
    }).catch(() => null);
  }

  // ── GET: registro autorizzati + log ──
  if (req.method === 'GET') {
    const [opRes, logRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/segreterie?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,nome,cognome,email,ruolo,stato,created_at,user_id&order=created_at.asc`, { headers: srvHeaders }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/coop_autorizzazioni_log?cooperativa_id=eq.${encodeURIComponent(coopId)}&select=segreteria_id,azione,eseguita_da,note,created_at&order=created_at.asc`, { headers: srvHeaders }).catch(() => null)
    ]);
    const operatori = (opRes && opRes.ok) ? (await opRes.json().catch(() => [])) : [];
    const log = (logRes && logRes.ok) ? (await logRes.json().catch(() => [])) : [];
    return res.status(200).json({
      cooperativa: { id: seg.cooperative.id, nome: seg.cooperative.nome, intestazione_legale: seg.cooperative.intestazione_legale || '' },
      autorizzati: (Array.isArray(operatori) ? operatori : []).map(o => ({
        id: o.id, nome: o.nome, cognome: o.cognome || '', email: o.email || null, ruolo: o.ruolo,
        stato: o.stato, dal: o.created_at, primo_accesso_effettuato: !!o.user_id
      })),
      log: Array.isArray(log) ? log : []
    });
  }

  // ── POST ──
  const b = req.body || {};
  const azione = b.azione;

  if (azione === 'aggiungi') {
    const email = String(b.email == null ? '' : b.email).trim().toLowerCase();
    const nome = String(b.nome == null ? '' : b.nome).replace(/\s+/g, ' ').trim().slice(0, 80);
    const cognome = String(b.cognome == null ? '' : b.cognome).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email non valida' });
    if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome dell\'operatore sono obbligatori' });
    const insRes = await fetch(`${supabaseUrl}/rest/v1/segreterie`, {
      method: 'POST',
      headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ cooperativa_id: coopId, nome, cognome, email, ruolo: 'operatore', stato: 'attiva' })
    }).catch(() => null);
    if (insRes && insRes.status === 409) {
      return res.status(409).json({ error: 'Questa email è già autorizzata' });
    }
    const op = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
    if (!op?.id) return res.status(500).json({ error: 'Autorizzazione non riuscita' });
    await scriviLog(op.id, 'autorizzata', `operatore ${nome} ${cognome} <${email}>`);
    return res.status(200).json({ ok: true, operatore: { id: op.id, nome: op.nome, cognome: op.cognome || '', email: op.email, ruolo: op.ruolo, stato: op.stato, dal: op.created_at, primo_accesso_effettuato: false } });
  }

  if (azione === 'titolare') {
    const intestazione = String(b.intestazione == null ? '' : b.intestazione).replace(/\s+/g, ' ').trim().slice(0, 240);
    const upRes = await fetch(
      `${supabaseUrl}/rest/v1/cooperative?id=eq.${encodeURIComponent(coopId)}`,
      {
        method: 'PATCH',
        headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({ intestazione_legale: intestazione })
      }
    ).catch(() => null);
    const rows = (upRes && upRes.ok) ? await upRes.json().catch(() => []) : [];
    if (!Array.isArray(rows) || !rows[0]) return res.status(500).json({ error: 'Salvataggio non riuscito' });
    return res.status(200).json({ ok: true, intestazione_legale: rows[0].intestazione_legale || '' });
  }

  if (azione === 'stato') {
    const targetId = typeof b.segreteria_id === 'string' ? b.segreteria_id : '';
    if (!UUID_RE.test(targetId)) return res.status(400).json({ error: 'Parametro segreteria_id non valido' });
    const attiva = b.attiva === true;
    // solo operatori della propria coop; l'admin non si sospende da qui
    const upRes = await fetch(
      `${supabaseUrl}/rest/v1/segreterie?id=eq.${encodeURIComponent(targetId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&ruolo=eq.operatore`,
      {
        method: 'PATCH',
        headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({ stato: attiva ? 'attiva' : 'sospesa' })
      }
    ).catch(() => null);
    if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Aggiornamento non riuscito' });
    const rows = await upRes.json().catch(() => []);
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) return res.status(404).json({ error: 'Operatore non trovato' });
    await scriviLog(r.id, attiva ? 'riattivata' : 'sospesa', `operatore ${r.nome} ${r.cognome || ''} <${r.email || ''}>`);
    return res.status(200).json({ ok: true, operatore: { id: r.id, nome: r.nome, cognome: r.cognome || '', email: r.email, ruolo: r.ruolo, stato: r.stato, dal: r.created_at, primo_accesso_effettuato: !!r.user_id } });
  }

  return res.status(400).json({ error: 'Azione non valida' });
}
