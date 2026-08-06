// api/coop-agenda.js
// Agenda prenotabile della plancia (tappa 2 prenotazioni per-terzi).
// Restituisce, per un medico della cooperativa e un intervallo di date:
// i suoi sede-centri coop con i turni, gli slot occupati (SOLO data/ora/centro,
// nessun dato del paziente) e le chiusure del medico che toccano quei centri
// (da qui nasce la guardia ferie). Perimetro: solo centri con cooperativa_id
// della cooperativa del chiamante — i centri privati del medico non esistono.

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

  const medicoId = String(req.query.medico_id || '');
  const da = String(req.query.da || '');
  const a  = String(req.query.a  || '');
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!medicoId || !reDate.test(da) || !reDate.test(a) || a < da) {
    return res.status(400).json({ error: 'Parametri non validi' });
  }
  // guardia ampiezza: max 35 giorni
  const span = (new Date(a + 'T12:00:00') - new Date(da + 'T12:00:00')) / 86400000;
  if (span > 35) {
    return res.status(400).json({ error: 'Intervallo troppo ampio' });
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

  // sede-centri coop del medico (il perimetro È il filtro)
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&medico_id=eq.${encodeURIComponent(medicoId)}&select=id,nome,coop_sede_id,turni(id,giorno,inizio,fine,durata_slot,frequenza_settimane,data_inizio_validita,data_fine_validita)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : null;
  if (!Array.isArray(centri)) {
    return res.status(500).json({ error: 'Lettura centri non riuscita' });
  }
  if (!centri.length) {
    return res.status(404).json({ error: 'Medico non collegato all\'organizzazione' });
  }
  const ids = centri.map(c => c.id);
  const inList = ids.map(id => `"${id}"`).join(',');

  // occupati: SOLO data/ora/centro — nessun dato del paziente attraversa il confine
  const appRes = await fetch(
    `${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${inList})&data=gte.${da}&data=lte.${a}&or=(cancelled.is.null,cancelled.eq.false)&select=centro_id,data,ora`,
    { headers: srvHeaders }
  ).catch(() => null);
  const occupati = (appRes && appRes.ok) ? await appRes.json().catch(() => []) : null;
  if (!Array.isArray(occupati)) {
    return res.status(500).json({ error: 'Lettura agenda non riuscita' });
  }

  // chiusure del medico che intersecano l'intervallo
  const chRes = await fetch(
    `${supabaseUrl}/rest/v1/chiusure?medico_id=eq.${encodeURIComponent(medicoId)}&data_fine=gte.${da}&data_inizio=lte.${a}&select=data_inizio,data_fine,centri_ids`,
    { headers: srvHeaders }
  ).catch(() => null);
  const chiusure = (chRes && chRes.ok) ? await chRes.json().catch(() => []) : [];

  return res.status(200).json({
    centri: centri.map(c => ({
      id: c.id, nome: c.nome, coop_sede_id: c.coop_sede_id,
      turni: (c.turni || []).map(t => ({
        giorno: t.giorno,
        inizio: String(t.inizio || '').slice(0, 5),
        fine: String(t.fine || '').slice(0, 5),
        slot: t.durata_slot,
        frequenza: t.frequenza_settimane || 1,
        dal: t.data_inizio_validita || null,
        al: t.data_fine_validita || null
      }))
    })),
    occupati: occupati.map(o => ({ centro_id: o.centro_id, data: o.data, ora: String(o.ora || '').slice(0, 5) })),
    chiusure: (Array.isArray(chiusure) ? chiusure : []).map(ch => ({
      data_inizio: ch.data_inizio, data_fine: ch.data_fine, centri_ids: ch.centri_ids || []
    }))
  });
}
