// api/coop-preferenze.js
// Preferenze dell'organizzazione. Per ora: booking_pubblico — se attivo,
// l'agenda del medico sui sede-centri è prenotabile anche dal link pubblico
// del medico, senza passare dalla segreteria. La fonte di verità è
// cooperative.booking_pubblico; il valore viene specchiato su tutti i
// centri della cooperativa (coop_booking_pubblico) così la SPA del medico
// lo legge dai dati che già carica, a RLS invariata.

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
  const b = req.body || {};
  if (b.action !== 'set_booking_pubblico' || typeof b.valore !== 'boolean') {
    return res.status(400).json({ error: 'Parametri non validi' });
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

  const upCoop = await fetch(
    `${supabaseUrl}/rest/v1/cooperative?id=eq.${encodeURIComponent(seg.cooperativa_id)}`,
    { method: 'PATCH', headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ booking_pubblico: b.valore }) }
  ).catch(() => null);
  const coopRow = (upCoop && upCoop.ok) ? (await upCoop.json().catch(() => []))?.[0] : null;
  if (!coopRow) {
    return res.status(500).json({ error: 'Aggiornamento non riuscito' });
  }
  // specchio su tutti i centri della cooperativa
  await fetch(
    `${supabaseUrl}/rest/v1/centri?cooperativa_id=eq.${encodeURIComponent(seg.cooperativa_id)}`,
    { method: 'PATCH', headers: { ...srvHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coop_booking_pubblico: b.valore }) }
  ).catch(() => null);

  return res.status(200).json({ booking_pubblico: coopRow.booking_pubblico });
}
