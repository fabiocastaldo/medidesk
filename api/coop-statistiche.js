// api/coop-statistiche.js
// Statistiche aggregate per la plancia organizzazione.
// Perimetro: SOLO i sede-centri della cooperativa (centri.cooperativa_id),
// che esistono esclusivamente come esito del riscatto codice — quindi solo
// medici attivati con codice, per costruzione. Le visite dei centri privati
// del medico NON entrano mai qui (asimmetria di privacy della feature coop).
// L'endpoint restituisce esclusivamente conteggi aggregati (per tipologia,
// per medico, per sede): nessuna riga appuntamento, nessun dato del paziente
// attraversa il confine. I filtri (dal/al/medico_id/sede_id) STRINGONO il
// perimetro già delimitato da cooperativa_id, mai lo allargano.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const q = req.query || {};
  const dal = typeof q.dal === 'string' && q.dal ? q.dal : null;
  const al  = typeof q.al  === 'string' && q.al  ? q.al  : null;
  const fMedico = typeof q.medico_id === 'string' && q.medico_id ? q.medico_id : null;
  const fSede   = typeof q.sede_id   === 'string' && q.sede_id   ? q.sede_id   : null;
  if (dal && !DATE_RE.test(dal)) return res.status(400).json({ error: 'Parametro dal non valido' });
  if (al  && !DATE_RE.test(al))  return res.status(400).json({ error: 'Parametro al non valido' });
  if (dal && al && dal > al)     return res.status(400).json({ error: 'Intervallo date non valido' });
  if (fMedico && !UUID_RE.test(fMedico)) return res.status(400).json({ error: 'Parametro medico_id non valido' });
  if (fSede   && !UUID_RE.test(fSede))   return res.status(400).json({ error: 'Parametro sede_id non valido' });

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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,ruolo,cooperativa_id,cooperative(id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  if (seg.ruolo !== 'admin') {
    return res.status(403).json({ error: 'Operazione riservata all\'amministratore' });
  }

  const vuoto = { totale: 0, tipologie: [], per_medico: [], per_sede: [] };

  // sede-centri della cooperativa (esistono solo dopo il riscatto codice);
  // i filtri medico/sede stringono QUESTA lista già perimetrata, in memoria.
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id,coop_sede_id,medico_id`,
    { headers: srvHeaders }
  ).catch(() => null);
  let centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : [];
  if (!Array.isArray(centri)) centri = [];
  centri = centri.filter(c =>
    (!fMedico || String(c.medico_id).toLowerCase() === fMedico.toLowerCase()) &&
    (!fSede   || String(c.coop_sede_id).toLowerCase() === fSede.toLowerCase())
  );
  if (!centri.length) {
    return res.status(200).json(vuoto);
  }
  const sedeDiCentro = new Map(centri.map(c => [String(c.id), c.coop_sede_id ? String(c.coop_sede_id) : null]));

  // visite erogate, non cancellate, sui soli centri (già filtrati) — dati minimi
  const inList = centri.map(c => `"${c.id}"`).join(',');
  const range = (dal ? `&data=gte.${dal}` : '') + (al ? `&data=lte.${al}` : '');
  const appRes = await fetch(
    `${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${inList})&erogata=is.true&or=(cancelled.is.null,cancelled.eq.false)${range}&select=tipo_visita,medico_id,centro_id`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!appRes || !appRes.ok) {
    return res.status(500).json({ error: 'Lettura statistiche non riuscita' });
  }
  const rows = await appRes.json().catch(() => []);

  const perTipo = new Map(), perMed = new Map(), perSede = new Map();
  let totale = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const k = (r.tipo_visita || '').trim() || 'Non specificata';
    perTipo.set(k, (perTipo.get(k) || 0) + 1);
    const m = r.medico_id ? String(r.medico_id) : '';
    if (m) perMed.set(m, (perMed.get(m) || 0) + 1);
    const s = sedeDiCentro.get(String(r.centro_id)) || '';
    perSede.set(s, (perSede.get(s) || 0) + 1);
    totale += 1;
  }

  // risoluzione nomi (soli id → etichette; nessun dato paziente)
  const medNomi = new Map();
  const medIds = [...perMed.keys()];
  if (medIds.length) {
    const inMed = medIds.map(id => `"${id}"`).join(',');
    const mr = await fetch(
      `${supabaseUrl}/rest/v1/medici?id=in.(${inMed})&select=id,titolo,nome,cognome`,
      { headers: srvHeaders }
    ).catch(() => null);
    const mrows = (mr && mr.ok) ? await mr.json().catch(() => []) : [];
    for (const m of (Array.isArray(mrows) ? mrows : [])) {
      medNomi.set(String(m.id), [m.titolo, m.nome, m.cognome].filter(Boolean).join(' ').trim() || 'Medico');
    }
  }
  const sedeNomi = new Map();
  const sr = await fetch(
    `${supabaseUrl}/rest/v1/coop_sedi?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id,nome`,
    { headers: srvHeaders }
  ).catch(() => null);
  const srows = (sr && sr.ok) ? await sr.json().catch(() => []) : [];
  for (const s of (Array.isArray(srows) ? srows : [])) {
    sedeNomi.set(String(s.id), s.nome || 'Sede');
  }

  const byN = (a, b) => b.n - a.n || a.nome.localeCompare(b.nome);
  const tipologie = [...perTipo.entries()]
    .map(([tipo, n]) => ({ tipo, n }))
    .sort((a, b) => b.n - a.n || a.tipo.localeCompare(b.tipo));
  const per_medico = [...perMed.entries()]
    .map(([id, n]) => ({ medico_id: id, nome: medNomi.get(id) || 'Medico', n }))
    .sort(byN);
  const per_sede = [...perSede.entries()]
    .map(([id, n]) => ({ sede_id: id || null, nome: id ? (sedeNomi.get(id) || 'Sede') : 'Sede non assegnata', n }))
    .sort(byN);

  return res.status(200).json({ totale, tipologie, per_medico, per_sede });
}
