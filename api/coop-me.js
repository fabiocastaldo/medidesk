// api/coop-me.js
// Identità della plancia cooperative: risolve il JWT della regista in
// (segreteria → cooperativa) e restituisce lo stato della plancia:
// medici collegati (centri.cooperativa_id) e codici di collegamento attivi.
// Tutte le letture avvengono con service_role: le tabelle coop hanno RLS
// accesa e zero policy, quindi nessuna superficie anon/authenticated.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
    `${supabaseUrl}/rest/v1/segreterie?user_id=eq.${encodeURIComponent(userData.id)}&select=id,nome,stato,cooperativa_id,cooperative(id,nome,stato,booking_pubblico,mail_conferma_paziente,mail_notifica_medico,mail_ricevuta_segreteria)`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!segRes || !segRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const segData = await segRes.json().catch(() => []);
  const seg = segData?.[0];
  if (!seg || seg.stato !== 'attiva') {
    return res.status(403).json({ error: 'Account non abilitato' });
  }
  const coop = seg.cooperative;
  if (!coop || coop.stato !== 'attiva') {
    return res.status(403).json({ error: 'Cooperativa non attiva' });
  }

  const [mediciRes, codiciRes, sediRes, serviziRes, saleRes] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(coop.id)}&select=id,nome,attivo,medico_id,coop_sede_id,turni(id,giorno,inizio,fine,durata_slot,data_inizio_validita,data_fine_validita,coop_sala_id),medici(id,titolo,nome,cognome,specializzazione)`,
      { headers: srvHeaders }
    ).catch(() => null),
    fetch(
      `${supabaseUrl}/rest/v1/coop_codici?cooperativa_id=eq.${encodeURIComponent(coop.id)}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=codice,expires_at&order=created_at.desc`,
      { headers: srvHeaders }
    ).catch(() => null),
    fetch(
      `${supabaseUrl}/rest/v1/coop_sedi?cooperativa_id=eq.${encodeURIComponent(coop.id)}&select=id,nome,via,citta,provincia,cap,attiva&order=created_at.asc`,
      { headers: srvHeaders }
    ).catch(() => null),
    fetch(
      `${supabaseUrl}/rest/v1/coop_servizi?cooperativa_id=eq.${encodeURIComponent(coop.id)}&select=id,nome,attivo,coop_servizi_medici(medico_id)&order=nome.asc`,
      { headers: srvHeaders }
    ).catch(() => null),
    fetch(
      `${supabaseUrl}/rest/v1/coop_sale?cooperativa_id=eq.${encodeURIComponent(coop.id)}&select=id,sede_id,nome,attiva&order=created_at.asc`,
      { headers: srvHeaders }
    ).catch(() => null)
  ]);

  const centriData = (mediciRes && mediciRes.ok) ? await mediciRes.json().catch(() => []) : [];
  const codiciData = (codiciRes && codiciRes.ok) ? await codiciRes.json().catch(() => []) : [];
  const sediData = (sediRes && sediRes.ok) ? await sediRes.json().catch(() => []) : [];
  const serviziData = (serviziRes && serviziRes.ok) ? await serviziRes.json().catch(() => []) : [];
  const saleData = (saleRes && saleRes.ok) ? await saleRes.json().catch(() => []) : [];

  // aggrego per medico: un medico può avere più sede-centri collegati
  const perMedico = new Map();
  for (const c of (centriData || [])) {
    const m = c.medici;
    if (!m) continue;
    const k = String(m.id);
    if (!perMedico.has(k)) {
      perMedico.set(k, {
        medico_id: k,
        titolo: m.titolo || '',
        nome: m.nome || '',
        cognome: m.cognome || '',
        specializzazione: m.specializzazione || '',
        centri: []
      });
    }
    perMedico.get(k).centri.push({ id: c.id, nome: c.nome, attivo: c.attivo !== false, coop_sede_id: c.coop_sede_id || null, turni: c.turni || [] });
  }

  return res.status(200).json({
    cooperativa: { id: coop.id, nome: coop.nome, stato: coop.stato, booking_pubblico: coop.booking_pubblico === true, mail_conferma_paziente: coop.mail_conferma_paziente !== false, mail_notifica_medico: coop.mail_notifica_medico, mail_ricevuta_segreteria: coop.mail_ricevuta_segreteria !== false },
    segreteria: { nome: seg.nome },
    medici: Array.from(perMedico.values()),
    codici_attivi: codiciData || [],
    sedi: sediData || [],
    sale: saleData || [],
    servizi: (serviziData || []).map(s => ({
      id: s.id, nome: s.nome, attivo: s.attivo !== false,
      medici: (s.coop_servizi_medici || []).map(a => String(a.medico_id))
    }))
  });
}
