// api/coop-sale.js
// Sale (ambulatori) delle sedi, gestite dalla plancia. POST-only:
//   { azione:'crea',  sede_id, nome }        → crea la sala sulla sede
//   { azione:'stato', sala_id, attiva }      → attiva/disattiva la sala
// L'elenco viaggia dentro coop-me (chiave `sale`). Perimetro verificato
// server-side: sede e sala devono appartenere alla cooperativa della regista.
// Tutto service_role; coop_sale è a superficie anon zero (RLS on, 0 policy).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const coopId = seg.cooperativa_id;
  const jsonHeaders = { ...srvHeaders, 'Content-Type': 'application/json' };

  const b = req.body || {};
  const azione = b.azione;

  if (azione === 'crea') {
    const sedeId = typeof b.sede_id === 'string' ? b.sede_id : '';
    if (!UUID_RE.test(sedeId)) return res.status(400).json({ error: 'Parametro sede_id non valido' });
    const nome = String(b.nome == null ? '' : b.nome).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!nome) return res.status(400).json({ error: 'Il nome della sala è obbligatorio' });
    const sedeRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_sedi?id=eq.${encodeURIComponent(sedeId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}&select=id,nome`,
      { headers: srvHeaders }
    ).catch(() => null);
    const sede = (sedeRes && sedeRes.ok) ? (await sedeRes.json().catch(() => []))?.[0] : null;
    if (!sede) return res.status(404).json({ error: 'Sede non trovata' });
    const insRes = await fetch(`${supabaseUrl}/rest/v1/coop_sale`, {
      method: 'POST',
      headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ cooperativa_id: coopId, sede_id: sedeId, nome })
    }).catch(() => null);
    if (insRes && insRes.status === 409) {
      return res.status(409).json({ error: 'Su questa sede esiste già una sala con questo nome' });
    }
    const sala = (insRes && insRes.ok) ? (await insRes.json().catch(() => []))?.[0] : null;
    if (!sala?.id) return res.status(500).json({ error: 'Creazione sala non riuscita' });
    return res.status(200).json({ ok: true, sala: { id: sala.id, sede_id: sala.sede_id, nome: sala.nome, attiva: sala.attiva !== false } });
  }

  if (azione === 'stato') {
    const salaId = typeof b.sala_id === 'string' ? b.sala_id : '';
    if (!UUID_RE.test(salaId)) return res.status(400).json({ error: 'Parametro sala_id non valido' });
    const attiva = b.attiva === true;
    const upRes = await fetch(
      `${supabaseUrl}/rest/v1/coop_sale?id=eq.${encodeURIComponent(salaId)}&cooperativa_id=eq.${encodeURIComponent(coopId)}`,
      {
        method: 'PATCH',
        headers: { ...jsonHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({ attiva })
      }
    ).catch(() => null);
    if (!upRes || !upRes.ok) return res.status(500).json({ error: 'Aggiornamento sala non riuscito' });
    const rows = await upRes.json().catch(() => []);
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) return res.status(404).json({ error: 'Sala non trovata' });
    return res.status(200).json({ ok: true, sala: { id: r.id, sede_id: r.sede_id, nome: r.nome, attiva: r.attiva !== false } });
  }

  return res.status(400).json({ error: 'Azione non valida' });
}
