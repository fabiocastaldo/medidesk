// api/coop-statistiche.js
// Statistiche aggregate per la plancia organizzazione.
// Perimetro: SOLO i sede-centri della cooperativa (centri.cooperativa_id),
// che esistono esclusivamente come esito del riscatto codice — quindi solo
// medici attivati con codice, per costruzione. Le visite dei centri privati
// del medico NON entrano mai qui (asimmetria di privacy della feature coop).
// L'endpoint restituisce esclusivamente conteggi aggregati per tipo_visita:
// nessuna riga appuntamento, nessun dato del paziente attraversa il confine.

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

  // sede-centri della cooperativa (esistono solo dopo il riscatto codice)
  const centriRes = await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}&select=id`,
    { headers: srvHeaders }
  ).catch(() => null);
  const centri = (centriRes && centriRes.ok) ? await centriRes.json().catch(() => []) : [];
  if (!Array.isArray(centri) || !centri.length) {
    return res.status(200).json({ totale: 0, tipologie: [] });
  }

  // visite erogate, non cancellate, sui soli centri coop — solo tipo_visita
  const inList = centri.map(c => `"${c.id}"`).join(',');
  const appRes = await fetch(
    `${supabaseUrl}/rest/v1/appuntamenti?centro_id=in.(${inList})&erogata=is.true&or=(cancelled.is.null,cancelled.eq.false)&select=tipo_visita`,
    { headers: srvHeaders }
  ).catch(() => null);
  if (!appRes || !appRes.ok) {
    return res.status(500).json({ error: 'Lettura statistiche non riuscita' });
  }
  const rows = await appRes.json().catch(() => []);

  const per = new Map();
  let totale = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const k = (r.tipo_visita || '').trim() || 'Non specificata';
    per.set(k, (per.get(k) || 0) + 1);
    totale += 1;
  }
  const tipologie = [...per.entries()]
    .map(([tipo, n]) => ({ tipo, n }))
    .sort((a, b) => b.n - a.n || a.tipo.localeCompare(b.tipo));

  return res.status(200).json({ totale, tipologie });
}
