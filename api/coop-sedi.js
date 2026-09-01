// api/coop-sedi.js
// Creazione di una sede dell'organizzazione dalla plancia.
// Auth: JWT regista -> segreterie(attiva) -> cooperative(attiva). Scrittura service_role.

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

  const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const nome = clean(req.body?.nome, 80);
  const via = clean(req.body?.via, 120);
  const citta = clean(req.body?.citta, 80);
  const provincia = clean(req.body?.provincia, 4).toUpperCase();
  const cap = clean(req.body?.cap, 10);
  if (!nome) {
    return res.status(400).json({ error: 'Il nome della sede è obbligatorio' });
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

  const insRes = await fetch(`${supabaseUrl}/rest/v1/coop_sedi`, {
    method: 'POST',
    headers: { ...srvHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ cooperativa_id: seg.cooperativa_id, nome, via, citta, provincia, cap })
  }).catch(() => null);
  const sede = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
  if (!sede?.id) {
    return res.status(500).json({ error: 'Creazione sede non riuscita' });
  }
  return res.status(200).json({ sede });
}
