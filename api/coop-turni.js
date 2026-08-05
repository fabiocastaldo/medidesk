// api/coop-turni.js
// Azioni sui turni assegnati dall'organizzazione. Per ora: elimina.
// Il turno deve appartenere a un centro agganciato alla cooperativa della regista.

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
  const action = String(b.action || '');
  const turnoId = String(b.turno_id || '');
  if (action !== 'elimina' || !/^[0-9a-fA-F-]{36}$/.test(turnoId)) {
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

  // il turno deve stare su un centro della cooperativa
  const chkRes = await fetch(
    `${supabaseUrl}/rest/v1/turni?id=eq.${encodeURIComponent(turnoId)}&select=id,centri!inner(cooperativa_id)`,
    { headers: srvHeaders }
  ).catch(() => null);
  const chk = (chkRes && chkRes.ok) ? (await chkRes.json().catch(() => []))?.[0] : null;
  if (!chk || String(chk.centri?.cooperativa_id) !== String(seg.cooperativa_id)) {
    return res.status(404).json({ error: 'Turno non trovato' });
  }

  const delRes = await fetch(
    `${supabaseUrl}/rest/v1/turni?id=eq.${encodeURIComponent(turnoId)}`,
    { method: 'DELETE', headers: { ...srvHeaders, 'Prefer': 'return=representation' } }
  ).catch(() => null);
  const removed = (delRes && delRes.ok) ? await delRes.json().catch(() => []) : [];
  if (!removed || !removed.length) {
    return res.status(500).json({ error: 'Eliminazione non riuscita' });
  }
  return res.status(200).json({ eliminato: true });
}
