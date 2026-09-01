// api/coop-giornata.js
// Roadmap plancia voce 2 (versione read-only decisa il 21/08): la "Giornata"
// dell'organizzazione. Per una data restituisce gli appuntamenti dei soli
// sede-centri coop, raggruppati per sede, con lo stato derivato dai campi
// scritti dal medico: cancelled -> 'cancellato', erogata -> 'erogata',
// altrimenti 'prenotato'. La plancia LEGGE e basta: nessuna scrittura,
// nessun check-in lato centro (l'erogazione la certifica solo il medico).
// Dati esposti: minimo necessario alla vista (nome paziente, ora, tipo,
// medico, stato) — MAI telefono, email o note. Auth e perimetro identici
// a coop-statistiche: JWT regista -> segreterie(attiva) -> cooperative(attiva),
// letture service_role sui soli centri.cooperativa_id della cooperativa.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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

  // Data richiesta: ISO YYYY-MM-DD; default = oggi in ora italiana.
  let giorno = String((req.query && req.query.data) || '').trim();
  if (!giorno) {
    giorno = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno)) {
    return res.status(400).json({ error: 'Parametro data non valido (atteso YYYY-MM-DD)' });
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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=stato,cooperativa_id,cooperative(id,stato)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const seg = (segRes && segRes.ok) ? (await segRes.json().catch(() => []))?.[0] : null;
  if (!seg || seg.stato !== 'attiva' || !seg.cooperative || seg.cooperative.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }

  // Perimetro: i soli sede-centri della cooperativa (nome incluso per il raggruppamento).
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id,nome`,
    { headers: srvHeaders }
  ).catch(() => null);
  const centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : [];
  if (!Array.isArray(centri) || !centri.length) {
    return res.status(200).json({ data: giorno, sedi: [], totali: { prenotati: 0, erogate: 0, cancellati: 0 } });
  }

  const inList = centri.map(c => `"${c.id}"`).join(',');
  const appRes = await fetch(
    `${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${inList})&data=eq.${encodeURIComponent(giorno)}` +
    `&select=id,ora,tipo_visita,nome_paziente,cognome_paziente,cancelled,erogata,centro_id,medico_id,per_conto,source,segreteria_id&order=ora.asc`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!appRes || !appRes.ok) {
    return res.status(500).json({ error: 'Lettura giornata non riuscita' });
  }
  const rows = await appRes.json().catch(() => []);
  const appts = Array.isArray(rows) ? rows : [];

  // Nomi dei medici coinvolti (solo quelli presenti in giornata).
  const medIds = [...new Set(appts.map(a => a.medico_id).filter(Boolean))];
  const medici = new Map();
  if (medIds.length) {
    const medIn = medIds.map(m => `"${m}"`).join(',');
    const medRes = await fetch(
      `${supabaseUrl}/rest/v1/medici?id=in.(${medIn})&select=id,nome,cognome`,
      { headers: srvHeaders }
    ).catch(() => null);
    const medRows = (medRes && medRes.ok) ? await medRes.json().catch(() => []) : [];
    for (const m of (Array.isArray(medRows) ? medRows : [])) {
      medici.set(m.id, [m.cognome, m.nome].filter(Boolean).join(' '));
    }
  }

  // nomi delle segreterie (per «prenotato da»)
  const segNomi = new Map();
  const sgRes = await fetch(
    `${supabaseUrl}/rest/v1/segreterie?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id,nome`,
    { headers: srvHeaders }
  ).catch(() => null);
  const sgRows = (sgRes && sgRes.ok) ? await sgRes.json().catch(() => []) : [];
  for (const x of (Array.isArray(sgRows) ? sgRows : [])) segNomi.set(String(x.id), x.nome || '');

  const perSede = new Map(centri.map(c => [c.id, { centro_id: c.id, nome: c.nome || 'Sede', appuntamenti: [] }]));
  const totali = { prenotati: 0, erogate: 0, cancellati: 0 };
  for (const a of appts) {
    const stato = a.cancelled === true ? 'cancellato' : (a.erogata === true ? 'erogata' : 'prenotato');
    if (stato === 'cancellato') totali.cancellati += 1;
    else if (stato === 'erogata') totali.erogate += 1;
    else totali.prenotati += 1;
    const sede = perSede.get(a.centro_id);
    if (!sede) continue;
    sede.appuntamenti.push({
      ora: String(a.ora || '').slice(0, 5),
      tipo: a.tipo_visita || '',
      paziente: [a.cognome_paziente, a.nome_paziente].filter(Boolean).join(' '),
      medico: medici.get(a.medico_id) || '',
      stato,
      per_conto: a.per_conto === true,
      source: a.source || '',
      prenotato_da: a.segreteria_id ? (segNomi.get(String(a.segreteria_id)) || '') : ''
    });
  }

  // Solo le sedi con almeno un appuntamento in giornata, ordinate per nome.
  const sedi = [...perSede.values()]
    .filter(s => s.appuntamenti.length)
    .sort((a, b) => a.nome.localeCompare(b.nome));

  return res.status(200).json({ data: giorno, sedi, totali });
}
